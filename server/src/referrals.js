/**
 * Referrals: marketers who bring businesses to Wapzo and earn a commission on what those businesses pay.
 *
 * A marketer has a code (RAVI-42) and a link (/?ref=RAVI-42). A request sent from that link carries the code; when
 * the lead is accepted, the new business is tied to the marketer (one marketer per business: the first one wins).
 * The admin can also tie a business by hand. Every payment the admin records for that business earns a commission,
 * at the marketer's rate *then* (copied onto the row, so a later rate change never rewrites what was earned). A
 * payment removed again reverses its commission. Commissions wait as pending until the admin pays the marketer.
 *
 * Platform-wide like leads and plans: the root connection, never a tenant handle.
 */

import crypto from 'node:crypto';

import { utcNow } from './protocol.js';

export const REFERRALS_SCHEMA = `
CREATE TABLE IF NOT EXISTS referrers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    name             TEXT NOT NULL,
    email            TEXT NOT NULL DEFAULT '',
    phone            TEXT NOT NULL DEFAULT '',
    code             TEXT NOT NULL UNIQUE,
    commission_type  TEXT NOT NULL DEFAULT 'percent',  -- 'percent' of each payment | 'fixed' amount per payment
    commission_value REAL NOT NULL DEFAULT 10,
    status           TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'paused' (earns nothing new)
    note             TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
-- Which marketer brought a business. One per business: the first one wins.
CREATE TABLE IF NOT EXISTS referral_clients (
    tenant_id   INTEGER PRIMARY KEY,
    referrer_id INTEGER NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referral_clients_referrer ON referral_clients(referrer_id);
-- One row per payment earned on (or a minus row taking back one already paid out). The rate is a copy, not a link.
CREATE TABLE IF NOT EXISTS commissions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    referrer_id      INTEGER NOT NULL,
    tenant_id        INTEGER NOT NULL,
    ledger_id        INTEGER,                          -- the billing_ledger payment it was earned on
    trigger_amount   INTEGER NOT NULL,
    currency         TEXT NOT NULL DEFAULT 'INR',
    commission_type  TEXT NOT NULL,
    commission_value REAL NOT NULL,
    amount           INTEGER NOT NULL,                 -- whole units; below 0 for a take-back
    status           TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'paid' | 'reversed'
    note             TEXT NOT NULL DEFAULT '',
    payout_ref       TEXT NOT NULL DEFAULT '',
    paid_at          TEXT,
    created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commissions_referrer ON commissions(referrer_id, id);
CREATE INDEX IF NOT EXISTS idx_commissions_ledger ON commissions(ledger_id);
`;

/** The code a request came with, kept on the lead until it is accepted. */
export function migrateReferrals(db) {
    const cols = db.prepare('PRAGMA table_info(leads)').all().map((c) => c.name);
    if (cols.length && !cols.includes('referral_code')) db.exec("ALTER TABLE leads ADD COLUMN referral_code TEXT NOT NULL DEFAULT ''");
}

export const COMMISSION_TYPES = Object.freeze(['percent', 'fixed']);
const MAX_AMOUNT = 1e9;

export class ReferralError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** What a payment of `amount` earns: `value`% of it, or `value` flat. Whole units, like every amount here. */
export function commissionFor(amount, type, value) {
    if (type === 'percent') return Math.round((amount * value) / 100);
    if (type === 'fixed') return Math.round(value);
    throw new ReferralError('unknown commission type');
}

/** "ravi-42" → "RAVI-42"; null when it cannot be a code. */
export function cleanCode(value) {
    const code = String(value ?? '').trim().toUpperCase();
    return /^[A-Z0-9][A-Z0-9-]{2,19}$/.test(code) ? code : null;
}

const text = (value, max) => String(value ?? '').trim().slice(0, max);

const toReferrer = (row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    code: row.code,
    commissionType: row.commission_type,
    commissionValue: row.commission_value,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
    clients: row.clients ?? 0,
    pending: row.pending ?? 0,
    paid: row.paid ?? 0,
});

const toCommission = (row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name ?? null,
    triggerAmount: row.trigger_amount,
    currency: row.currency,
    commissionType: row.commission_type,
    commissionValue: row.commission_value,
    amount: row.amount,
    status: row.status,
    note: row.note,
    payoutRef: row.payout_ref,
    paidAt: row.paid_at,
    createdAt: row.created_at,
});

/** Totals ride along with each marketer: businesses brought, still to pay, paid so far. */
const WITH_TOTALS = `
SELECT r.*,
    (SELECT COUNT(*) FROM referral_clients c WHERE c.referrer_id = r.id) AS clients,
    (SELECT COALESCE(SUM(amount), 0) FROM commissions m WHERE m.referrer_id = r.id AND m.status = 'pending') AS pending,
    (SELECT COALESCE(SUM(amount), 0) FROM commissions m WHERE m.referrer_id = r.id AND m.status = 'paid') AS paid
FROM referrers r`;

