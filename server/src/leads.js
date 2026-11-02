/**
 * Requests for an account from the public site: the landing page's form and the sign-in page's
 * "no account yet" dialog. Accounts are still issued by the platform; a lead is what a super admin
 * reads before converting it into a tenant (app.js, POST /api/admin/leads/:leadId/convert).
 *
 * Platform-wide like plans, so it uses the root connection and never a tenant handle.
 */

import { utcNow } from './protocol.js';

export const LEAD_STATUSES = Object.freeze(['new', 'converted', 'dismissed']);

export class LeadError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const text = (value, max) => String(value ?? '').trim().slice(0, max);

const toLead = (row) => ({
    id: row.id,
    name: row.name,
    business: row.business,
    email: row.email,
    phone: row.phone,
    message: row.message,
    source: row.source,
    status: row.status,
    tenantId: row.tenant_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
});

export class Leads {
    constructor(database) {
        this.db = database.db;
    }

    /** Validates what a stranger typed; the only trust boundary here. */
    create({ name, business, email, phone, message, source, ip = '' } = {}) {
        const clean = {
            name: text(name, 120),
            business: text(business, 160),
            email: text(email, 254).toLowerCase(),
            phone: text(phone, 32),
            message: text(message, 2000),
            source: source === 'login' ? 'login' : 'landing',
        };
        if (!clean.name) throw new LeadError('Tell us your name.');
        if (!clean.business) throw new LeadError('Tell us the business name.');
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(clean.email)) throw new LeadError('Enter a valid email address.');
        if (clean.phone && !/^\+?[\d\s()-]{6,32}$/.test(clean.phone)) throw new LeadError('Enter a valid phone number.');
        // One open request per email: a second submit refreshes it instead of stacking duplicates.
        const open = this.db.prepare("SELECT id FROM leads WHERE email = ? AND status = 'new'").get(clean.email);
        const now = utcNow();
        if (open) {
            this.db.prepare(`UPDATE leads SET name = ?, business = ?, phone = ?, message = ?, source = ?, ip = ?, updated_at = ?
                             WHERE id = ?`)
                .run(clean.name, clean.business, clean.phone, clean.message, clean.source, String(ip), now, open.id);
            return this.get(open.id);
        }
        const info = this.db.prepare(`INSERT INTO leads (name, business, email, phone, message, source, ip, created_at, updated_at)
                                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(clean.name, clean.business, clean.email, clean.phone, clean.message, clean.source, String(ip), now, now);
        return this.get(Number(info.lastInsertRowid));
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(id));
        return row ? toLead(row) : null;
    }

    /** Newest first; `status` narrows to one of LEAD_STATUSES. Counts per status ride along for the tabs. */
    list({ status = null } = {}) {
        const rows = LEAD_STATUSES.includes(status)
            ? this.db.prepare('SELECT * FROM leads WHERE status = ? ORDER BY id DESC').all(status)
            : this.db.prepare('SELECT * FROM leads ORDER BY id DESC').all();
        const counts = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0]));
        for (const { status: s, n } of this.db.prepare('SELECT status, COUNT(*) AS n FROM leads GROUP BY status').all()) counts[s] = n;
        return { leads: rows.map(toLead), counts };
    }

    /** Dismiss or reopen. A converted lead stays converted: its tenant exists. */
    setStatus(id, status) {
        const lead = this.get(id);
        if (!lead) throw new LeadError('lead not found', 404);
        if (status !== 'new' && status !== 'dismissed') throw new LeadError('status must be new or dismissed');
        if (lead.status === 'converted') throw new LeadError('this lead is already a tenant', 409);
        this.db.prepare('UPDATE leads SET status = ?, updated_at = ? WHERE id = ?').run(status, utcNow(), lead.id);
        return this.get(lead.id);
    }

    markConverted(id, tenantId) {
        this.db.prepare("UPDATE leads SET status = 'converted', tenant_id = ?, updated_at = ? WHERE id = ?")
            .run(Number(tenantId), utcNow(), Number(id));
        return this.get(id);
    }
}
