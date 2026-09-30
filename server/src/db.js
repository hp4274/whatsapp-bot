/**
 * SQLite persistence, on node:sqlite - built into Node, so there is no native
 * module to compile and no ORM to learn.  Same schema as the Python app.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DB_PATH } from './config.js';
import { STATUS_RANK, SUCCESS_STATUSES, Status, utcNow } from './protocol.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    message_id   TEXT PRIMARY KEY,
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

CREATE TABLE IF NOT EXISTS inbound_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    TEXT UNIQUE,
    sender        TEXT NOT NULL,
    sender_name   TEXT DEFAULT '',
    body          TEXT NOT NULL,
    media_url     TEXT,
    media_type    TEXT,
    replied_rule  TEXT DEFAULT NULL,
    is_read       INTEGER DEFAULT 0,
    received_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbound_sender ON inbound_messages(sender);
CREATE INDEX IF NOT EXISTS idx_inbound_received_at ON inbound_messages(received_at);

CREATE TABLE IF NOT EXISTS opt_outs (
    phone         TEXT PRIMARY KEY,
    reason        TEXT DEFAULT 'user_requested',
    opted_out_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auto_replies (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword       TEXT NOT NULL,
    match_type    TEXT NOT NULL,
    reply_body    TEXT NOT NULL,
    is_active     INTEGER DEFAULT 1,
    cooldown_sec  INTEGER DEFAULT 300,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
`;

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

export class Database {
    constructor(dbPath = DB_PATH) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.path = dbPath;
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec(SCHEMA);
        this.#seedAutoReplies();
    }

    close() {
        this.db.close();
    }

    insert(record) {
        const now = utcNow();
        const row = {
            message_id: record.messageId,
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
            INSERT INTO messages (message_id, recipient, message, status, attempt, provider_id,
                                  error, name, campaign_id, created_at, updated_at)
            VALUES (:message_id, :recipient, :message, :status, :attempt, :provider_id,
                    :error, :name, :campaign_id, :created_at, :updated_at)
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
        args.push(messageId);
        this.db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE message_id = ?`).run(...args);
    }

    /**
     * Apply a delivery receipt, refusing to downgrade: a "delivered" arriving
     * after a "read" must not win.  Returns true when the row changed.
     */
    applyReceipt(providerId, status, error = null) {
        const row = this.db.prepare(
            'SELECT message_id, status FROM messages WHERE provider_id = ?').get(providerId);
        if (!row) return false;
        const current = STATUS_RANK[row.status] ?? 0;
        const incoming = STATUS_RANK[status] ?? 0;
        if (incoming <= current && status !== Status.FAILED) return false;
        this.db.prepare('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE message_id = ?')
            .run(status, error, utcNow(), row.message_id);
        return true;
    }

    get(messageId) {
        const row = this.db.prepare('SELECT * FROM messages WHERE message_id = ?').get(messageId);
        return row ? toRecord(row) : null;
    }

    getByProviderId(providerId) {
        const row = this.db.prepare('SELECT * FROM messages WHERE provider_id = ?').get(providerId);
        return row ? toRecord(row) : null;
    }

    history({ limit = 1000, status = null, recipient = null, campaignId = null } = {}) {
        const clauses = [];
        const args = [];
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
        if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
        sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
        args.push(limit);
        return this.db.prepare(sql).all(...args).map(toRecord);
    }

    /**
     * (row count, latest update) for a filter: the cheap "did anything
     * change?" question, so a client never re-fetches rows it already has.
     */
    historySignature({ status = null, recipient = null } = {}) {
        const clauses = [];
        const args = [];
        if (status) {
            clauses.push('status = ?');
            args.push(status);
        }
        if (recipient) {
            clauses.push('recipient LIKE ?');
            args.push(`%${recipient}%`);
        }
        let sql = "SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS last FROM messages";
        if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
        const row = this.db.prepare(sql).get(...args);
        return { count: row.n, last: row.last };
    }

    countsByStatus(campaignId = null) {
        let sql = 'SELECT status, COUNT(*) AS n FROM messages';
        const args = [];
        if (campaignId) {
            sql += ' WHERE campaign_id = ?';
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
        const row = this.db.prepare(
            `SELECT COUNT(*) AS n FROM messages
             WHERE status IN (${placeholders}) AND created_at >= ? AND created_at < ?`
        ).get(...SUCCESS_STATUSES, startIso, endIso);
        return row.n;
    }

    /**
     * Numbers that already received a real message (SENT/DELIVERED/READ).
     * SANDBOX is excluded: a local test send must not stop the real one.
     */
    sentRecipients() {
        const placeholders = SUCCESS_STATUSES.map(() => '?').join(',');
        const rows = this.db.prepare(
            `SELECT DISTINCT recipient FROM messages WHERE status IN (${placeholders})`
        ).all(...SUCCESS_STATUSES);
        return new Set(rows.map((r) => r.recipient));
    }

    insertInbound(record) {
        const now = utcNow();
        const row = {
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
                (message_id, sender, sender_name, body, media_url, media_type, replied_rule, received_at)
            VALUES
                (:message_id, :sender, :sender_name, :body, :media_url, :media_type, :replied_rule, :received_at)
        `).run(row);
        const saved = this.db.prepare('SELECT * FROM inbound_messages WHERE message_id = ?').get(row.message_id);
        return toInboundRecord(saved);
    }

    markInboundReplied(messageId, ruleKeyword) {
        this.db.prepare('UPDATE inbound_messages SET replied_rule = ? WHERE message_id = ?')
            .run(ruleKeyword, messageId);
    }

    getInboundMessages({ sender = null, limit = 100 } = {}) {
        const args = [];
        let sql = 'SELECT * FROM inbound_messages';
        if (sender) {
            sql += ' WHERE sender = ?';
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
                    ORDER BY latest.received_at DESC, latest.id DESC LIMIT 1) AS last_body
            FROM inbound_messages
            GROUP BY sender
            ORDER BY last_received_at DESC
        `).all().map((row) => ({
            sender: row.sender,
            senderName: row.sender_name ?? '',
            messageCount: row.message_count,
            unreadCount: row.unread_count,
            lastReceivedAt: row.last_received_at,
            lastBody: row.last_body ?? '',
        }));
    }

    markInboundRead(sender) {
        const result = this.db.prepare('UPDATE inbound_messages SET is_read = 1 WHERE sender = ?')
            .run(sender);
        return result.changes;
    }

    getActiveAutoReplies() {
        return this.db.prepare(`
            SELECT * FROM auto_replies
            WHERE is_active = 1
            ORDER BY CASE match_type
                WHEN 'EXACT' THEN 1
                WHEN 'CONTAINS' THEN 2
                WHEN 'REGEX' THEN 3
                WHEN 'FALLBACK' THEN 4
                ELSE 5
            END, id ASC
        `).all().map(toAutoReply);
    }

    getAutoReplies() {
        return this.db.prepare('SELECT * FROM auto_replies ORDER BY id ASC').all().map(toAutoReply);
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
                    is_active = :is_active, cooldown_sec = :cooldown_sec, updated_at = :updated_at
                WHERE id = :id
            `).run({ ...row, id });
            return toAutoReply(this.db.prepare('SELECT * FROM auto_replies WHERE id = ?').get(id));
        }
        const result = this.db.prepare(`
            INSERT INTO auto_replies
                (keyword, match_type, reply_body, is_active, cooldown_sec, created_at, updated_at)
            VALUES
                (:keyword, :match_type, :reply_body, :is_active, :cooldown_sec, :created_at, :updated_at)
        `).run(row);
        return toAutoReply(this.db.prepare('SELECT * FROM auto_replies WHERE id = ?').get(result.lastInsertRowid));
    }

    deleteAutoReply(id) {
        return this.db.prepare('DELETE FROM auto_replies WHERE id = ?').run(id).changes;
    }

    addOptOut(phone, reason = 'user_requested') {
        const row = { phone, reason, opted_out_at: utcNow() };
        this.db.prepare(`
            INSERT INTO opt_outs (phone, reason, opted_out_at)
            VALUES (:phone, :reason, :opted_out_at)
            ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, opted_out_at = excluded.opted_out_at
        `).run(row);
        return row;
    }

    removeOptOut(phone) {
        return this.db.prepare('DELETE FROM opt_outs WHERE phone = ?').run(phone).changes;
    }

    getAllOptOuts() {
        return this.db.prepare('SELECT phone FROM opt_outs ORDER BY phone ASC').all().map((row) => row.phone);
    }

    getOptOuts() {
        return this.db.prepare('SELECT * FROM opt_outs ORDER BY opted_out_at DESC').all().map((row) => ({
            phone: row.phone,
            reason: row.reason,
            optedOutAt: row.opted_out_at,
        }));
    }

    #seedAutoReplies() {
        const count = this.db.prepare('SELECT COUNT(*) AS n FROM auto_replies').get().n;
        if (count > 0) return;
        for (const rule of DEFAULT_AUTO_REPLIES) this.saveAutoReply(rule);
    }
}

function toRecord(row) {
    return {
        messageId: row.message_id,
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
