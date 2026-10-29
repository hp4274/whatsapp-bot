/**
 * SQLite persistence, on node:sqlite - built into Node, so there is no native
 * module to compile and no ORM to learn.  Same schema as the Python app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DB_PATH, QR_TRANSPORTS } from './config.js';
// Feature modules own their own tables. Each exports a plain SQL string that is
// applied after the core schema, so a new feature never means editing the giant
// template literal below - and two features can be built without colliding.
import { MODULE_SCHEMAS } from './schema.js';
import { migrateTemplates } from './templates/schema.js';
import { migrateAutoReplies } from './autoreply/schema.js';
import { migratePlans } from './billing/schema.js';
import { AutoReplyStore } from './autoreply/store.js';
import { HELD_TYPES } from './campaign/humanize.js';
import { STATUS_RANK, SUCCESS_STATUSES, Status, utcNow } from './protocol.js';

const DEFAULT_TENANT_SERVICES_JSON = JSON.stringify([
    'school_whatsapp_bot',
    'whatsapp_channels',
    'contacts',
    'templates',
    'inbox',
    'auto_replies',
    'bulk_messages',
    'campaigns',
    'payment_reminders',
    'workflows',
    'faq',
    'tickets',
    'appointments',
    'orders',
    'leads',
    'subscriptions',
    'events',
    'api',
    'analytics',
    'integrations',
    'ai',
]);
const DEFAULT_TENANT_CONTROLS_JSON = JSON.stringify({
    sendingEnabled: true,
    campaignsEnabled: true,
    automationsEnabled: true,
});

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tenants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    status      TEXT NOT NULL DEFAULT 'active',
    services    TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_SERVICES_JSON}',
    controls    TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_CONTROLS_JSON}',
    safety      TEXT NOT NULL DEFAULT '{}',
    limits      TEXT NOT NULL DEFAULT '{}',
    custom_safety TEXT NOT NULL DEFAULT '{}',
    safety_exit TEXT,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id      INTEGER REFERENCES tenants(id),
    email          TEXT NOT NULL UNIQUE,
    name           TEXT NOT NULL DEFAULT '',
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL,
    disabled       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER,
    user_id     INTEGER,
    action      TEXT NOT NULL,
    target      TEXT DEFAULT '',
    detail      TEXT DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant ON audit_logs(tenant_id, id);
-- A tenant accepting the risk of its own sending limits. Evidence, so the
-- database itself refuses to edit or delete a row.
CREATE TABLE IF NOT EXISTS safety_consents (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL REFERENCES tenants(id),
    user_id       INTEGER NOT NULL,
    user_email    TEXT NOT NULL,
    full_name     TEXT NOT NULL DEFAULT '',
    accepted_at   TEXT NOT NULL,
    ip            TEXT NOT NULL DEFAULT '',
    user_agent    TEXT NOT NULL DEFAULT '',
    text_version  TEXT NOT NULL,
    text_hash     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_safety_consents_tenant ON safety_consents(tenant_id, id);
CREATE TRIGGER IF NOT EXISTS safety_consents_no_update BEFORE UPDATE ON safety_consents
BEGIN SELECT RAISE(ABORT, 'consent records are immutable'); END;
CREATE TRIGGER IF NOT EXISTS safety_consents_no_delete BEFORE DELETE ON safety_consents
BEGIN SELECT RAISE(ABORT, 'consent records are immutable'); END;

CREATE TABLE IF NOT EXISTS whatsapp_channels (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id                INTEGER NOT NULL REFERENCES tenants(id),
    provider                 TEXT NOT NULL,
    phone_number             TEXT NOT NULL DEFAULT '',
    provider_account_id      TEXT NOT NULL DEFAULT '',
    provider_phone_number_id TEXT NOT NULL DEFAULT '',
    status                   TEXT NOT NULL DEFAULT 'active',
    display_name             TEXT NOT NULL,
    settings                 TEXT NOT NULL DEFAULT '{}',
    capabilities             TEXT NOT NULL DEFAULT '[]',
    timezone                 TEXT NOT NULL DEFAULT 'UTC',
    business_hours           TEXT,
    is_default               INTEGER NOT NULL DEFAULT 0,
    -- When the number now on this channel took over (NULL = the only one it has had).
    -- Sending levels and the inbox start counting here; history before it was another number's.
    number_since             TEXT,
    created_at               TEXT NOT NULL,
    updated_at               TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channels_tenant ON whatsapp_channels(tenant_id, is_default DESC, id);

CREATE TABLE IF NOT EXISTS messages (
    tenant_id    INTEGER NOT NULL DEFAULT 1,
    channel_id   INTEGER,
    message_id   TEXT PRIMARY KEY,
    message_type TEXT NOT NULL DEFAULT 'campaign',
    direction    TEXT NOT NULL DEFAULT 'outbound',
    idempotency_key TEXT,
    recipient    TEXT NOT NULL,
    message      TEXT NOT NULL,
    status       TEXT NOT NULL,
    attempt      INTEGER NOT NULL DEFAULT 0,
    provider_id  TEXT,
    error        TEXT,
    name         TEXT DEFAULT '',
    campaign_id  TEXT DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL,
    sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient   ON messages(recipient);
CREATE INDEX IF NOT EXISTS idx_messages_status      ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at  ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_provider_id ON messages(provider_id);
CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant      ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel     ON messages(channel_id);
-- The sending ledger (sendingLedger, isCold): one number's sends by time and by recipient.
CREATE INDEX IF NOT EXISTS idx_messages_channel_sent ON messages(tenant_id, channel_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_channel_recipient ON messages(tenant_id, channel_id, recipient);
-- One accepted job per key per tenant: the retry-safety guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_idempotency
    ON messages(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS inbound_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL DEFAULT 1,
    channel_id    INTEGER,
    message_id    TEXT,
    sender        TEXT NOT NULL,
    sender_name   TEXT DEFAULT '',
    body          TEXT NOT NULL,
    media_url     TEXT,
    media_type    TEXT,
    replied_rule  TEXT DEFAULT NULL,
    is_read       INTEGER DEFAULT 0,
    received_at   TEXT NOT NULL,
    UNIQUE (tenant_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_sender ON inbound_messages(sender);
CREATE INDEX IF NOT EXISTS idx_inbound_received_at ON inbound_messages(received_at);
CREATE INDEX IF NOT EXISTS idx_inbound_channel_sender ON inbound_messages(tenant_id, channel_id, sender);

-- Suspected blocks and reports of a sending number: who, when, what.
CREATE TABLE IF NOT EXISTS safety_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL DEFAULT 1,
    channel_id  INTEGER,
    kind        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    message_id  TEXT NOT NULL DEFAULT '',
    campaign_id TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    at          TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_safety_events_once
    ON safety_events(tenant_id, kind, phone, message_id);
CREATE INDEX IF NOT EXISTS idx_safety_events_at ON safety_events(tenant_id, at);

-- What a QR number sent, as encoded proto.Message bytes, so a recipient device that asks for a retry
-- later (offline phone, WhatsApp Web opened next day) can still decrypt it. Kept 14 days.
CREATE TABLE IF NOT EXISTS sent_protos (
    tenant_id   INTEGER NOT NULL DEFAULT 1,
    channel_id  INTEGER,
    id          TEXT NOT NULL,
    proto       BLOB NOT NULL,
    at          TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_sent_protos_at ON sent_protos(at);

CREATE TABLE IF NOT EXISTS opt_outs (
    tenant_id     INTEGER NOT NULL DEFAULT 1,
    phone         TEXT NOT NULL,
    reason        TEXT DEFAULT 'user_requested',
    opted_out_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, phone)
);

CREATE TABLE IF NOT EXISTS auto_replies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id     INTEGER NOT NULL DEFAULT 1,
    keyword       TEXT NOT NULL,
    match_type    TEXT NOT NULL,
    reply_body    TEXT NOT NULL,
    is_active     INTEGER DEFAULT 1,
    cooldown_sec  INTEGER DEFAULT 300,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_replies_tenant ON auto_replies(tenant_id);

CREATE TABLE IF NOT EXISTS contacts (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id      INTEGER NOT NULL,
    phone          TEXT NOT NULL,
    name           TEXT NOT NULL DEFAULT '',
    email          TEXT NOT NULL DEFAULT '',
    status         TEXT NOT NULL DEFAULT 'active',
    opt_in_status  TEXT NOT NULL DEFAULT 'unknown',
    custom_fields  TEXT NOT NULL DEFAULT '{}',
    tags           TEXT NOT NULL DEFAULT '[]',
    source         TEXT NOT NULL DEFAULT 'manual',
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    -- The number is the identity: duplicate detection is the constraint, not a
    -- nightly job.
    UNIQUE (tenant_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id, id);
CREATE INDEX IF NOT EXISTS idx_contacts_name   ON contacts(tenant_id, name);

CREATE TABLE IF NOT EXISTS segments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id   INTEGER NOT NULL,
    name        TEXT NOT NULL,
    -- A stored filter, not a stored list: re-evaluated on every use, so a
    -- segment cannot go stale.
    filter      TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_segments_tenant ON segments(tenant_id, id);

-- The super admin's saved read of a business's WhatsApp numbers: one row per business, replaced on the next save.
CREATE TABLE IF NOT EXISTS number_collections (
    tenant_id   INTEGER PRIMARY KEY,
    account     TEXT NOT NULL DEFAULT '',
    numbers     TEXT NOT NULL DEFAULT '[]',
    created_at  TEXT NOT NULL
);
`;

const DEFAULT_TENANT_ID = 1;

function columnsOf(db, table) {
    return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function addTenantControlColumns(db) {
    const cols = columnsOf(db, 'tenants');
    if (!cols.length) return;
    if (!cols.includes('services')) {
        db.exec(`ALTER TABLE tenants ADD COLUMN services TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_SERVICES_JSON}'`);
    }
    if (!cols.includes('controls')) {
        db.exec(`ALTER TABLE tenants ADD COLUMN controls TEXT NOT NULL DEFAULT '${DEFAULT_TENANT_CONTROLS_JSON}'`);
    }
    if (!cols.includes('safety')) db.exec("ALTER TABLE tenants ADD COLUMN safety TEXT NOT NULL DEFAULT '{}'");
    if (!cols.includes('limits')) db.exec("ALTER TABLE tenants ADD COLUMN limits TEXT NOT NULL DEFAULT '{}'");
    if (!cols.includes('custom_safety')) db.exec("ALTER TABLE tenants ADD COLUMN custom_safety TEXT NOT NULL DEFAULT '{}'");
    if (!cols.includes('safety_exit')) db.exec('ALTER TABLE tenants ADD COLUMN safety_exit TEXT');
    // Session idle timeout (see Tenancy.resolveSession).
    if (!columnsOf(db, 'sessions').includes('last_seen_at')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
    if (!columnsOf(db, 'whatsapp_channels').includes('number_since')) db.exec('ALTER TABLE whatsapp_channels ADD COLUMN number_since TEXT');
    // What a consent is to (tenancy.js CONSENT_KINDS) and, for a number's skipped questions, which number.
    const consentCols = columnsOf(db, 'safety_consents');
    if (consentCols.length && !consentCols.includes('kind')) db.exec("ALTER TABLE safety_consents ADD COLUMN kind TEXT NOT NULL DEFAULT 'custom_safety'");
    if (consentCols.length && !consentCols.includes('channel_id')) db.exec('ALTER TABLE safety_consents ADD COLUMN channel_id INTEGER');
    // A/B campaigns: which version ('A', 'B', 'C') a row carried; NULL for everything else.
    if (!columnsOf(db, 'messages').includes('variant')) db.exec('ALTER TABLE messages ADD COLUMN variant TEXT');
    // WhatsApp messages one row went out as (a carousel is its text plus a captioned image per card); NULL = 1.
    if (!columnsOf(db, 'messages').includes('parts')) db.exec('ALTER TABLE messages ADD COLUMN parts INTEGER');
    // Set once a campaign message was judged for a block at 48h (stuckSent), so it is never judged again.
    if (!columnsOf(db, 'messages').includes('block_checked')) db.exec('ALTER TABLE messages ADD COLUMN block_checked INTEGER');
}

/** Adds channel_id to tables that predate channels. Existing rows keep NULL
 *  until the tenant's default channel adopts them (see adoptOrphanRows). */
