/**
 * WhatsApp channels: one registered number, independently configurable.
 *
 * A channel is the second half of the ownership key.  The tenant says whose
 * data it is; the channel says which number it goes out on and under which
 * rules.  Nothing is sent without both resolved - see `docs/ARCHITECTURE.md`.
 *
 * Provider credentials and pacing live in `settings`, which is the same object
 * shape the app has always called "config".  That is deliberate: the channel
 * did not invent a second configuration language, it just gave the existing one
 * an owner.
 *
 * Storing a channel does not validate its settings.  A number can exist before
 * its credentials do - the app has always booted with an unconfigured Cloud API
 * transport.  `PUT /config` and `POST /connection/connect` are the gates that
 * refuse an incomplete configuration, and they still do.
 */

import { DEFAULTS, TRANSPORTS, currentTransport, mergeConfig } from './config.js';
import { utcNow } from './protocol.js';
import { SECRET_SETTING_KEYS, openSettings, sealSettings } from './security/crypto.js';

/** What a channel is allowed to be used for. All on by default. */
export const CAPABILITIES = Object.freeze([
    'campaigns',
    'transactional_messages',
    'workflow_messages',
    'appointment_reminders',
    'order_updates',
    'lead_followups',
    'faq',
    'auto_replies',
    'ticketing',
    'ai',
]);

export const CHANNEL_STATUSES = Object.freeze(['active', 'disabled']);

/**
 * Credentials never leave the process in a GET, and never hit the row in
 * plaintext when `WHATSAPP_ENCRYPTION_KEY` is set: `sealSettings` on write,
 * `openSettings` on read. One key list drives redaction and encryption.
 */
const SECRET_KEYS = SECRET_SETTING_KEYS;

export class ChannelError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class Channels {
    /** @param {import('./db.js').Database} database a tenant-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
    }

    list() {
        return this.db.prepare('SELECT * FROM whatsapp_channels WHERE tenant_id = ? ORDER BY id')
            .all(this.tenantId).map(toChannel);
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM whatsapp_channels WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toChannel(row) : null;
    }

    /** The channel used when a request does not name one. */
    getDefault() {
        const row = this.db.prepare(
            `SELECT * FROM whatsapp_channels WHERE tenant_id = ?
             ORDER BY is_default DESC, id LIMIT 1`).get(this.tenantId);
        return row ? toChannel(row) : null;
    }

    /**
     * Pick a channel for an outbound message.  Explicit beats default, and a
     * channel that cannot do the job is an error rather than a silent fallback:
     * sending appointment reminders down a number set up for campaigns is the
     * kind of surprise that gets a number banned.
     */
    route({ channelId = null, capability = null, rule = 'default', remaining = null } = {}) {
        const channel = channelId == null ? this.pick(rule, capability, remaining) : this.get(channelId);
        if (!channel) throw new ChannelError('channel not found', 404);
        if (channel.status !== 'active') throw new ChannelError(`channel ${channel.id} is disabled`, 409);
        if (capability && !channel.capabilities.includes(capability)) {
            throw new ChannelError(`channel ${channel.id} is not enabled for ${capability}`, 409);
        }
        return channel;
    }

    /**
     * The sender rule (`channels.routing` policy) for a send that names no
     * number: the fixed default, round-robin over active numbers, or the one
     * with most of today's quota left (`remaining(channel)`, ties to the default).
     */
    pick(rule, capability, remaining) {
        if (rule !== 'round_robin' && rule !== 'quota') return this.getDefault();
        const pool = this.list().filter((c) => c.status === 'active' && (!capability || c.capabilities.includes(capability)));
        if (pool.length < 2) return pool[0] ?? this.getDefault();
        if (rule === 'round_robin') {
            this.turn = ((this.turn ?? -1) + 1) % pool.length; // ponytail: per process, resets on restart
            return pool[this.turn];
        }
        pool.sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
        return pool.reduce((best, c) => (remaining(c) > remaining(best) ? c : best));
    }

