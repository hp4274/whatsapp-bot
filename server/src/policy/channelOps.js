/**
 * Enforcement for the `channels.*` platform policy (see `channels.js` beside
 * this file): number caps, allowed providers, safety defaults for new numbers,
 * the ban-risk guard and the super admin's per-number actions.
 *
 * What the channel row cannot hold (why a number was paused, its last Meta
 * quality rating, when it was last seen) lives in `channel_ops`, one row per
 * number, created here so the shared schema stays untouched.
 */

import { Channels } from '../channels.js';
import { DailyQuota } from '../campaign/safety.js';
import { DEFAULTS, QR_TRANSPORTS, TRANSPORT_CLOUD_API } from '../config.js';
import { CHANNEL_POLICY } from './channels.js';
import { PolicyStore, limitOf } from './index.js';

const FIELD = Object.fromEntries(CHANNEL_POLICY.map((f) => [f.key, f]));
const DAY_MS = 86_400_000;
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const GUARD_EVERY_MS = 60_000;

const TABLE = `CREATE TABLE IF NOT EXISTS channel_ops (
    channel_id     INTEGER PRIMARY KEY,
    paused_reason  TEXT,
    paused_by      TEXT,
    paused_at      TEXT,
    resumed_at     TEXT,
    quality_rating TEXT,
    last_seen_at   TEXT
)`;

/** Effective number cap: the stricter of the legacy tenant limit and the policy (null = none). */
export function numberCap(limits = {}, policy = {}) {
    const caps = [limits.maxChannels || null, limitOf(FIELD['channels.maxNumbers'], policy['channels.maxNumbers'] ?? 0)]
        .filter((n) => n);
    return caps.length ? Math.min(...caps) : null;
}

export const capMessage = (cap) => `Your plan allows ${cap} WhatsApp number${cap === 1 ? '' : 's'}. Ask the platform admin to raise it.`;

/**
 * Why `transport` is not allowed, or null. Both the legacy tenant limit and
 * the policy must allow it (stricter wins). The legacy messages are kept.
 */
export function providerBlocked(transport, limits = {}, policy = {}) {
    if (transport === TRANSPORT_CLOUD_API) {
        if (limits.allowCloudApi === false) return 'The Meta Cloud API is not enabled for your plan.';
        if (policy['channels.allowCloudApi'] === false) return 'Cloud API numbers are not allowed on your plan.';
    }
    if (QR_TRANSPORTS.includes(transport)) {
        if (limits.allowWhatsappWeb === false) return 'WhatsApp QR login is not enabled for your plan.';
        if (policy['channels.allowBaileys'] === false) return 'QR-login (Baileys) numbers are not allowed on your plan.';
    }
    return null;
}

/** A number past the cap (by age, oldest first) may exist but not connect. */
export function overCap(channelDb, channel, limits, policy) {
    const cap = numberCap(limits, policy);
    if (!cap) return null;
    const older = channelDb.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_channels WHERE tenant_id = ? AND id < ?')
        .get(channel.tenantId, channel.id).n;
    return older >= cap ? `${capMessage(cap)} This number is over the limit, so it cannot connect.` : null;
}

/**
 * Starting safety settings for a new number. A tenant may start stricter than
 * the policy, never looser: lower cap/retries, longer warm-up and gaps win.
 */
export function newNumberSafety(policy = {}, asked = {}) {
    const v = (key) => policy[`channels.${key}`] ?? FIELD[`channels.${key}`].default;
    const cap = v('dailyCap');
    const start = v('warmupStart');
    // Days for start*2^n to reach the cap; after that the plain cap applies.
    const days = v('warmupEnabled') && start < cap ? Math.ceil(Math.log2(cap / start)) : 0;
    const n = (key) => Number(asked[key]) || 0;
    return {
        dailyLimit: n('dailyLimit') ? Math.min(n('dailyLimit'), cap) : cap,
        warmupDays: Math.max(days, n('warmupDays')),
        warmupStart: start,
        minDelaySeconds: Math.max(v('minGapSeconds'), n('minDelaySeconds')),
        maxDelaySeconds: Math.max(v('maxGapSeconds'), n('maxDelaySeconds'), v('minGapSeconds')),
        maxRetries: asked.maxRetries == null ? v('retryLimit') : Math.min(n('maxRetries'), v('retryLimit')),
    };
}

/** Sends left today on `channel` (Infinity = uncapped), running or not. */
export function quotaLeft(tenantDb, channel, runtime, enforced = {}) {
    const quota = runtime?.state.manager.quota
        ?? new DailyQuota(tenantDb.forChannel(channel.id), { ...DEFAULTS, ...channel.settings, ...enforced });
    return quota.remaining();
}