function addChannelColumns(db) {
    for (const table of ['messages', 'inbound_messages']) {
        const cols = columnsOf(db, table);
        if (cols.length && !cols.includes('channel_id')) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN channel_id INTEGER`);
        }
    }
    // Message-job columns (Phase 3). Older rows read as outbound campaigns,
    // which is what they were.
    const cols = columnsOf(db, 'messages');
    if (cols.length) {
        if (!cols.includes('message_type')) {
            db.exec("ALTER TABLE messages ADD COLUMN message_type TEXT NOT NULL DEFAULT 'campaign'");
        }
        if (!cols.includes('direction')) {
            db.exec("ALTER TABLE messages ADD COLUMN direction TEXT NOT NULL DEFAULT 'outbound'");
        }
        if (!cols.includes('idempotency_key')) {
            db.exec('ALTER TABLE messages ADD COLUMN idempotency_key TEXT');
        }
        // When the message actually left. `created_at` is when a campaign queued it, which can be
        // days earlier; the daily budget counts the send, not the queueing.
        if (!cols.includes('sent_at')) {
            db.exec('ALTER TABLE messages ADD COLUMN sent_at TEXT');
            // Old rows: updated_at is the send for SENT/DELIVERED (receipts follow within minutes);
            // a READ row's updated_at is the read, possibly a day later, so it keeps its queue time.
            db.exec(`UPDATE messages SET sent_at = CASE WHEN status = 'READ' THEN created_at ELSE updated_at END
                     WHERE status IN ('SENT', 'DELIVERED', 'READ')`);
        }
    }
}

/**
 * The Meta Cloud API is gone: delete its numbers. Nothing declares a foreign key
 * to whatsapp_channels and its ids are AUTOINCREMENT (never reused), so a
 * leftover id points nowhere. Nothing of theirs may go out on a QR number the
 * tenant never chose for it: their unsent messages are cancelled, their open
 * campaigns (and any on a Meta template) cancelled, repeats stopped, and pinned
 * workflows paused. Then a nullable channel_id is cleared - NULL means "any
 * number" - and a NOT NULL one (0 = none, in a unique key) is left as it is. A
 * tenant whose default number went gets its oldest remaining one (active first) as default; one
 * with none left is seeded afresh from config on boot (Channels.seed). Idempotent.
 */
function dropCloudChannels(db) {
    const gone = db.prepare("SELECT id, tenant_id FROM whatsapp_channels WHERE provider = 'cloud_api'").all();
    if (!gone.length) return;
    const ids = gone.map((r) => r.id);
    const list = ids.map(() => '?').join(', ');
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('whatsapp_channels', 'sqlite_sequence')").all();
    const now = utcNow();
    const why = 'The Meta Cloud API was removed.';
    const opts = "CASE WHEN json_valid(options) THEN options ELSE '{}' END";
    const theirs = `(channel_id IN (${list}) OR (json_valid(options) AND json_extract(options, '$.templateMode') = 'meta'))`;
    db.exec('BEGIN');
    try {
        const stopped = db.prepare(`SELECT id FROM campaigns WHERE status IN ('scheduled', 'running', 'paused') AND ${theirs}`)
            .all(...ids).map((r) => `camp-${r.id}`);
        db.prepare(`UPDATE messages SET status = 'CANCELLED', error = ?, updated_at = ? WHERE status IN ('QUEUED', 'SENDING')
            AND (channel_id IN (${list}) OR campaign_id IN (SELECT value FROM json_each(?)))`).run(why, now, ...ids, JSON.stringify(stopped));
        db.prepare(`UPDATE campaigns SET status = 'cancelled', finished_at = ?, updated_at = ?, options = json_set(${opts}, '$.statusReason', ?)
            WHERE status IN ('scheduled', 'running', 'paused') AND ${theirs}`).run(now, now, why, ...ids);
        db.prepare(`UPDATE campaigns SET options = json_set(options, '$.recurrenceNote', ?) WHERE ${theirs} AND json_valid(options)
            AND json_extract(options, '$.recurrence.every') IS NOT NULL AND json_extract(options, '$.recurrenceNote') IS NULL`).run(why, ...ids);
        db.prepare(`UPDATE workflows SET status = 'paused', updated_at = ? WHERE status = 'active' AND channel_id IN (${list})`).run(now, ...ids);
        for (const { name } of tables) {
            const col = db.prepare(`PRAGMA table_info(${name})`).all().find((c) => c.name === 'channel_id');
            if (!col) continue;
            if (name === 'channel_ops') db.prepare(`DELETE FROM channel_ops WHERE channel_id IN (${list})`).run(...ids);
            else if (!col.notnull) db.prepare(`UPDATE ${name} SET channel_id = NULL WHERE channel_id IN (${list})`).run(...ids);
        }
        db.prepare(`DELETE FROM whatsapp_channels WHERE id IN (${list})`).run(...ids);
        for (const tenantId of new Set(gone.map((r) => r.tenant_id))) {
            db.prepare(`UPDATE whatsapp_channels SET is_default = 1 WHERE id = (SELECT id FROM whatsapp_channels WHERE tenant_id = ? ORDER BY status = 'disabled', id LIMIT 1)
                AND NOT EXISTS (SELECT 1 FROM whatsapp_channels WHERE tenant_id = ? AND is_default = 1)`).run(tenantId, tenantId);
        }
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

/** Run `fn` once per database, by name, so a later state that looks the same is left alone. */
function once(db, name, fn) {
    db.exec('CREATE TABLE IF NOT EXISTS migrations_done (name TEXT PRIMARY KEY, ran_at TEXT NOT NULL)');
    if (db.prepare('SELECT 1 FROM migrations_done WHERE name = ?').get(name)) return;
    db.exec('BEGIN');
    try {
        fn();
        db.prepare('INSERT INTO migrations_done (name, ran_at) VALUES (?, ?)').run(name, utcNow());
        db.exec('COMMIT');
    } catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}

/**
 * QR numbers linked before the plan's per-number day was read live (channels.dailyCap) kept a copy of it, or
 * the 250 default, as their own dailyLimit, which held a Business or Enterprise number at 250. A stored 250
 * there is that copy, not a choice: it becomes 0 (no limit of its own, so the plan's day applies). Once, so a
 * 250 set afterwards stays.
 */
function releaseQrDailyLimits(db) {
    const qr = [...new Set([...QR_TRANSPORTS, 'whatsapp_web'])];
    db.prepare(`UPDATE whatsapp_channels SET settings = json_set(settings, '$.dailyLimit', 0)
        WHERE provider IN (${qr.map(() => '?').join(', ')}) AND json_valid(settings)
          AND json_extract(settings, '$.dailyLimit') = 250`).run(...qr);
}

/** SQL for when the channel bound to the next `?` got its current number ('' = always). */
export const NUMBER_SINCE = "COALESCE((SELECT number_since FROM whatsapp_channels WHERE id = ?), '')";

/** NUMBER_SINCE for a handle's own channel, read once ('' = always, or no channel). */
function numberSince(handle) {
    if (handle.channelId == null) return '';
    return handle.db.prepare(`SELECT ${NUMBER_SINCE} AS since`).get(handle.channelId).since;
}

/** Tables that predate tenancy. Their rows all become tenant 1. */
function legacyTables(db) {
    const old = [];
    for (const table of ['messages', 'auto_replies', 'inbound_messages', 'opt_outs']) {
        const cols = columnsOf(db, table);
        if (cols.length && !cols.includes('tenant_id')) old.push(table);
    }
    return old;
}

/** Runs before SCHEMA. inbound/opt_outs change keys, so they are rebuilt. */
function prepareLegacy(db, old) {
    for (const table of ['messages', 'auto_replies']) {
        if (old.includes(table)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id INTEGER NOT NULL DEFAULT 1`);
        }
    }
    if (old.includes('inbound_messages')) {
        db.exec('DROP INDEX IF EXISTS idx_inbound_sender; DROP INDEX IF EXISTS idx_inbound_received_at;'
            + ' ALTER TABLE inbound_messages RENAME TO inbound_old');
    }
    if (old.includes('opt_outs')) db.exec('ALTER TABLE opt_outs RENAME TO opt_outs_old');
}