    create({ displayName, phoneNumber = '', settings = {}, capabilities, timezone = 'UTC', businessHours = null, isDefault = false, safety = {} }) {
        const name = String(displayName ?? '').trim();
        if (!name) throw new ChannelError('display name is required');
        // `safety`: the platform's starting values for a new number (policy/channelOps.js newNumberSafety).
        const merged = { ...mergeConfig(DEFAULTS, settings), ...safety };

        const first = this.list().length === 0;
        const now = utcNow();
        const info = this.db.prepare(
            `INSERT INTO whatsapp_channels
             (tenant_id, provider, phone_number, provider_account_id, provider_phone_number_id,
              status, display_name, settings, capabilities, timezone, business_hours,
              is_default, created_at, updated_at)
             VALUES (?, ?, ?, '', ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                this.tenantId, merged.transport, String(phoneNumber).trim(), merged.phoneNumberId,
                name, JSON.stringify(sealSettings(merged)), JSON.stringify(cleanCapabilities(capabilities)),
                String(timezone), businessHours ? JSON.stringify(businessHours) : null,
                first || isDefault ? 1 : 0, now, now,
            );
        const created = this.get(Number(info.lastInsertRowid));
        if (isDefault && !first) this.setDefault(created.id);
        return this.get(created.id);
    }

    /** Patch a channel. `settings` merges; everything else replaces. */
    update(id, patch = {}) {
        const channel = this.get(id);
        if (!channel) throw new ChannelError('channel not found', 404);

        const settings = patch.settings === undefined
            ? channel.settings
            : mergeConfig(channel.settings, patch.settings);
        if (patch.status !== undefined && !CHANNEL_STATUSES.includes(patch.status)) {
            throw new ChannelError(`status must be one of ${CHANNEL_STATUSES.join(', ')}`);
        }

        this.db.prepare(
            `UPDATE whatsapp_channels SET
               provider = ?, phone_number = ?, provider_phone_number_id = ?, provider_account_id = ?,
               status = ?, display_name = ?, settings = ?, capabilities = ?,
               timezone = ?, business_hours = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(
                settings.transport,
                patch.phoneNumber === undefined ? channel.phoneNumber : String(patch.phoneNumber).trim(),
                settings.phoneNumberId,
                patch.providerAccountId === undefined ? channel.providerAccountId : String(patch.providerAccountId),
                patch.status ?? channel.status,
                patch.displayName === undefined ? channel.displayName : String(patch.displayName).trim(),
                JSON.stringify(sealSettings(settings)),
                JSON.stringify(patch.capabilities === undefined ? channel.capabilities : cleanCapabilities(patch.capabilities)),
                patch.timezone === undefined ? channel.timezone : String(patch.timezone),
                patch.businessHours === undefined
                    ? (channel.businessHours ? JSON.stringify(channel.businessHours) : null)
                    : (patch.businessHours ? JSON.stringify(patch.businessHours) : null),
                utcNow(), channel.id, this.tenantId,
            );
        if (patch.isDefault) this.setDefault(channel.id);
        return this.get(channel.id);
    }

    setDefault(id) {
        const channel = this.get(id);
        if (!channel) throw new ChannelError('channel not found', 404);
        this.db.prepare('UPDATE whatsapp_channels SET is_default = 0 WHERE tenant_id = ?').run(this.tenantId);
        this.db.prepare('UPDATE whatsapp_channels SET is_default = 1, updated_at = ? WHERE id = ? AND tenant_id = ?')
            .run(utcNow(), channel.id, this.tenantId);
        return this.get(channel.id);
    }

    remove(id) {
        const channel = this.get(id);
        if (!channel) throw new ChannelError('channel not found', 404);
        if (this.list().length === 1) throw new ChannelError('a tenant must keep at least one channel', 409);
        this.db.prepare('DELETE FROM whatsapp_channels WHERE id = ? AND tenant_id = ?').run(channel.id, this.tenantId);
        // Deleting the default would leave the tenant without one.
        if (channel.isDefault) {
            const next = this.db.prepare('SELECT id FROM whatsapp_channels WHERE tenant_id = ? ORDER BY id LIMIT 1')
                .get(this.tenantId);
            if (next) this.setDefault(next.id);
        }
        return channel;
    }

    /** First run for a tenant: turn its config file into channel #1. */
    seed(config, displayName = 'Primary number') {
        if (this.list().length) return this.getDefault();
        return this.create({ displayName, settings: config, isDefault: true });
    }
}

/** Is `at` inside the channel's sending window, in the channel's timezone? */
export function withinSendingWindow(channel, at = new Date()) {
    const hours = channel.businessHours;
    if (!hours) return true;
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: channel.timezone || 'UTC', hour12: false,
        weekday: 'short', hour: '2-digit', minute: '2-digit',
    }).formatToParts(at);
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    const day = get('weekday').toLowerCase().slice(0, 3);
    if (Array.isArray(hours.days) && hours.days.length && !hours.days.map(short).includes(day)) return false;
    const minutes = Number(get('hour')) * 60 + Number(get('minute'));
    return minutes >= toMinutes(hours.start ?? '00:00') && minutes < toMinutes(hours.end ?? '24:00');
}

const short = (day) => String(day).toLowerCase().slice(0, 3);
const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm).split(':');
    return Number(h) * 60 + Number(m || 0);
};

const cleanCapabilities = (list) => (Array.isArray(list)
    ? CAPABILITIES.filter((c) => list.includes(c))
    : [...CAPABILITIES]);

/** Redacted for anything that leaves the process. */
export function publicChannel(channel) {
    const settings = { ...channel.settings };
    for (const key of SECRET_KEYS) if (settings[key]) settings[key] = '********';
    return { ...channel, settings };
}

function toChannel(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        provider: currentTransport(row.provider),
        phoneNumber: row.phone_number,
        providerAccountId: row.provider_account_id ?? '',
        providerPhoneNumberId: row.provider_phone_number_id ?? '',
        status: row.status,
        displayName: row.display_name,
        settings: retire(openSettings(parse(row.settings, DEFAULTS))),
        capabilities: parse(row.capabilities, [...CAPABILITIES]),
        timezone: row.timezone || 'UTC',
        businessHours: parse(row.business_hours, null),
        isDefault: Boolean(row.is_default),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function retire(settings) {
    return { ...settings, transport: currentTransport(settings.transport) };
}

function parse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

export { TRANSPORTS };
