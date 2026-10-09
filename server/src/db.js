/**
 * SQLite persistence, on node:sqlite - built into Node, so there is no native
 * module to compile and no ORM to learn.  Same schema as the Python app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DB_PATH } from './config.js';
// Feature modules own their own tables. Each exports a plain SQL string that is
// applied after the core schema, so a new feature never means editing the giant
// template literal below - and two features can be built without colliding.
import { MODULE_SCHEMAS } from './schema.js';
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
    inboundEnabled: true,
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
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_recipient   ON messages(recipient);
CREATE INDEX IF NOT EXISTS idx_messages_status      ON messages(status);
CREATE INDEX IF NOT EXISTS idx_messages_created_at  ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_provider_id ON messages(provider_id);
CREATE INDEX IF NOT EXISTS idx_messages_campaign_id ON messages(campaign_id);
CREATE INDEX IF NOT EXISTS idx_messages_tenant      ON messages(tenant_id);
CREATE INDEX IF NOT EXISTS idx_messages_channel     ON messages(channel_id);
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
    }
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
        if (old.length) finishLegacy(this.db, old);
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
        };
        this.db.prepare(`
            INSERT INTO messages (tenant_id, channel_id, message_id, message_type, direction,
                                  idempotency_key, recipient, message, status, attempt,
                                  provider_id, error, name, campaign_id, created_at, updated_at)
            VALUES (:tenant_id, :channel_id, :message_id, :message_type, :direction,
                    :idempotency_key, :recipient, :message, :status, :attempt,
                    :provider_id, :error, :name, :campaign_id, :created_at, :updated_at)
        `).run(row);
        return toRecord(row);
    }

    updateStatus(messageId, status, { attempt, providerId, error } = {}) {
        const sets = ['status = ?', 'updated_at = ?'];
        const args = [status, utcNow()];
        if (attempt !== undefined) {
            sets.push('attempt = ?');
            args.push(attempt);
        }
        if (providerId !== undefined) {
            sets.push('provider_id = ?');
            args.push(providerId);
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
            'SELECT message_id, status FROM messages WHERE provider_id = ? AND tenant_id = ?')
            .get(providerId, this.tenantId);
        if (!row) return false;
        const current = STATUS_RANK[row.status] ?? 0;
        const incoming = STATUS_RANK[status] ?? 0;
        if (incoming <= current && status !== Status.FAILED) return false;
        this.db.prepare('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE message_id = ? AND tenant_id = ?')
            .run(status, error, utcNow(), row.message_id, this.tenantId);
        return true;
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
     * (row count, latest update) for a filter: the cheap "did anything
     * change?" question, so a client never re-fetches rows it already has.
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
        let sql = "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS last FROM messages";
        sql += ` WHERE ${clauses.join(' AND ')}`;
        const row = this.db.prepare(sql).get(...args);
        return { count: row.n, last: row.last };
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
                   AND created_at >= ? AND created_at < ?`,
            ).get(this.tenantId, this.channelId, ...SUCCESS_STATUSES, startIso, endIso).n;
        }
        const row = this.db.prepare(
            `SELECT COUNT(*) AS n FROM messages
             WHERE tenant_id = ? AND status IN (${placeholders}) AND created_at >= ? AND created_at < ?`
        ).get(this.tenantId, ...SUCCESS_STATUSES, startIso, endIso);
        return row.n;
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
        this.db.prepare(`
            INSERT OR IGNORE INTO inbound_messages
                (tenant_id, channel_id, message_id, sender, sender_name, body, media_url, media_type, replied_rule, received_at)
            VALUES
                (:tenant_id, :channel_id, :message_id, :sender, :sender_name, :body, :media_url, :media_type, :replied_rule, :received_at)
        `).run(row);
        const saved = this.db.prepare('SELECT * FROM inbound_messages WHERE message_id = ? AND tenant_id = ?')
            .get(row.message_id, this.tenantId);
        return toInboundRecord(saved);
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

    getActiveAutoReplies() {
        return this.db.prepare(`
            SELECT * FROM auto_replies
            WHERE is_active = 1 AND tenant_id = ?
            ORDER BY CASE match_type
                WHEN 'EXACT' THEN 1
                WHEN 'CONTAINS' THEN 2
                WHEN 'REGEX' THEN 3
                WHEN 'FALLBACK' THEN 4
                ELSE 5
            END, id ASC
        `).all(this.tenantId).map(toAutoReply);
    }

    getAutoReplies() {
        return this.db.prepare('SELECT * FROM auto_replies WHERE tenant_id = ? ORDER BY id ASC')
            .all(this.tenantId).map(toAutoReply);
    }

    saveAutoReply(rule) {
        const now = utcNow();
        const row = {
            keyword: rule.keyword,
            match_type: rule.matchType ?? rule.match_type,
            reply_body: rule.replyBody ?? rule.reply_body,
            is_active: rule.isActive ?? rule.is_active ?? 1,
            cooldown_sec: rule.cooldownSec ?? rule.cooldown_sec ?? 300,
            created_at: rule.createdAt ?? now,
            updated_at: now,
        };
        const id = rule.id ?? null;
        if (id) {
            this.db.prepare(`
                UPDATE auto_replies
                SET keyword = :keyword, match_type = :match_type, reply_body = :reply_body,
                    is_active = :is_active, cooldown_sec = :cooldown_sec,
                    created_at = :created_at, updated_at = :updated_at
                WHERE id = :id AND tenant_id = :tenant_id
            `).run({ ...row, id, tenant_id: this.tenantId });
            return toAutoReply(this.db.prepare('SELECT * FROM auto_replies WHERE id = ? AND tenant_id = ?')
                .get(id, this.tenantId));
        }
        const result = this.db.prepare(`
            INSERT INTO auto_replies
                (tenant_id, keyword, match_type, reply_body, is_active, cooldown_sec, created_at, updated_at)
            VALUES
                (:tenant_id, :keyword, :match_type, :reply_body, :is_active, :cooldown_sec, :created_at, :updated_at)
        `).run({ ...row, tenant_id: this.tenantId });
        return toAutoReply(this.db.prepare('SELECT * FROM auto_replies WHERE id = ?').get(result.lastInsertRowid));
    }

    deleteAutoReply(id) {
        return this.db.prepare('DELETE FROM auto_replies WHERE id = ? AND tenant_id = ?')
            .run(id, this.tenantId).changes;
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

    getOptOuts() {
        return this.db.prepare('SELECT * FROM opt_outs WHERE tenant_id = ? ORDER BY opted_out_at DESC')
            .all(this.tenantId).map((row) => ({
            phone: row.phone,
            reason: row.reason,
            optedOutAt: row.opted_out_at,
        }));
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

function toAutoReply(row) {
    return {
        id: row.id,
        keyword: row.keyword,
        matchType: row.match_type,
        replyBody: row.reply_body,
        isActive: Boolean(row.is_active),
        cooldownSec: row.cooldown_sec,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