/** Runs after SCHEMA: copy the rebuilt tables across. */
function finishLegacy(db, old) {
    if (old.includes('inbound_messages')) {
        db.exec(`INSERT INTO inbound_messages
                 (id, message_id, sender, sender_name, body, media_url, media_type, replied_rule, is_read, received_at)
                 SELECT id, message_id, sender, sender_name, body, media_url, media_type, replied_rule, is_read, received_at
                 FROM inbound_old; DROP TABLE inbound_old`);
    }
    if (old.includes('opt_outs')) {
        db.exec(`INSERT INTO opt_outs (phone, reason, opted_out_at)
                 SELECT phone, reason, opted_out_at FROM opt_outs_old; DROP TABLE opt_outs_old`);
    }
}

const DEFAULT_AUTO_REPLIES = Object.freeze([
    {
        keyword: 'hi',
        matchType: 'EXACT',
        replyBody: '{time_greeting} {name}, thank you for contacting us. We have received your message and an executive will attend to you shortly. If you need immediate assistance, please reply with your query.',
    },
    {
        keyword: 'hello',
        matchType: 'EXACT',
        replyBody: '{time_greeting} {name}, thank you for contacting us. We have received your message and an executive will attend to you shortly. If you need immediate assistance, please reply with your query.',
    },
    {
        keyword: 'pricing',
        matchType: 'CONTAINS',
        replyBody: 'Thank you for your interest in our services. Our pricing catalog is available upon request. A representative will contact you with details.',
    },
]);

export { DEFAULT_TENANT_ID };

