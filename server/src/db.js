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
`;

export class Database {
    constructor(dbPath = DB_PATH) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.path = dbPath;
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
        this.db.exec(SCHEMA);
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