export class Referrals {
    /** @param {import('./db.js').Database} database the platform handle. */
    constructor(database) {
        this.db = database.db;
    }

    list() {
        return this.db.prepare(`${WITH_TOTALS} ORDER BY r.id DESC`).all().map(toReferrer);
    }

    get(id) {
        const row = this.db.prepare(`${WITH_TOTALS} WHERE r.id = ?`).get(Number(id));
        return row ? toReferrer(row) : null;
    }

    /** An active marketer by code, for a request's `ref`; null for an unknown or paused one. */
    byCode(code) {
        const clean = cleanCode(code);
        const row = clean && this.db.prepare("SELECT id FROM referrers WHERE code = ? AND status = 'active'").get(clean);
        return row ? this.get(row.id) : null;
    }

    /** Validates the admin's form; `partial` keeps what an update leaves out. */
    #clean(input, current = null) {
        const pick = (key, fallback) => (input[key] === undefined ? fallback : input[key]);
        const name = text(pick('name', current?.name), 120);
        const email = text(pick('email', current?.email), 254).toLowerCase();
        const phone = text(pick('phone', current?.phone), 32);
        const type = pick('commissionType', current?.commissionType ?? 'percent');
        const value = Number(pick('commissionValue', current?.commissionValue ?? 10));
        const status = pick('status', current?.status ?? 'active');
        if (!name) throw new ReferralError('Enter the marketer\'s name.');
        if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ReferralError('Enter a valid email address.');
        if (phone && !/^\+?[\d\s()-]{6,32}$/.test(phone)) throw new ReferralError('Enter a valid phone number.');
        if (!COMMISSION_TYPES.includes(type)) throw new ReferralError('Choose a percentage or a fixed amount.');
        if (type === 'percent' && !(value > 0 && value <= 100)) throw new ReferralError('A percentage is more than 0 and at most 100.');
        if (type === 'fixed' && !(Number.isInteger(value) && value > 0 && value <= MAX_AMOUNT)) {
            throw new ReferralError('A fixed amount is a whole number above 0.');
        }
        if (!['active', 'paused'].includes(status)) throw new ReferralError('status must be active or paused');
        return { name, email, phone, type, value: Math.round(value * 100) / 100, status, note: text(pick('note', current?.note), 500) };
    }

    /** A code from the name ("Ravi Kumar" → RAVI-42) when none is typed, tried until one is free. */
    #code(wanted, name, exceptId = null) {
        const taken = (code) => this.db.prepare('SELECT id FROM referrers WHERE code = ? AND id != ?').get(code, exceptId ?? 0);
        if (wanted !== undefined && wanted !== null && String(wanted).trim() !== '') {
            const code = cleanCode(wanted);
            if (!code) throw new ReferralError('A code is 3 to 20 letters, digits or dashes.');
            if (taken(code)) throw new ReferralError('That code is already in use.', 409);
            return code;
        }
        const stem = name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'MK';
        for (;;) {
            const code = `${stem}-${crypto.randomInt(10, 1000)}`;
            if (!taken(code)) return code;
        }
    }

    create(input = {}) {
        const c = this.#clean(input);
        const code = this.#code(input.code, c.name);
        const now = utcNow();
        const info = this.db.prepare(
            `INSERT INTO referrers (name, email, phone, code, commission_type, commission_value, status, note, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(c.name, c.email, c.phone, code, c.type, c.value, c.status, c.note, now, now);
        return this.get(Number(info.lastInsertRowid));
    }

    /** A new rate applies to payments from now on; commissions already earned keep theirs. */
    update(id, input = {}) {
        const current = this.get(id);
        if (!current) throw new ReferralError('marketer not found', 404);
        const c = this.#clean(input, current);
        const code = input.code === undefined ? current.code : this.#code(input.code, c.name, current.id);
        this.db.prepare(
            `UPDATE referrers SET name = ?, email = ?, phone = ?, code = ?, commission_type = ?, commission_value = ?,
                 status = ?, note = ?, updated_at = ? WHERE id = ?`)
            .run(c.name, c.email, c.phone, code, c.type, c.value, c.status, c.note, utcNow(), current.id);
        return this.get(current.id);
    }

    /** The marketer who brought a business; null for none. */
    forTenant(tenantId) {
        const row = this.db.prepare('SELECT referrer_id FROM referral_clients WHERE tenant_id = ?').get(Number(tenantId));
        return row ? this.get(row.referrer_id) : null;
    }

    /** Tie a business to a marketer. The first one wins: false when another already has it. */
    attach(tenantId, referrerId) {
        if (!this.get(referrerId)) throw new ReferralError('marketer not found', 404);
        const info = this.db.prepare('INSERT OR IGNORE INTO referral_clients (tenant_id, referrer_id, created_at) VALUES (?, ?, ?)')
            .run(Number(tenantId), Number(referrerId), utcNow());
        return info.changes > 0 || this.forTenant(tenantId)?.id === Number(referrerId);
    }

    /**
     * The admin typed who brought a business (New tenant, Tenant settings): a marketer by code or name, made the
     * first time a name is typed (at the default rate, changed later in Referrals). '' unties it. Unlike a link's
     * first-wins rule, the admin's answer replaces the one before. Returns { referrer, changed }.
     */
    setForTenant(tenantId, typed) {
        const current = this.forTenant(tenantId);
        const value = text(typed, 120);
        if (!value) {
            if (current) this.detach(tenantId, current.id);
            return { referrer: null, changed: Boolean(current), previous: current };
        }
        const found = this.db.prepare('SELECT id FROM referrers WHERE code = ? OR lower(name) = lower(?) ORDER BY id LIMIT 1')
            .get(cleanCode(value) ?? '', value);
        const referrer = found ? this.get(found.id) : this.create({ name: value });
        if (current?.id === referrer.id) return { referrer, changed: false, previous: current };
        this.db.prepare('DELETE FROM referral_clients WHERE tenant_id = ?').run(Number(tenantId));
        this.attach(tenantId, referrer.id);
        return { referrer, changed: true, previous: current, created: !found };
    }

    /** Untie it: later payments earn nothing; what was earned stays. */
    detach(tenantId, referrerId) {
        return this.db.prepare('DELETE FROM referral_clients WHERE tenant_id = ? AND referrer_id = ?')
            .run(Number(tenantId), Number(referrerId)).changes > 0;
    }

    /** Businesses a marketer brought, newest first. */
    clients(referrerId) {
        return this.db.prepare(
            `SELECT c.tenant_id, c.created_at, t.name, t.slug, t.status FROM referral_clients c
             JOIN tenants t ON t.id = c.tenant_id WHERE c.referrer_id = ? ORDER BY c.created_at DESC`)
            .all(Number(referrerId))
            .map((r) => ({ tenantId: r.tenant_id, name: r.name, slug: r.slug, status: r.status, since: r.created_at }));
    }

    commissions(referrerId) {
        return this.db.prepare(
            `SELECT m.*, t.name AS tenant_name FROM commissions m LEFT JOIN tenants t ON t.id = m.tenant_id
             WHERE m.referrer_id = ? ORDER BY m.id DESC`)
            .all(Number(referrerId)).map(toCommission);
    }

    /** A payment was recorded: its commission, at the marketer's rate now; null when nobody earns on it. */
    earn(tenantId, payment) {
        const ref = this.forTenant(tenantId);
        if (!ref || ref.status !== 'active') return null;
        const amount = commissionFor(payment.amount, ref.commissionType, ref.commissionValue);
        if (amount <= 0) return null;
        const info = this.db.prepare(
            `INSERT INTO commissions (referrer_id, tenant_id, ledger_id, trigger_amount, currency, commission_type,
                 commission_value, amount, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(ref.id, Number(tenantId), payment.id, payment.amount, payment.currency, ref.commissionType,
                ref.commissionValue, amount, utcNow());
        return { referrer: ref, commission: this.#commission(info.lastInsertRowid) };
    }

    /**
     * A payment was removed: its commission is reversed. One not yet paid out just stops counting; one already paid
     * out is taken back by a minus row, which the next payout nets off.
     */
    reverse(ledgerId) {
        const rows = this.db.prepare("SELECT * FROM commissions WHERE ledger_id = ? AND amount > 0 AND status != 'reversed'")
            .all(Number(ledgerId));
        for (const row of rows) {
            this.db.prepare("UPDATE commissions SET status = 'reversed', note = 'Payment removed' WHERE id = ?").run(row.id);
            if (row.status === 'paid') {
                this.db.prepare(
                    `INSERT INTO commissions (referrer_id, tenant_id, ledger_id, trigger_amount, currency, commission_type,
                         commission_value, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .run(row.referrer_id, row.tenant_id, row.ledger_id, row.trigger_amount, row.currency, row.commission_type,
                        row.commission_value, -row.amount, 'Taken back: the payment was removed after payout', utcNow());
            }
        }
        return rows.map((r) => r.referrer_id);
    }

    /** Pay a marketer everything pending, take-backs netted off. `reference` is the UPI or bank reference. */
    payout(referrerId, { reference = '' } = {}) {
        const ref = this.get(referrerId);
        if (!ref) throw new ReferralError('marketer not found', 404);
        if (ref.pending <= 0) throw new ReferralError('Nothing is waiting to be paid.', 409);
        const now = utcNow();
        this.db.prepare("UPDATE commissions SET status = 'paid', paid_at = ?, payout_ref = ? WHERE referrer_id = ? AND status = 'pending'")
            .run(now, text(reference, 120), ref.id);
        return { amount: ref.pending, referrer: this.get(ref.id) };
    }

    #commission(id) {
        return toCommission(this.db.prepare('SELECT * FROM commissions WHERE id = ?').get(Number(id)));
    }
}
