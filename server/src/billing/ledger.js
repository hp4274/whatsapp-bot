/**
 * What each business owes and has paid: one row per charge (a plan put on or renewed, a top-up) and per payment
 * the super admin records. A charge stays unpaid until payments cover it; the balance is charges minus payments.
 * Amounts are whole units of the plan's currency, like plan prices.
 */

import { BillingError } from './store.js';

/** Charges add to what is owed; a payment takes it off. */
export const LEDGER_KINDS = Object.freeze(['plan', 'topup', 'payment']);

/** How a payment came in. */
export const PAYMENT_METHODS = Object.freeze(['upi', 'bank', 'cash']);

const MAX_AMOUNT = 1e9;

/** A whole amount above 0, or a 400. */
export function amountOr400(value, what = 'amount') {
    const n = Math.round(Number(value));
    if (value === null || value === undefined || value === '' || !Number.isFinite(n) || n <= 0 || n > MAX_AMOUNT) {
        throw new BillingError(`${what} must be more than 0`);
    }
    return n;
}

const toEntry = (row) => ({
    id: row.id,
    kind: row.kind,
    amount: row.amount,
    currency: row.currency,
    note: row.note,
    method: row.method || null,
    at: row.at,
    createdBy: row.created_by,
    createdAt: row.created_at,
});

/** Charged, paid and still due from a business's rows. */
export function totals(rows) {
    let plan = 0;
    let topup = 0;
    let paid = 0;
    for (const r of rows) {
        if (r.kind === 'plan') plan += r.amount;
        else if (r.kind === 'topup') topup += r.amount;
        else paid += r.amount;
    }
    return { planCharged: plan, topupCharged: topup, charged: plan + topup, paid, due: Math.max(0, plan + topup - paid) };
}

export class Ledger {
    /** @param {import('../db.js').Database} database the platform handle (not tenant-scoped: the admin reads all). */
    constructor(database) {
        this.db = database.db;
    }

    /** Newest first: by day, then in the order entered (a payment dated today at noon is still the latest). */
    entries(tenantId) {
        return this.db.prepare('SELECT * FROM billing_ledger WHERE tenant_id = ? ORDER BY substr(at, 1, 10) DESC, id DESC')
            .all(Number(tenantId)).map(toEntry);
    }

    add(tenantId, { kind, amount, currency, note = '', method = '', at = null, userId = null }) {
        if (!LEDGER_KINDS.includes(kind)) throw new BillingError('unknown ledger entry');
        if (kind === 'payment' && !PAYMENT_METHODS.includes(method)) throw new BillingError('Choose how it was paid: UPI, bank transfer or cash.');
        const value = amountOr400(amount);
        const when = at ? new Date(at) : new Date();
        if (Number.isNaN(when.getTime())) throw new BillingError('date must be a date');
        const now = new Date().toISOString();
        const info = this.db.prepare(
            `INSERT INTO billing_ledger (tenant_id, kind, amount, currency, note, method, at, created_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(Number(tenantId), kind, value, String(currency || 'INR'), String(note ?? '').trim().slice(0, 200),
                kind === 'payment' ? method : '', when.toISOString(), userId, now);
        return toEntry(this.db.prepare('SELECT * FROM billing_ledger WHERE id = ?').get(info.lastInsertRowid));
    }

    /** Whether the plan was already charged since `since` (the current period's start). */
    planChargedSince(tenantId, since) {
        return Boolean(this.db.prepare("SELECT 1 FROM billing_ledger WHERE tenant_id = ? AND kind = 'plan' AND at >= ?")
            .get(Number(tenantId), new Date(since).toISOString()));
    }

    remove(tenantId, entryId) {
        const row = this.db.prepare('SELECT * FROM billing_ledger WHERE id = ? AND tenant_id = ?').get(Number(entryId), Number(tenantId));
        if (!row) throw new BillingError('entry not found', 404);
        this.db.prepare('DELETE FROM billing_ledger WHERE id = ?').run(row.id);
        return toEntry(row);
    }

    /** One business: its rows newest first and the totals. */
    statement(tenantId) {
        const entries = this.entries(tenantId);
        return { entries, ...totals(entries) };
    }

    /** Every business's totals and last payment, by tenant id, for the Payments page. */
    all() {
        const out = new Map();
        const rows = this.db.prepare(
            `SELECT tenant_id, kind, SUM(amount) AS amount, MAX(at) AS last FROM billing_ledger GROUP BY tenant_id, kind`).all();
        const byTenant = Map.groupBy(rows, (r) => r.tenant_id);
        for (const [id, list] of byTenant) {
            out.set(id, { ...totals(list), lastPaidAt: list.find((r) => r.kind === 'payment')?.last ?? null });
        }
        return out;
    }
}
