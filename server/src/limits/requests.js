/**
 * A business asking for more of a limit for a while ("20 templates for 30 days"), and the platform admin's answer.
 * One request holds several asks. Approving one applies every ask at once and remembers what each was before;
 * when an ask's time is up, it goes back to that, unless an admin has changed it since (then the admin's value
 * stays). Applying and reverting are the caller's (app.js), which owns the business's limits and anti-ban.
 */

import { utcNow } from '../protocol.js';

export const LIMIT_REQUESTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS limit_requests (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id    INTEGER NOT NULL,
    -- [{ key, value, days, previous?, expiresAt?, reverted? }]: days 0 = until changed.
    items        TEXT NOT NULL,
    note         TEXT NOT NULL DEFAULT '',
    status       TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'approved' | 'declined'
    reason       TEXT NOT NULL DEFAULT '',
    requested_by INTEGER,
    decided_by   INTEGER,
    decided_at   TEXT,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_limit_requests_tenant ON limit_requests(tenant_id, id);
`;

/** What a business can ask more of, as it reads in the forms. */
export const REQUESTABLE = Object.freeze({
    maxChannels: 'WhatsApp numbers',
    maxUsers: 'Team members',
    maxTemplates: 'Templates',
    messagesPerMonth: 'Messages per month',
    dailyLimit: 'Messages per day, per number',
});

/** How long an increase lasts, in days; 0 = until changed. */
export const DURATIONS = Object.freeze([7, 30, 90, 365, 0]);

export class LimitRequestError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const toRequest = (row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    items: JSON.parse(row.items).map((i) => ({ ...i, label: REQUESTABLE[i.key] ?? i.key })),
    note: row.note,
    status: row.status,
    reason: row.reason,
    requestedBy: row.requested_by,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
});

export class LimitRequests {
    /** @param {import('node:sqlite').DatabaseSync} raw the platform-wide connection */
    constructor(raw) {
        this.db = raw;
    }

    /** A business's asks, checked: 1 to 10, each a known limit once, a whole number above 0, a listed duration. */
    create(tenantId, userId, { items, note = '' } = {}) {
        const list = Array.isArray(items) ? items : [];
        if (!list.length) throw new LimitRequestError('Ask for at least one limit.');
        if (list.length > 10) throw new LimitRequestError('Ask for at most 10 limits at once.');
        const seen = new Set();
        const clean = list.map((item) => {
            const key = String(item?.key ?? '');
            if (!(key in REQUESTABLE)) throw new LimitRequestError('Choose which limit to increase.');
            if (seen.has(key)) throw new LimitRequestError(`${REQUESTABLE[key]} is asked for twice.`);
            seen.add(key);
            const value = Number(item?.value);
            if (!Number.isInteger(value) || value < 1 || value > 1e9) {
                throw new LimitRequestError(`Enter the ${REQUESTABLE[key].toLowerCase()} you need as a whole number.`);
            }
            const days = Number(item?.days);
            if (!DURATIONS.includes(days)) throw new LimitRequestError('Choose how long you need it.');
            return { key, value, days };
        });
        const now = utcNow();
        const info = this.db.prepare(
            `INSERT INTO limit_requests (tenant_id, items, note, requested_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`)
            .run(Number(tenantId), JSON.stringify(clean), String(note ?? '').trim().slice(0, 500), userId ?? null, now, now);
        return this.get(tenantId, Number(info.lastInsertRowid));
    }

    list(tenantId) {
        return this.db.prepare('SELECT * FROM limit_requests WHERE tenant_id = ? ORDER BY id DESC LIMIT 50')
            .all(Number(tenantId)).map(toRequest);
    }

    /** How many of one business's requests wait for an answer. */
    pendingCount(tenantId) {
        return this.db.prepare("SELECT COUNT(*) AS n FROM limit_requests WHERE tenant_id = ? AND status = 'pending'").get(Number(tenantId)).n;
    }

    /** Every business's requests still waiting for an answer, oldest first (the admin's notifications). */
    pending() {
        return this.db.prepare(
            `SELECT r.*, t.name AS tenant_name FROM limit_requests r JOIN tenants t ON t.id = r.tenant_id
             WHERE r.status = 'pending' AND t.status != 'archived' ORDER BY r.id`)
            .all().map((row) => ({ ...toRequest(row), tenantName: row.tenant_name }));
    }

    get(tenantId, id) {
        const row = this.db.prepare('SELECT * FROM limit_requests WHERE id = ? AND tenant_id = ?').get(Number(id), Number(tenantId));
        return row ? toRequest(row) : null;
    }

    /**
     * Approve (`apply(item)` sets each ask and returns what it was before) or decline. Only a pending request.
     * @param {(item: { key: string, value: number }) => unknown} [apply]
     */
    decide(tenantId, id, approve, { userId = null, reason = '', apply, now = new Date() } = {}) {
        const request = this.get(tenantId, id);
        if (!request) throw new LimitRequestError('request not found', 404);
        if (request.status !== 'pending') throw new LimitRequestError('This request was already answered.', 409);
        const items = request.items.map(({ label, ...item }) => {
            if (!approve) return item;
            const previous = apply(item);
            return {
                ...item,
                previous: previous === undefined ? null : previous,
                expiresAt: item.days ? new Date(now.getTime() + item.days * 864e5).toISOString() : null,
                reverted: false,
            };
        });
        this.db.prepare(`UPDATE limit_requests SET items = ?, status = ?, reason = ?, decided_by = ?, decided_at = ?,
                         updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(items), approve ? 'approved' : 'declined', String(reason ?? '').trim().slice(0, 500),
                userId, utcNow(), utcNow(), request.id);
        return this.get(tenantId, id);
    }

    /**
     * Every approved ask whose time is up and not yet gone back: `revert(tenantId, item)` restores it, and it is
     * marked done either way (a revert that cannot apply is not retried every hour). Returns how many.
     */
    expire(revert, now = new Date()) {
        let count = 0;
        const rows = this.db.prepare("SELECT * FROM limit_requests WHERE status = 'approved'").all();
        for (const row of rows) {
            const items = JSON.parse(row.items);
            let changed = false;
            for (const item of items) {
                if (item.reverted || !item.expiresAt || Date.parse(item.expiresAt) > now.getTime()) continue;
                try {
                    revert(row.tenant_id, item);
                } catch {
                    // the business may be gone; nothing to put back
                }
                item.reverted = true;
                changed = true;
                count += 1;
            }
            if (changed) this.db.prepare('UPDATE limit_requests SET items = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(items), utcNow(), row.id);
        }
        return count;
    }
}