const QUALITY_HIT = {
    low: ['RED', 'LOW'],
    medium: ['RED', 'LOW', 'YELLOW', 'MEDIUM'],
};

/**
 * @param {object} o
 * @param {import('../db.js').Database} o.db  the unscoped handle
 * @param {Map} o.runtimes  tenantId -> tenant runtime (app.js createTenantRuntime)
 */
export function createChannelOps({ db, tenancy, runtimes, policy = new PolicyStore(db), now = () => Date.now() }) {
    const raw = db.db;
    raw.exec(TABLE);
    const upsert = (channelId, fields) => {
        const keys = Object.keys(fields);
        raw.prepare(`INSERT INTO channel_ops (channel_id, ${keys.join(', ')}) VALUES (?, ${keys.map(() => '?').join(', ')})
            ON CONFLICT (channel_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(', ')}`)
            .run(Number(channelId), ...keys.map((k) => fields[k]));
    };
    const rows = () => new Map(raw.prepare('SELECT * FROM channel_ops').all().map((r) => [r.channel_id, r]));
    const findRow = (id) => raw.prepare('SELECT * FROM whatsapp_channels WHERE id = ?').get(Number(id));

    /** The live runtime state of a number, if its engine is up. */
    const stateOf = (tenantId, channelId) => runtimes.get(tenantId)?.runtimes.get(channelId)?.state ?? null;

    /** Stop a number's engine (and, with `logout`, end its WhatsApp session). */
    const close = async (tenantId, channelId, { logout = false } = {}) => {
        const state = stateOf(tenantId, channelId);
        if (logout && state?.transport?.logout) {
            try { await state.transport.logout(); } catch { /* best effort: the engine closes anyway */ }
        }
        await runtimes.get(tenantId)?.release?.(channelId);
    };

    const setStatus = (row, status) => new Channels(db.forTenant(row.tenant_id)).update(row.id, { status });

    const pause = async (row, reason, by) => {
        setStatus(row, 'disabled');
        upsert(row.id, { paused_reason: reason, paused_by: by, paused_at: stamp(now()) });
        await close(row.tenant_id, row.id);
    };

    const resume = (row) => {
        setStatus(row, 'active');
        // The guard judges only sends after this, or it would pause again at once.
        upsert(row.id, { paused_reason: null, paused_by: null, paused_at: null, resumed_at: stamp(now()) });
    };

    /**
     * Ban-risk guard: pause an active number whose last-24h failure rate or
     * Cloud API quality rating crosses its tenant's policy line. Also records
     * last-seen and quality for the health view. Runs from the app sweep, at
     * most once a minute unless `force`.
     * ponytail: one aggregate query per run; per-send evaluation if a minute is too slow.
     */
    let lastRun = 0;
    const guard = async ({ force = false } = {}) => {
        const at = now();
        if (!force && at - lastRun < GUARD_EVERY_MS) return [];
        lastRun = at;
        const since = stamp(at - DAY_MS);
        const ops = rows();
        const stats = new Map(raw.prepare(`
            SELECT m.channel_id AS id, m.tenant_id,
                SUM(m.status IN ('SENT', 'DELIVERED', 'READ', 'FAILED')) AS total,
                SUM(m.status = 'FAILED') AS failed
            FROM messages m LEFT JOIN channel_ops o ON o.channel_id = m.channel_id
            WHERE m.direction = 'outbound' AND m.channel_id IS NOT NULL
              AND m.updated_at >= ? AND (o.resumed_at IS NULL OR m.updated_at > o.resumed_at)
            GROUP BY m.channel_id, m.tenant_id`).all(since).map((r) => [`${r.tenant_id}:${r.id}`, r]));
        const policies = new Map();
        const paused = [];
        for (const row of raw.prepare("SELECT * FROM whatsapp_channels WHERE status = 'active'").all()) {
            const state = stateOf(row.tenant_id, row.id);
            const quality = state?.info?.qualityRating ?? null;
            if (state?.transport?.isConnected?.() || quality) {
                upsert(row.id, {
                    ...(state?.transport?.isConnected?.() ? { last_seen_at: stamp(at) } : {}),
                    ...(quality ? { quality_rating: quality } : {}),
                });
            }
            if (!policies.has(row.tenant_id)) policies.set(row.tenant_id, policy.resolve(row.tenant_id).values);
            const p = policies.get(row.tenant_id);
            if (!p['channels.banGuardEnabled']) continue;

            const s = stats.get(`${row.tenant_id}:${row.id}`);
            const total = Number(s?.total ?? 0);
            const pct = total ? (Number(s.failed) / total) * 100 : 0;
            const rating = quality ?? ops.get(row.id)?.quality_rating ?? null;
            let reason = null;
            if (total >= p['channels.banGuardMinSample'] && pct > p['channels.banGuardFailurePct']) {
                reason = `Auto-paused: ${Math.round(pct)}% of ${total} messages failed in 24 hours (limit ${p['channels.banGuardFailurePct']}%).`;
            } else if (row.provider === TRANSPORT_CLOUD_API && QUALITY_HIT[p['channels.banGuardQuality']]?.includes(String(rating).toUpperCase())) {
                reason = `Auto-paused: Meta quality rating is ${rating}.`;
            }
            if (!reason) continue;
            await pause(row, reason, 'ban_guard');
            tenancy.audit({ tenantId: row.tenant_id, userId: null, action: 'channel.ban_guard.pause', target: row.id, detail: reason });
            paused.push({ channelId: row.id, tenantId: row.tenant_id, reason });
        }
        return paused;
    };

    /** Super admin per-number actions; every one is audited on the owning tenant. */
    const register = (admin, audit) => {
        admin.param('channelId', (req, res, next, id) => {
            const row = findRow(id);
            if (!row) return res.status(404).json({ errors: ['WhatsApp number not found.'] });
            req.channelRow = row;
            req.tenantId = row.tenant_id;
            return next();
        });

        admin.post('/numbers/:channelId/pause', async (req, res) => {
            const reason = String(req.body?.reason ?? '').trim().slice(0, 300) || 'Paused by the platform admin.';
            await pause(req.channelRow, reason, 'admin');
            audit(req, 'channel.admin.pause', req.channelRow.id, reason);
            return res.json({ ok: true });
        });

        admin.post('/numbers/:channelId/resume', (req, res) => {
            resume(req.channelRow);
            audit(req, 'channel.admin.resume', req.channelRow.id);
            return res.json({ ok: true });
        });

        admin.post('/numbers/:channelId/disconnect', async (req, res) => {
            const row = req.channelRow;
            // Off autoConnect first, or the watchdog brings it straight back.
            new Channels(db.forTenant(row.tenant_id)).update(row.id, { settings: { autoConnect: false } });
            await close(row.tenant_id, row.id, { logout: true });
            audit(req, 'channel.admin.disconnect', row.id);
            return res.json({ ok: true });
        });

        /**
         * Move a number to another business. Message history, conversations and
         * campaigns stay with the original tenant (their rows carry its
         * tenant_id); only the number and its settings move. A QR-login number
         * must scan again: its session folder belongs to the old tenant.
         */
        admin.post('/numbers/:channelId/move', async (req, res) => {
            const row = req.channelRow;
            const target = tenancy.getTenant(Number(req.body?.tenantId));
            if (!target || target.status === 'archived') return res.status(404).json({ errors: ['Target business not found.'] });
            if (target.id === row.tenant_id) return res.status(400).json({ errors: ['The number already belongs to that business.'] });
            const targetPolicy = policy.resolve(target.id).values;
            const cap = numberCap(target.limits, targetPolicy);
            const targetChannels = new Channels(db.forTenant(target.id));
            const count = targetChannels.list().length;
            if (cap && count >= cap) {
                return res.status(409).json({ errors: [`${target.name} already has ${count} of ${cap} allowed WhatsApp numbers.`] });
            }
            const blocked = providerBlocked(row.provider, target.limits, targetPolicy);
            if (blocked) return res.status(409).json({ errors: [`${target.name}: ${blocked}`] });
            const source = new Channels(db.forTenant(row.tenant_id));
            if (source.list().length === 1) {
                return res.status(409).json({ errors: ['A business must keep at least one WhatsApp number, so its only number cannot be moved.'] });
            }

            await close(row.tenant_id, row.id);
            raw.prepare('UPDATE whatsapp_channels SET tenant_id = ?, is_default = ?, updated_at = ? WHERE id = ?')
                .run(target.id, count ? 0 : 1, stamp(now()), row.id);
            if (row.is_default) {
                const next = source.list()[0];
                if (next) source.setDefault(next.id);
            }
            audit(req, 'channel.admin.move', row.id, `tenant ${row.tenant_id} -> ${target.id}`);
            tenancy.audit({ tenantId: target.id, userId: req.user?.id ?? null, action: 'channel.admin.move_in', target: row.id, detail: `from tenant ${row.tenant_id}` });
            return res.json({ ok: true, tenantId: target.id });
        });
    };

    return { guard, register, rows };
}