export class Database {
    constructor(dbPath = DB_PATH) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.path = dbPath;
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        const old = legacyTables(this.db);
        if (old.length) prepareLegacy(this.db, old);
        // Before SCHEMA: its indexes reference channel_id on tables that predate it.
        addChannelColumns(this.db);
        this.db.exec(SCHEMA);
        addTenantControlColumns(this.db);
        for (const fragment of MODULE_SCHEMAS) this.db.exec(fragment);
        migrateTemplates(this.db);
        migrateAutoReplies(this.db);
        migratePlans(this.db);
        if (old.length) finishLegacy(this.db, old);
        dropCloudChannels(this.db);
        once(this.db, 'qr-daily-limit-250-to-plan', () => releaseQrDailyLimits(this.db));
        this.db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, status, created_at)
                         VALUES (?, 'Default', 'default', 'active', ?)`).run(DEFAULT_TENANT_ID, utcNow());
        // The root handle is tenant 1, so single-tenant code and tests are unchanged.
        this.tenantId = DEFAULT_TENANT_ID;
        this.channelId = null;
        this.seedAutoReplies();
    }

    /** A view of the same connection with every query pinned to one tenant. */
    forTenant(tenantId) {
        const scoped = Object.create(this);
        scoped.tenantId = Number(tenantId);
        return scoped;
    }

    /**
     * Narrow a tenant handle to one channel.  Writes are stamped with the
     * channel id; reads stay tenant-wide unless the caller asks for
     * `{ channelId: this.channelId }`, because an operator looking at history
     * wants the whole business, not one number.
     */
    forChannel(channelId) {
        const scoped = Object.create(this);
        scoped.channelId = channelId == null ? null : Number(channelId);
        return scoped;
    }

    close() {
        this.db.close();
    }

    insert(record) {
        const now = utcNow();
        const row = {
            tenant_id: this.tenantId,
            channel_id: this.channelId ?? null,
            message_id: record.messageId,
            message_type: record.messageType ?? 'campaign',
            direction: record.direction ?? 'outbound',
            idempotency_key: record.idempotencyKey ?? null,
            recipient: record.recipient,
            message: record.message,
            status: record.status,
            attempt: record.attempt ?? 0,
            provider_id: record.providerId ?? null,
            error: record.error ?? null,
            name: record.name ?? '',
            campaign_id: record.campaignId ?? '',
            created_at: record.createdAt ?? now,
            updated_at: record.updatedAt ?? now,
            sent_at: SUCCESS_STATUSES.includes(record.status) ? (record.sentAt ?? record.updatedAt ?? record.createdAt ?? now) : null,
            variant: record.variant ?? null,
        };
        this.db.prepare(`
            INSERT INTO messages (tenant_id, channel_id, message_id, message_type, direction,
                                  idempotency_key, recipient, message, status, attempt,
                                  provider_id, error, name, campaign_id, created_at, updated_at, sent_at, variant)
            VALUES (:tenant_id, :channel_id, :message_id, :message_type, :direction,
                    :idempotency_key, :recipient, :message, :status, :attempt,
                    :provider_id, :error, :name, :campaign_id, :created_at, :updated_at, :sent_at, :variant)
        `).run(row);
        return toRecord(row);
    }

    updateStatus(messageId, status, { attempt, providerId, error, parts } = {}) {
        const now = utcNow();
        const sets = ['status = ?', 'updated_at = ?'];
        const args = [status, now];
        // The first time it counts as sent is when it left, whatever happens to it afterwards.
        if (SUCCESS_STATUSES.includes(status)) {
            sets.push('sent_at = COALESCE(sent_at, ?)');
            args.push(now);
        }
        if (attempt !== undefined) {
            sets.push('attempt = ?');
            args.push(attempt);
        }
        if (providerId !== undefined) {
            sets.push('provider_id = ?');
            args.push(providerId);
        }
        if (parts != null) {
            sets.push('parts = ?');
            args.push(parts);
        }
        // `error` is set even when null: a successful retry must clear it.
        sets.push('error = ?');
        args.push(error ?? null);
        args.push(messageId, this.tenantId);
        this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE message_id = ? AND tenant_id = ?`)
            .run(...args);
    }

    /**
     * Apply a delivery receipt, refusing to downgrade: a "delivered" arriving
     * after a "read" must not win.  Returns true when the row changed.
     */
    applyReceipt(providerId, status, error = null) {
        const row = this.db.prepare(
            'SELECT message_id, status, recipient FROM messages WHERE provider_id = ? AND tenant_id = ?')
            .get(providerId, this.tenantId);
        if (!row) return false;
        const current = STATUS_RANK[row.status] ?? 0;
        const incoming = STATUS_RANK[status] ?? 0;
        if (incoming <= current && status !== Status.FAILED) return false;
        const now = utcNow();
        this.db.prepare('UPDATE messages SET status = ?, error = ?, updated_at = ?, sent_at = COALESCE(sent_at, ?) WHERE message_id = ? AND tenant_id = ?')
            .run(status, error, now, SUCCESS_STATUSES.includes(status) ? now : null, row.message_id, this.tenantId);
        // The phone has it (two ticks): whoever it was flagged as having blocked us has not.
        if (status === Status.DELIVERED || status === Status.READ) this.clearBlocks(row.recipient);
        return true;
    }

    /** Drop the suspected-block events of a number that has since received a message. */
    clearBlocks(phone) {
        this.db.prepare("DELETE FROM safety_events WHERE tenant_id = ? AND kind = 'block' AND phone = ?")
            .run(this.tenantId, phone);
    }

    /**
     * Sweep up block events that turned out wrong: the flagged message got its
     * ticks after all, a later message to the same number was delivered, or the
     * number wrote back. Events written before this check existed heal here too.
     */
    healBlocks() {
        const scope = this.channelId != null ? ' AND e.channel_id = ?' : '';
        const args = this.channelId != null ? [this.channelId] : [];
        return this.db.prepare(
            `DELETE FROM safety_events AS e WHERE e.tenant_id = ? AND e.kind = 'block'${scope} AND EXISTS (
               SELECT 1 FROM messages m WHERE m.tenant_id = e.tenant_id AND m.message_id = e.message_id AND (
                    m.status IN ('DELIVERED', 'READ')
                 OR EXISTS (SELECT 1 FROM messages d WHERE d.tenant_id = m.tenant_id AND d.recipient = m.recipient
                            AND d.status IN ('DELIVERED', 'READ') AND d.updated_at > m.updated_at)
                 OR EXISTS (SELECT 1 FROM inbound_messages i WHERE i.tenant_id = m.tenant_id
                            AND i.sender = m.recipient AND i.received_at > m.created_at)))`,
        ).run(this.tenantId, ...args).changes;
    }

    get(messageId) {
        const row = this.db.prepare('SELECT * FROM messages WHERE message_id = ? AND tenant_id = ?')
            .get(messageId, this.tenantId);
        return row ? toRecord(row) : null;
    }

    /** The row a previous caller created under this key, or null. */
    findByIdempotencyKey(key) {
        if (!key) return null;
        const row = this.db.prepare(
            'SELECT * FROM messages WHERE tenant_id = ? AND idempotency_key = ?').get(this.tenantId, key);
        return row ? toRecord(row) : null;
    }

    /** Is this number opted out of this tenant? The send path asks on every job. */
    isOptedOut(phone) {
        return Boolean(this.db.prepare('SELECT 1 FROM opt_outs WHERE tenant_id = ? AND phone = ?')
            .get(this.tenantId, String(phone)));
    }

    getByProviderId(providerId) {
        const row = this.db.prepare('SELECT * FROM messages WHERE provider_id = ? AND tenant_id = ?')
            .get(providerId, this.tenantId);
        return row ? toRecord(row) : null;
    }

    history({ limit = 1000, status = null, recipient = null, campaignId = null, channelId = null } = {}) {
        const clauses = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (channelId) {
            clauses.push('channel_id = ?');
            args.push(Number(channelId));
        }
        if (status) {
            clauses.push('status = ?');
            args.push(status);
        }
        if (recipient) {
            clauses.push('recipient LIKE ?');
            args.push(`%${recipient}%`);
        }
        if (campaignId) {
            clauses.push('campaign_id = ?');
            args.push(campaignId);
        }
        let sql = 'SELECT * FROM messages';
        sql += ` WHERE ${clauses.join(' AND ')}`;
        sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
        args.push(limit);
        return this.db.prepare(sql).all(...args).map(toRecord);
    }

    /**
     * (row count, latest update, status mix) for a filter: the cheap "did
     * anything change?" question, so a client never re-fetches rows it already
     * has. `updated_at` has one-second resolution, and a campaign queues a row
     * and sends it inside the same second: the mix (rows per status, attempts)
     * is what tells those writes apart.
     */
    historySignature({ status = null, recipient = null } = {}) {
        const clauses = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (status) {
            clauses.push('status = ?');
            args.push(status);
        }
        if (recipient) {
            clauses.push('recipient LIKE ?');
            args.push(`%${recipient}%`);
        }
        let sql = 'SELECT status, COUNT(*) AS n, MAX(updated_at) AS last, SUM(attempt) AS tries FROM messages';
        sql += ` WHERE ${clauses.join(' AND ')} GROUP BY status ORDER BY status`;
        const rows = this.db.prepare(sql).all(...args);
        return {
            count: rows.reduce((sum, r) => sum + r.n, 0),
            last: rows.reduce((max, r) => (r.last > max ? r.last : max), ''),
            mix: rows.map((r) => `${r.status}${r.n}.${r.tries}`).join(','),
        };
    }

    countsByStatus(campaignId = null, channelId = null) {
        let sql = 'SELECT status, COUNT(*) AS n FROM messages WHERE tenant_id = ?';
        const args = [this.tenantId];
        if (channelId) {
            sql += ' AND channel_id = ?';
            args.push(Number(channelId));
        }
        if (campaignId) {
            sql += ' AND campaign_id = ?';
            args.push(campaignId);
        }
        sql += ' GROUP BY status';
        return Object.fromEntries(this.db.prepare(sql).all(...args).map((r) => [r.status, r.n]));
    }

    /**
     * How many real messages were sent in a window.  Drives the daily cap, so
     * it counts only what actually left the machine: SANDBOX does not.
     */
    countSentBetween(startIso, endIso) {
        const placeholders = SUCCESS_STATUSES.map(() => '?').join(',');
        if (this.channelId != null) {
            return this.db.prepare(
                `SELECT COUNT(*) AS n FROM messages
                 WHERE tenant_id = ? AND channel_id = ? AND status IN (${placeholders})
                   AND COALESCE(sent_at, created_at) >= ? AND COALESCE(sent_at, created_at) < ?
                   AND created_at >= ${NUMBER_SINCE}`,
            ).get(this.tenantId, this.channelId, ...SUCCESS_STATUSES, startIso, endIso, this.channelId).n;
        }
        const row = this.db.prepare(
            `SELECT COUNT(*) AS n FROM messages
             WHERE tenant_id = ? AND status IN (${placeholders}) AND COALESCE(sent_at, created_at) >= ? AND COALESCE(sent_at, created_at) < ?`
        ).get(this.tenantId, ...SUCCESS_STATUSES, startIso, endIso);
        return row.n;
    }

    /**
     * Everything a QR number's sending level and budgets are computed from
     * (campaign/humanize.js levelFor, campaign/safety.js allowanceFrom), read
     * fresh from the rows so a restart or relink cannot reset it. Channel-scoped,
     * and only the current number's rows (`number_since`). History counts from
     * the anchor: the number's start, or its last ban.
     *  - delivered / bulkDelivered / activeDays (UTC dates) / lastDeliveredBefore (today): the level's needs;
     *  - bulkToday / lastHour: held types sent, counting each part; lastSentAt: the gap's floor;
     *  - newChatsToday: people sent to today who never got an earlier message and never wrote first,
     *    plus today's NOT_ON_WHATSAPP lookups;
     *  - reached / replied (48h), delivered7d, ok24 / failed24 (by updated_at), events: the brakes;
     *  - bestCleanDay7 / lastDayDelivered / hasHistory / brakeIn7d: the growth cap (campaign/safety.js growthFrom);
     *  - health: sends from `healthSince` (default 7 days ago) to 2h ago (replies: to 24h ago; `attempted` / `failed` add the
     *    sends that failed before leaving), for promotion and demotion (humanize.js healthCheck).
     */
    sendingLedger({ dayStart, now = new Date(), healthSince = null }) {
        const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
        const t = now.getTime();
        const day = iso(dayStart.getTime());
        const hourAgo = iso(t - 3_600_000);
        const since = numberSince(this);
        const ch = this.channelId != null;
        // Every predicate is this number's: its channel, and rows made since it took over.
        const on = (alias, column = 'created_at') => (ch ? ` AND ${alias}.channel_id = ? AND ${alias}.${column} >= ?` : '');
        const at = ch ? [this.channelId, since] : [];
        const ok = SUCCESS_STATUSES.map(() => '?').join(',');
        const held = HELD_TYPES.map(() => '?').join(',');

        const events = this.db.prepare(
            `SELECT MAX(CASE WHEN kind = 'ban' THEN at END) AS lastBanAt,
                    COUNT(CASE WHEN kind = 'ban' AND at >= ? THEN 1 END) AS bans30d,
                    COUNT(DISTINCT CASE WHEN kind = 'block' AND at >= ? THEN phone END) AS blocks7d,
                    COUNT(DISTINCT CASE WHEN kind = 'report' AND at >= ? THEN phone END) AS reports7d,
                    MAX(CASE WHEN kind = 'report' THEN at END) AS lastReportAt
             FROM safety_events e WHERE e.tenant_id = ?${on('e', 'at')}`,
        ).get(iso(t - 30 * 86_400_000), iso(t - 7 * 86_400_000), iso(t - 7 * 86_400_000), this.tenantId, ...at);
        // The reports brake holds 72h past the last report: count the reporters in the 72h up to it.
        const lastReport = Date.parse(events.lastReportAt ?? '');
        const reportBurst = t - lastReport < 72 * 3_600_000 ? this.db.prepare(
            `SELECT COUNT(DISTINCT phone) AS n FROM safety_events e
             WHERE e.tenant_id = ?${on('e', 'at')} AND kind = 'report' AND at >= ?`,
        ).get(this.tenantId, ...at, iso(lastReport - 72 * 3_600_000)).n : 0;
        // A restriction's end is its message_id (written by app.js from the transport's 'restricted').
        const restrict = this.db.prepare(
            `SELECT message_id AS until, detail FROM safety_events e
             WHERE e.tenant_id = ?${on('e', 'at')} AND kind = 'restrict' AND message_id > ? ORDER BY message_id DESC LIMIT 1`,
        ).get(this.tenantId, ...at, now.toISOString());
        // Enforced delivery / stuck / unstable brakes still running (CampaignManager.recordBrake): code in phone,
        // end in message_id. Shadow rows (kind 'shadow') are never read here.
        const holds = this.db.prepare(
            `SELECT phone AS code, MAX(message_id) AS until, detail FROM safety_events e
             WHERE e.tenant_id = ?${on('e', 'at')} AND kind = 'brake' AND message_id > ? GROUP BY phone`,
        ).all(this.tenantId, ...at, now.toISOString());

        const anchor = [since, events.lastBanAt ?? ''].sort().at(-1);
        const { bulkBefore, ...history } = this.db.prepare(
            `SELECT COUNT(*) AS delivered, COALESCE(SUM(m.message_type IN (${held})), 0) AS bulkDelivered,
                    COUNT(DISTINCT substr(m.sent_at, 1, 10)) AS activeDays,
                    MAX(CASE WHEN m.sent_at < ? THEN m.sent_at END) AS lastDeliveredBefore,
                    COALESCE(SUM(m.sent_at >= ?), 0) AS delivered7d,
                    COALESCE(SUM(m.message_type IN (${held}) AND m.sent_at < ?), 0) AS bulkBefore
             FROM messages m WHERE m.tenant_id = ?${on('m')} AND m.status IN ('DELIVERED', 'READ') AND m.sent_at >= ?`,
        ).get(...HELD_TYPES, day, iso(t - 7 * 86_400_000), ...HELD_TYPES, day, this.tenantId, ...at, anchor);
        // The growth cap: delivered bulk (parts, as the day's budget counts) on each of the 7 days before today, index
        // -7..-1, and the days a brake that really applied was on (-7..0: brake_day marks from DailyQuota.allowance,
        // enforced brake rows). Shadow rows never count. `+ 8 AS INTEGER` floors: CAST truncates toward zero.
        const dayOf = (column) => `CAST(julianday(${column}) - julianday(?) + 8 AS INTEGER) - 8`;
        const weekAgo = iso(dayStart.getTime() - 7 * 86_400_000);
        const days = this.db.prepare(
            `SELECT ${dayOf('m.sent_at')} AS d, SUM(COALESCE(m.parts, 1)) AS n
             FROM messages m WHERE m.tenant_id = ?${on('m')} AND m.status IN ('DELIVERED', 'READ')
               AND m.message_type IN (${held}) AND m.sent_at >= ? AND m.sent_at >= ? AND m.sent_at < ? GROUP BY d`,
        ).all(day, this.tenantId, ...at, ...HELD_TYPES, anchor, weekAgo, day);
        const braked = new Set(this.db.prepare(
            `SELECT DISTINCT ${dayOf('e.at')} AS d FROM safety_events e
             WHERE e.tenant_id = ?${on('e', 'at')} AND e.kind IN ('brake_day', 'brake') AND e.at >= ?`,
        ).all(day, this.tenantId, ...at, weekAgo).map((r) => r.d));
        const clean = days.filter((r) => r.n > 0 && !braked.has(r.d));
        const lastDay = days.filter((r) => r.n > 0).sort((a, b) => b.d - a.d)[0];
        // From the earlier of midnight and an hour ago: the hour is never cut short at midnight.
        const budget = this.db.prepare(
            `SELECT COALESCE(SUM(CASE WHEN m.message_type IN (${held}) AND m.sent_at >= ? THEN COALESCE(m.parts, 1) END), 0) AS bulkToday,
                    COALESCE(SUM(CASE WHEN m.message_type IN (${held}) AND m.sent_at >= ? THEN COALESCE(m.parts, 1) END), 0) AS lastHour,
                    MAX(m.sent_at) AS lastSentAt
             FROM messages m WHERE m.tenant_id = ?${on('m')} AND m.sent_at >= ?`,
        ).get(...HELD_TYPES, day, ...HELD_TYPES, hourAgo, this.tenantId, ...at, [day, hourAgo].sort()[0]);
        // `+p.sent_at`: look the earlier send up by recipient, not by scanning the number's whole history by time.
        const newChats = this.db.prepare(
            `SELECT (SELECT COUNT(DISTINCT m.recipient) FROM messages m
                     WHERE m.tenant_id = ?${on('m')} AND m.sent_at >= ? AND m.recipient NOT LIKE '%@%'
                       AND NOT EXISTS (SELECT 1 FROM messages p WHERE p.tenant_id = m.tenant_id${on('p')}
                                       AND p.recipient = m.recipient AND +p.sent_at < ?)
                       AND NOT EXISTS (SELECT 1 FROM inbound_messages i WHERE i.tenant_id = m.tenant_id${on('i', 'received_at')}
                                       AND i.sender = m.recipient AND i.received_at < m.sent_at))
                  + (SELECT COUNT(DISTINCT m.recipient) FROM messages m
                     WHERE m.tenant_id = ?${on('m')} AND m.status = 'NOT_ON_WHATSAPP' AND m.updated_at >= ?) AS n`,
        ).get(this.tenantId, ...at, day, ...at, day, ...at, this.tenantId, ...at, day).n;
        // Replies to bulk sent from `fromIso` (to `toIso`); someone who replied STOP is not a reply that helps.
        const repliesSince = (fromIso, toIso = iso(t + 86_400_000)) => this.db.prepare(
            `SELECT COUNT(DISTINCT m.recipient) AS reached,
                    COUNT(DISTINCT CASE WHEN EXISTS (SELECT 1 FROM inbound_messages i WHERE i.tenant_id = m.tenant_id${on('i', 'received_at')}
                                                     AND i.sender = m.recipient AND i.received_at > m.sent_at)
                                         AND NOT EXISTS (SELECT 1 FROM opt_outs o WHERE o.tenant_id = m.tenant_id AND o.phone = m.recipient)
                                        THEN m.recipient END) AS replied
             FROM messages m WHERE m.tenant_id = ?${on('m')} AND m.status IN ('DELIVERED', 'READ')
               AND m.message_type IN (${held}) AND m.sent_at >= ? AND m.sent_at < ?`,
        ).get(...at, this.tenantId, ...at, ...HELD_TYPES, fromIso, toIso);
        const replies = repliesSince(iso(t - 48 * 3_600_000));
        const healthFrom = Math.max(t - 7 * 86_400_000, Date.parse(healthSince ?? '') || 0);
        const win = this.deliveryWindow(now, healthFrom);
        // Sends that failed before leaving have no sent_at, so the window misses them: the failed rate adds them.
        const unsent = this.db.prepare(
            `SELECT COUNT(*) AS n FROM messages m WHERE m.tenant_id = ?${on('m')} AND m.status = 'FAILED' AND m.sent_at IS NULL
               AND m.updated_at >= ? AND m.recipient NOT LIKE '%@g.us'`,
        ).get(this.tenantId, ...at, iso(healthFrom)).n;
        const health = {
            since: iso(healthFrom), sent: win.sentWin, attempted: win.sentWin + unsent, delivered: win.deliveredWin,
            failed: win.failedWin + unsent, stuck: win.stuckWin,
            // Replies only to sends a day old or more: people reached minutes ago have not had time to answer.
            ...repliesSince(iso(healthFrom), iso(t - 86_400_000)),
        };
        // shortcut: this, today's NOT_ON_WHATSAPP and the history since the anchor scan the number's rows (no updated_at
        // index; history is every delivery). Fine up to ~100k rows a number; add a summary table or an index past that.
        const failures = this.db.prepare(
            `SELECT COALESCE(SUM(m.status = 'FAILED'), 0) AS failed24, COALESCE(SUM(m.status IN (${ok})), 0) AS ok24
             FROM messages m WHERE m.tenant_id = ?${on('m')} AND m.updated_at >= ?`,
        ).get(...SUCCESS_STATUSES, this.tenantId, ...at, iso(t - 86_400_000));

        return {
            anchor,
            ...history,
            ...budget,
            newChatsToday: newChats,
            ...replies,
            ...failures,
            blocks7d: events.blocks7d,
            reports7d: events.reports7d,
            lastReportAt: events.lastReportAt ?? null,
            reportBurst,
            lastBanAt: events.lastBanAt ?? null,
            bans30d: events.bans30d,
            restrictedUntil: restrict?.until ?? null,
            restrictCode: restrict?.detail || null,
            holds,
            ...this.deliveryWindow(now),
            bestCleanDay7: clean.length ? Math.max(...clean.map((r) => r.n)) : 0,
            lastDayDelivered: lastDay?.n ?? 0,
            hasHistory: bulkBefore > 0,
            brakeIn7d: braked.size > 0,
            health,
        };
    }

    /**
     * Delivery over this number's messages sent between 2h and 24h ago (the 2h floor skips messages still
     * landing), groups left out: `sentWin`, of those `deliveredWin` (two ticks) and `failedWin`, and
     * `stuckWin` = sentWin - deliveredWin - failedWin (still one tick). One window on both sides, so no rate passes 100%.
     * `fromMs` moves the window's start (the 7-day health in sendingLedger).
     */
    deliveryWindow(now = new Date(), fromMs = now.getTime() - 24 * 3_600_000) {
        const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
        const t = now.getTime();
        const ch = this.channelId != null;
        const row = this.db.prepare(
            `SELECT COUNT(*) AS sentWin, COALESCE(SUM(status IN ('DELIVERED', 'READ')), 0) AS deliveredWin,
                    COALESCE(SUM(status = 'FAILED'), 0) AS failedWin
             FROM messages WHERE tenant_id = ?${ch ? ' AND channel_id = ? AND created_at >= ?' : ''}
               AND sent_at >= ? AND sent_at < ? AND recipient NOT LIKE '%@g.us'`,
        ).get(this.tenantId, ...(ch ? [this.channelId, numberSince(this)] : []), iso(fromMs), iso(t - 2 * 3_600_000));
        return { ...row, stuckWin: row.sentWin - row.deliveredWin - row.failedWin };
    }

    /** The end of a running `kind` ('brake' | 'shadow') row for brake `code` (CampaignManager.recordBrake), or null. */
    activeBrake(kind, code, now = new Date()) {
        const scope = this.channelId != null ? ' AND channel_id = ?' : '';
        return this.db.prepare(
            `SELECT MAX(message_id) AS until FROM safety_events WHERE tenant_id = ?${scope} AND kind = ? AND phone = ? AND message_id > ?`,
        ).get(this.tenantId, ...(this.channelId != null ? [this.channelId] : []), kind, code, now.toISOString()).until ?? null;
    }

    /**
     * The end of the business's ban hold, or null: a 2nd ban within 30 days across all its numbers stops every
     * number levelling up for 14 days from that ban (DailyQuota.allowance). It counts every number, not this one.
     */
    tenantBanHold(now = new Date()) {
        const t = now.getTime();
        const bans = this.db.prepare("SELECT at FROM safety_events WHERE tenant_id = ? AND kind = 'ban' AND at >= ? ORDER BY at")
            .all(this.tenantId, new Date(t - 44 * 86_400_000).toISOString()).map((r) => Date.parse(r.at));
        const second = bans.findLast((b, i) => i > 0 && b - bans[i - 1] <= 30 * 86_400_000);
        const until = second == null ? null : second + 14 * 86_400_000;
        return until > t ? new Date(until).toISOString() : null;
    }

    /** Everyone who ever wrote to this number (as isCold scopes it): warm contacts, never a new chat. */
    inboundSenders() {
        const scope = this.channelId != null ? ' AND channel_id = ? AND received_at >= ?' : '';
        return new Set(this.db.prepare(`SELECT DISTINCT sender FROM inbound_messages WHERE tenant_id = ?${scope}`)
            .all(this.tenantId, ...(this.channelId != null ? [this.channelId, numberSince(this)] : [])).map((r) => r.sender));
    }

    /** True when this number never sent to `phone` and never heard from them: a new chat (bare digits). */
    isCold(phone) {
        const since = numberSince(this);
        const on = (alias, column) => (this.channelId != null ? ` AND ${alias}.channel_id = ? AND ${alias}.${column} >= ?` : '');
        const at = this.channelId != null ? [this.channelId, since] : [];
        return Boolean(this.db.prepare(
            `SELECT NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = ?${on('m', 'created_at')}
                                AND m.recipient = ? AND m.sent_at IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM inbound_messages i WHERE i.tenant_id = ?${on('i', 'received_at')}
                                AND i.sender = ?) AS cold`,
        ).get(this.tenantId, ...at, String(phone), this.tenantId, ...at, String(phone)).cold);
    }

    /**
     * Numbers that already received a real message (SENT/DELIVERED/READ).
     * SANDBOX is excluded: a local test send must not stop the real one.
     */
    sentRecipients() {
        const placeholders = SUCCESS_STATUSES.map(() => '?').join(',');
        const rows = this.db.prepare(
            `SELECT DISTINCT recipient FROM messages WHERE tenant_id = ? AND status IN (${placeholders})`
        ).all(this.tenantId, ...SUCCESS_STATUSES);
        return new Set(rows.map((r) => r.recipient));
    }

    /** True when a real message (not sandbox, not failed) ever went to this number. */
    hasSentTo(phone) {
        const placeholders = SUCCESS_STATUSES.map(() => '?').join(',');
        return Boolean(this.db.prepare(
            `SELECT 1 FROM messages WHERE tenant_id = ? AND recipient = ? AND status IN (${placeholders}) LIMIT 1`
        ).get(this.tenantId, phone, ...SUCCESS_STATUSES));
    }

    /** People a campaign reached, and how many of them opted out after their message. */
    campaignStopRate(campaignId) {
        return this.db.prepare(
            `SELECT COUNT(DISTINCT m.recipient) AS delivered,
                    COUNT(DISTINCT CASE WHEN o.opted_out_at >= m.sent_at THEN m.recipient END) AS stopped
             FROM messages m LEFT JOIN opt_outs o ON o.tenant_id = m.tenant_id AND o.phone = m.recipient
             WHERE m.tenant_id = ? AND m.campaign_id = ? AND m.status IN ('DELIVERED', 'READ')`,
        ).get(this.tenantId, campaignId);
    }

    /** Record a suspected block / report once per (kind, number, message). Returns true when new. */
    addSafetyEvent({ kind, phone, messageId = '', campaignId = '', detail = '', at = utcNow() }) {
        const res = this.db.prepare(
            `INSERT OR IGNORE INTO safety_events
             (tenant_id, channel_id, kind, phone, message_id, campaign_id, detail, at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(this.tenantId, this.channelId ?? null, kind, phone, String(messageId), campaignId, detail, at);
        return res.changes > 0;
    }

    /**
     * Newest first, with the contact's name from the last message sent to them. Brake rows (kind 'brake' /
     * 'shadow', see brakeEvents), brake days and level changes are the number's own state, not a person, and
     * shadow rows are for the admin only.
     */
    safetyEvents(limit = 50) {
        const scope = this.channelId != null ? ' AND e.channel_id = ?' : '';
        const args = this.channelId != null ? [this.channelId] : [];
        return this.db.prepare(
            `SELECT e.id, e.kind, e.phone, e.campaign_id AS campaignId, e.detail, e.at,
                    (SELECT m.name FROM messages m WHERE m.tenant_id = e.tenant_id AND m.recipient = e.phone
                     AND m.name != '' ORDER BY m.created_at DESC LIMIT 1) AS name
             FROM safety_events e WHERE e.tenant_id = ?${scope} AND e.kind NOT IN ('brake', 'shadow', 'brake_day', 'level') ORDER BY e.id DESC LIMIT ?`,
        ).all(this.tenantId, ...args, limit);
    }

    /**
     * The delivery / stuck / unstable brake rows since `sinceIso`, newest first: `{ kind ('brake' enforced |
     * 'shadow' logged only), code, until, detail, at }` (CampaignManager.recordBrake).
     */
    brakeEvents(sinceIso) {
        const scope = this.channelId != null ? ' AND channel_id = ?' : '';
        return this.db.prepare(
            `SELECT kind, phone AS code, message_id AS until, detail, at FROM safety_events
             WHERE tenant_id = ?${scope} AND kind IN ('brake', 'shadow') AND phone NOT LIKE 'level:%' AND at >= ? ORDER BY id DESC LIMIT 200`,
        ).all(this.tenantId, ...(this.channelId != null ? [this.channelId] : []), sinceIso);
    }

    /**
     * Level changes since `sinceIso`, newest first (DailyQuota.allowance writes them): `{ shadow, reason, from, to,
     * text, at }`. `shadow` true: computed under sending.brakesMode 'shadow' and never applied (kind 'shadow',
     * phone 'level:<reason>'); else kind 'level'. Reasons: promote, demote_delivery, demote_stuck, demote_replies,
     * hold_health, hold_probation, idle, history (a ban, a new number or tighter needs restarted the history).
     */
    levelEvents(sinceIso) {
        const scope = this.channelId != null ? ' AND channel_id = ?' : '';
        return this.db.prepare(
            `SELECT kind, phone, detail, at FROM safety_events
             WHERE tenant_id = ?${scope} AND (kind = 'level' OR (kind = 'shadow' AND phone LIKE 'level:%')) AND at >= ?
             ORDER BY id DESC LIMIT 200`,
        ).all(this.tenantId, ...(this.channelId != null ? [this.channelId] : []), sinceIso).map((r) => {
            let d = {};
            try { d = JSON.parse(r.detail); } catch { /* a bad row still lists */ }
            const shadow = r.kind === 'shadow';
            return { shadow, reason: shadow ? r.phone.slice(6) : r.phone, from: d.from ?? null, to: d.to ?? null, text: d.text ?? '', at: r.at };
        });
    }

    /**
     * This number's stored level state (channel_ops, policy/channelOps.js): `{ level, demotedAt, cleanChecks,
     * checkedAt }`, or null without a channel or before channel_ops exists (then nothing is remembered).
     */
    levelState() {
        if (this.channelId == null) return null;
        try {
            const r = this.db.prepare('SELECT last_level, demoted_at, clean_checks, clean_check_at FROM channel_ops WHERE channel_id = ?')
                .get(this.channelId);
            return { level: r?.last_level ?? null, demotedAt: r?.demoted_at ?? null, cleanChecks: r?.clean_checks ?? 0, checkedAt: r?.clean_check_at ?? null };
        } catch {
            return null; // channel_ops not created (or not migrated) yet
        }
    }

    /** Store what levelState reads. */
    saveLevelState({ level, demotedAt, cleanChecks, checkedAt }) {
        if (this.channelId == null) return;
        this.db.prepare(`INSERT INTO channel_ops (channel_id, last_level, demoted_at, clean_checks, clean_check_at) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (channel_id) DO UPDATE SET last_level = excluded.last_level, demoted_at = excluded.demoted_at,
                clean_checks = excluded.clean_checks, clean_check_at = excluded.clean_check_at`)
            .run(this.channelId, level, demotedAt, cleanChecks, checkedAt);
    }

    /** Event counts by kind since `sinceIso`. */
    safetyEventCounts(sinceIso) {
        const scope = this.channelId != null ? ' AND channel_id = ?' : '';
        const args = this.channelId != null ? [this.channelId] : [];
        const rows = this.db.prepare(
            `SELECT kind, COUNT(DISTINCT phone) AS n FROM safety_events WHERE tenant_id = ?${scope} AND at >= ? GROUP BY kind`,
        ).all(this.tenantId, ...args, sinceIso);
        return Object.fromEntries(rows.map((r) => [r.kind, r.n]));
    }

    /**
     * Campaign messages due their one block judgement (CampaignManager.scanHealth): still one tick (SENT) at
     * 48h, never judged (`block_checked`). Age counts from the send, not the queueing. Each carries what the
     * judgement reads over hours 24-48 after its send: `quiet` (the recipient wrote nothing and got nothing
     * delivered from us), and `winSent` / `winDelivered` (this number's own sends then, groups left out).
     * shortcut: sent 48-72h ago, so a scan a restart missed catches up; older ones are never judged.
     */
    stuckSent(now = new Date()) {
        const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
        const t = now.getTime();
        const scope = this.channelId != null ? ' AND channel_id = ?' : '';
        const args = this.channelId != null ? [this.channelId] : [];
        const due = this.db.prepare(
            `SELECT message_id AS messageId, recipient AS phone, campaign_id AS campaignId, provider_id AS providerId, sent_at AS sentAt
             FROM messages
             WHERE tenant_id = ?${scope} AND status = 'SENT' AND message_type = 'campaign' AND block_checked IS NULL
               AND sent_at >= ? AND sent_at <= ?
             LIMIT 500`,
        ).all(this.tenantId, ...args, iso(t - 72 * 3_600_000), iso(t - 48 * 3_600_000));
        const heard = this.db.prepare(
            `SELECT EXISTS (SELECT 1 FROM messages d WHERE d.tenant_id = ? AND d.recipient = ? AND d.status IN ('DELIVERED', 'READ')
                            AND d.updated_at >= ? AND d.sent_at < ?)
                 OR EXISTS (SELECT 1 FROM inbound_messages i WHERE i.tenant_id = ? AND i.sender = ?
                            AND i.received_at >= ? AND i.received_at < ?) AS heard`);
        const window = this.db.prepare(
            `SELECT COUNT(*) AS winSent, COALESCE(SUM(status IN ('DELIVERED', 'READ')), 0) AS winDelivered
             FROM messages WHERE tenant_id = ?${scope} AND sent_at >= ? AND sent_at < ? AND recipient NOT LIKE '%@g.us'`);
        return due.map((m) => {
            const sent = Date.parse(m.sentAt);
            const [from, to] = [iso(sent + 24 * 3_600_000), iso(sent + 48 * 3_600_000)];
            const quiet = !heard.get(this.tenantId, m.phone, from, to, this.tenantId, m.phone, from, to).heard;
            return { ...m, quiet, ...window.get(this.tenantId, ...args, from, to) };
        });
    }

    /** Mark campaign messages as judged for a block (stuckSent), so none is judged twice. */
    markBlockChecked(messageIds) {
        if (!messageIds.length) return;
        this.db.prepare('UPDATE messages SET block_checked = 1 WHERE tenant_id = ? AND message_id IN (SELECT value FROM json_each(?))')
            .run(this.tenantId, JSON.stringify(messageIds));
    }

    /**
     * Outbound delivery tallies for this channel since `weekIso` (and the
     * narrower `dayIso`), plus opt-outs from people this channel messaged.
     * Two indexed queries: cheap enough to run on every channel list.
     */
    channelQuality(weekIso, dayIso) {
        const ok = SUCCESS_STATUSES.map(() => '?').join(',');
        const row = this.db.prepare(
            `SELECT
                COALESCE(SUM(CASE WHEN status IN (${ok}) THEN 1 ELSE 0 END), 0) AS sent7,
                COALESCE(SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END), 0) AS failed7,
                COALESCE(SUM(CASE WHEN status IN (${ok}) AND created_at >= ? THEN 1 ELSE 0 END), 0) AS sent24,
                COALESCE(SUM(CASE WHEN status = 'FAILED' AND created_at >= ? THEN 1 ELSE 0 END), 0) AS failed24
             FROM messages
             WHERE tenant_id = ? AND channel_id = ? AND direction = 'outbound' AND created_at >= ?`,
        ).get(...SUCCESS_STATUSES, ...SUCCESS_STATUSES, dayIso, dayIso, this.tenantId, this.channelId, weekIso);
        const optOuts = this.db.prepare(
            `SELECT COUNT(*) AS n FROM opt_outs o
             WHERE o.tenant_id = ? AND o.opted_out_at >= ?
               AND EXISTS (SELECT 1 FROM messages m
                           WHERE m.recipient = o.phone AND m.tenant_id = o.tenant_id AND m.channel_id = ?)`,
        ).get(this.tenantId, weekIso, this.channelId).n;
        return { ...row, optOuts7: optOuts };
    }

    /** recipient -> bulk (campaign) messages queued or sent to them since `sinceIso`. A stopped run's rows never went out. */
    bulkCountsSince(sinceIso) {
        const rows = this.db.prepare(
            `SELECT recipient, COUNT(*) AS n FROM messages
             WHERE tenant_id = ? AND message_type = 'campaign' AND created_at >= ?
               AND status NOT IN ('FAILED', 'SANDBOX', 'NOT_ON_WHATSAPP', 'CANCELLED')
             GROUP BY recipient`,
        ).all(this.tenantId, sinceIso);
        return new Map(rows.map((r) => [r.recipient, r.n]));
    }

    insertInbound(record) {
        const now = utcNow();
        const row = {
            tenant_id: this.tenantId,
            channel_id: this.channelId ?? null,
            message_id: record.messageId ?? `inbound.${crypto.randomUUID()}`,
            sender: record.sender,
            sender_name: record.senderName ?? '',
            body: record.body ?? '',
            media_url: record.mediaUrl ?? null,
            media_type: record.mediaType ?? null,
            replied_rule: record.repliedRule ?? null,
            received_at: record.receivedAt ?? record.timestamp ?? now,
        };
        const { changes } = this.db.prepare(`
            INSERT OR IGNORE INTO inbound_messages
                (tenant_id, channel_id, message_id, sender, sender_name, body, media_url, media_type, replied_rule, received_at)
            VALUES
                (:tenant_id, :channel_id, :message_id, :sender, :sender_name, :body, :media_url, :media_type, :replied_rule, :received_at)
        `).run(row);
        const saved = this.db.prepare('SELECT * FROM inbound_messages WHERE message_id = ? AND tenant_id = ?')
            .get(row.message_id, this.tenantId);
        // isNew is false for a message id already stored: a redelivery, not a new message.
        return { ...toInboundRecord(saved), isNew: changes > 0 };
    }

    markInboundReplied(messageId, ruleKeyword) {
        this.db.prepare('UPDATE inbound_messages SET replied_rule = ? WHERE message_id = ? AND tenant_id = ?')
            .run(ruleKeyword, messageId, this.tenantId);
    }

    getInboundMessages({ sender = null, limit = 100 } = {}) {
        const args = [this.tenantId];
        let sql = 'SELECT * FROM inbound_messages WHERE tenant_id = ?';
        if (sender) {
            sql += ' AND sender = ?';
            args.push(sender);
        }
        sql += ' ORDER BY received_at DESC, id DESC LIMIT ?';
        args.push(limit);
        return this.db.prepare(sql).all(...args).map(toInboundRecord);
    }

    getConversations() {
        return this.db.prepare(`
            SELECT sender, COALESCE(NULLIF(sender_name, ''), sender) AS sender_name,
                   COUNT(*) AS message_count,
                   SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread_count,
                   MAX(received_at) AS last_received_at,
                   (SELECT body FROM inbound_messages latest
                    WHERE latest.sender = inbound_messages.sender
                      AND latest.tenant_id = inbound_messages.tenant_id
                    ORDER BY latest.received_at DESC, latest.id DESC LIMIT 1) AS last_body
            FROM inbound_messages
            WHERE tenant_id = ?
            GROUP BY sender
            ORDER BY last_received_at DESC
        `).all(this.tenantId).map((row) => ({
            sender: row.sender,
            senderName: row.sender_name ?? '',
            messageCount: row.message_count,
            unreadCount: row.unread_count,
            lastReceivedAt: row.last_received_at,
            lastBody: row.last_body ?? '',
        }));
    }

    markInboundRead(sender) {
        const result = this.db.prepare('UPDATE inbound_messages SET is_read = 1 WHERE sender = ? AND tenant_id = ?')
            .run(sender, this.tenantId);
        return result.changes;
    }

    // Auto-replies live in autoreply/store.js (v2: priority, keywords, variants,
    // media, menus...). These wrappers keep the v1 call sites working.
    getActiveAutoReplies() {
        return new AutoReplyStore(this).list({ activeOnly: true });
    }

    getAutoReplies() {
        return new AutoReplyStore(this).list();
    }

    saveAutoReply(rule) {
        return new AutoReplyStore(this).save(rule);
    }

    deleteAutoReply(id) {
        return new AutoReplyStore(this).remove(id);
    }

    addOptOut(phone, reason = 'user_requested') {
        const row = { phone, reason, opted_out_at: utcNow() };
        this.db.prepare(`
            INSERT INTO opt_outs (tenant_id, phone, reason, opted_out_at)
            VALUES (:tenant_id, :phone, :reason, :opted_out_at)
            ON CONFLICT(tenant_id, phone) DO UPDATE SET reason = excluded.reason, opted_out_at = excluded.opted_out_at
        `).run({ ...row, tenant_id: this.tenantId });
        return row;
    }

    removeOptOut(phone) {
        return this.db.prepare('DELETE FROM opt_outs WHERE phone = ? AND tenant_id = ?')
            .run(phone, this.tenantId).changes;
    }

    getAllOptOuts() {
        return this.db.prepare('SELECT phone FROM opt_outs WHERE tenant_id = ? ORDER BY phone ASC')
            .all(this.tenantId).map((row) => row.phone);
    }

    /** Numbers a reply rule muted from bulk campaigns (bulk_mutes, messaging/replies.js). */
    bulkMutedPhones() {
        return new Set(this.db.prepare('SELECT phone FROM bulk_mutes WHERE tenant_id = ? AND until > ?')
            .all(this.tenantId, utcNow()).map((row) => row.phone));
    }

    getOptOuts() {
        return this.db.prepare('SELECT * FROM opt_outs WHERE tenant_id = ? ORDER BY opted_out_at DESC')
            .all(this.tenantId).map((row) => ({
            phone: row.phone,
            reason: row.reason,
            optedOutAt: row.opted_out_at,
        }));
    }

    /** Keep one sent message's proto bytes for retry requests (baileys getMessage); drops rows over 14 days old. */
    saveSentProto(id, bytes) {
        this.db.prepare('DELETE FROM sent_protos WHERE at < ?').run(new Date(Date.now() - 14 * 86_400_000).toISOString());
        this.db.prepare('INSERT OR REPLACE INTO sent_protos (tenant_id, channel_id, id, proto, at) VALUES (?, ?, ?, ?, ?)')
            .run(this.tenantId, this.channelId ?? null, String(id), bytes, new Date().toISOString());
    }

    /** The bytes saveSentProto kept for this message id, or null. By id alone: a receipt from a LID device has the same id. */
    sentProto(id) {
        return this.db.prepare('SELECT proto FROM sent_protos WHERE tenant_id = ? AND id = ?')
            .get(this.tenantId, String(id))?.proto ?? null;
    }

    seedAutoReplies() {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM auto_replies WHERE tenant_id = ?')
            .get(this.tenantId).n;
        if (count > 0) return;
        for (const rule of DEFAULT_AUTO_REPLIES) this.saveAutoReply(rule);
    }
}

function toRecord(row) {
    return {
        messageId: row.message_id,
        messageType: row.message_type ?? 'campaign',
        direction: row.direction ?? 'outbound',
        idempotencyKey: row.idempotency_key ?? null,
        channelId: row.channel_id ?? null,
        recipient: row.recipient,
        message: row.message,
        status: row.status,
        attempt: row.attempt,
        providerId: row.provider_id ?? null,
        error: row.error ?? null,
        name: row.name ?? '',
        campaignId: row.campaign_id ?? '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toInboundRecord(row) {
    return {
        id: row.id,
        messageId: row.message_id,
        sender: row.sender,
        senderName: row.sender_name ?? '',
        body: row.body ?? '',
        mediaUrl: row.media_url ?? null,
        mediaType: row.media_type ?? null,
        repliedRule: row.replied_rule ?? null,
        isRead: Boolean(row.is_read),
        receivedAt: row.received_at,
    };
}
