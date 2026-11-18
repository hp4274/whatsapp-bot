/**
 * Payment reminders' dues ledger: every sheet row imported or sent is kept as a `payment` business object
 * (objects/types.js), so the page lists what is still owed, reminders go out on their own until it is paid, and a
 * customer's "PAID" pauses them. The sheet parser and the message text are in paymentReminders.js.
 *
 * A due is keyed by phone + invoice (phone + due date when the sheet has no invoice column), stored as the
 * object's reference, so importing the same sheet again updates the dues instead of doubling them.
 */

import express from 'express';

import { ObjectError } from './objects/types.js';
import { ObjectStore } from './objects/store.js';
import { amountValue, buildPaymentReminderMessage, DEFAULT_PAYMENT_REMINDER_TEMPLATE } from './paymentReminders.js';
import { ruleCap } from './policy/modules.js';
import { deliver, listAll, localNow } from './school/routes.js';
import { moneyIn, upiLink } from './shop/bot.js';
import { ownerAlert } from './moduleSweeps.js';

export const OPEN = Object.freeze(['pending', 'overdue']);
/** What a customer may write to say they have paid (the shop's own words; it runs first and keeps its own). */
const PAID = new Set(['PAID', 'PAYMENTDONE', 'DONEPAYMENT', 'PAYED', 'DONE']);
/** Automatic reminders wait for the business day: a 00:01 "you owe us" reads as a bill collector. */
const SEND_FROM = '10:00';

export const DEFAULT_DUE_SETTINGS = Object.freeze({
    template: DEFAULT_PAYMENT_REMINDER_TEMPLATE,
    upiId: '',
    payeeName: '',
    currency: 'INR',
    auto: false,
    daysBefore: 2,
    onDueDay: true,
    everyDays: 3,
    maxFollowUps: 3,
});

const TABLES = `
CREATE TABLE IF NOT EXISTS payment_reminder_config (
    tenant_id   INTEGER PRIMARY KEY,
    settings    TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_reminder_usage (
    tenant_id   INTEGER NOT NULL,
    month       TEXT NOT NULL,
    sent        INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, month)
);
`;

export class DueError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const int = (value, min, max, name) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) throw new DueError(`${name} must be a whole number from ${min} to ${max}`);
    return n;
};

/** A business's reminder settings and its monthly count, per tenant (shared by every number). */
export class DueStore {
    /** @param {import('./db.js').Database} database a tenant- or channel-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.db.exec(TABLES);
    }

    settings() {
        const row = this.db.prepare('SELECT settings FROM payment_reminder_config WHERE tenant_id = ?').get(this.tenantId);
        let saved = {};
        try { saved = row ? JSON.parse(row.settings) : {}; } catch { /* a broken row reads as the defaults */ }
        return { ...DEFAULT_DUE_SETTINGS, ...saved };
    }

    saveSettings(patch = {}) {
        const next = { ...this.settings() };
        if (patch.template !== undefined) {
            const text = String(patch.template ?? '').trim();
            if (text.length > 1000) throw new DueError('The message can be up to 1000 characters.');
            next.template = text || DEFAULT_PAYMENT_REMINDER_TEMPLATE;
        }
        if (patch.upiId !== undefined) {
            const upi = String(patch.upiId ?? '').trim();
            if (upi && !/^[\w.-]{2,64}@[\w.-]{2,64}$/.test(upi)) throw new DueError('Enter a UPI ID like name@okbank.');
            next.upiId = upi;
        }
        if (patch.payeeName !== undefined) next.payeeName = String(patch.payeeName ?? '').trim().slice(0, 60);
        if (patch.auto !== undefined) next.auto = patch.auto === true;
        if (patch.onDueDay !== undefined) next.onDueDay = patch.onDueDay === true;
        if (patch.daysBefore !== undefined) next.daysBefore = int(patch.daysBefore, 0, 30, 'Days before');
        if (patch.everyDays !== undefined) next.everyDays = int(patch.everyDays, 0, 60, 'Days between follow-ups');
        if (patch.maxFollowUps !== undefined) next.maxFollowUps = int(patch.maxFollowUps, 0, 10, 'Follow-ups');
        this.db.prepare(`INSERT INTO payment_reminder_config (tenant_id, settings, updated_at) VALUES (?, ?, ?)
                         ON CONFLICT(tenant_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
            .run(this.tenantId, JSON.stringify(next), new Date().toISOString());
        return next;
    }

    sentThisMonth(now = new Date()) {
        return this.db.prepare('SELECT sent FROM payment_reminder_usage WHERE tenant_id = ? AND month = ?')
            .get(this.tenantId, monthOf(now))?.sent ?? 0;
    }

    addSent(n, now = new Date()) {
        if (!n) return;
        this.db.prepare(`INSERT INTO payment_reminder_usage (tenant_id, month, sent) VALUES (?, ?, ?)
                         ON CONFLICT(tenant_id, month) DO UPDATE SET sent = sent + excluded.sent`)
            .run(this.tenantId, monthOf(now), n);
    }
}

const monthOf = (now) => new Date(now).toISOString().slice(0, 7);

/** The platform's rules for this business (policy/paymentReminders.js), as the page needs them. */
export function dueRules(state, store = new DueStore(state.db)) {
    const p = state.platformPolicy?.() ?? {};
    return {
        allowUpi: p['paymentReminders.allowUpi'] !== false,
        allowAuto: p['paymentReminders.allowAuto'] !== false,
        maxFollowUps: Number(p['paymentReminders.maxFollowUps'] ?? 3),
        maxPerMonth: ruleCap(p, 'paymentReminders.maxPerMonth'),
        sentThisMonth: store.sentThisMonth(),
    };
}

/** Why `n` more reminders may not go this month, or null. */
export function monthCapError(state, n, store = new DueStore(state.db)) {
    const cap = dueRules(state, store).maxPerMonth;
    if (cap === null) return null;
    const left = Math.max(0, cap - store.sentThisMonth());
    return n > left
        ? `Your plan sends up to ${cap} payment reminders a month; ${left} left this month.`
        : null;
}

/**
 * A sheet's due date as YYYY-MM-DD, or null. Day first when it is ambiguous: the sheets are Indian.
 * ISO (what an Excel date cell is read as), 25/11/2026, 25-11-26, 25.11.2026, "25 Nov 2026".
 */
export function parseDueDate(text) {
    const s = String(text ?? '').trim();
    if (!s) return null;
    const ymd = (y, m, d) => {
        const year = y < 100 ? 2000 + y : y;
        const date = new Date(Date.UTC(year, m - 1, d));
        return date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
    };
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return ymd(+m[1], +m[2], +m[3]);
    m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
    if (m) return +m[2] > 12 ? ymd(+m[3], +m[1], +m[2]) : ymd(+m[3], +m[2], +m[1]);
    const parsed = new Date(`${s} 12:00 UTC`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

const dueDay = (due) => String(due.data.dueAt ?? '').slice(0, 10);
const shortDate = (day) => {
    try {
        return new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${day}T12:00:00Z`));
    } catch {
        return day;
    }
};
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The UPI link for an amount, or '' when the business has no UPI ID or the platform has links off. */
function linkFor(state, settings, amount, reference) {
    if (!settings.upiId || !(amount > 0) || state.platformPolicy?.()['paymentReminders.allowUpi'] === false) return '';
    const payee = settings.payeeName || state.tenancy?.getTenant?.(state.db.tenantId)?.name || 'Payment';
    return upiLink({ upiId: settings.upiId, payeeName: payee, currency: settings.currency }, amount, reference);
}

/** The reminder for a stored due, in the business's words. */
export function dueMessage(state, due, settings = new DueStore(state.db).settings()) {
    const amount = Number(due.data.amount) || 0;
    return buildPaymentReminderMessage({
        name: due.metadata.name,
        phone: due.metadata.phone,
        remaining: due.metadata.amountText || moneyIn(due.data.currency || settings.currency)(amount),
        dueDate: due.metadata.dueText || shortDate(dueDay(due)),
        invoiceId: due.data.invoiceId ?? '',
        upiLink: linkFor(state, settings, amount, due.data.invoiceId || due.reference),
    }, settings.template);
}

/**
 * Save sheet rows as dues and give each its message in the business's words (a row's own message column still
 * wins). A paid or cancelled due with the same key is left alone. `render` re-makes every message (an import);
 * `sent` marks each one reminded now. Returns { created, updated, skipped }.
 */
export async function recordDues(state, reminders, { render = false, sent = false, now = new Date() } = {}) {
    const settings = new DueStore(state.db).settings();
    const today = localNow(state.channel?.timezone, now).date;
    const counts = { created: 0, updated: 0, skipped: 0 };
    for (const r of reminders) {
        const amount = r.remainingValue ?? amountValue(r.remaining) ?? 0;
        const day = parseDueDate(r.dueDate) ?? today;
        const invoiceId = String(r.invoiceId ?? '').trim();
        const reference = `${r.phone}:${invoiceId || day}`;
        // On a send, the text the page showed (or an API caller wrote) goes as it is.
        if (render || !r.finalMessage) {
            r.finalMessage = buildPaymentReminderMessage({
                ...r, upiLink: linkFor(state, settings, amount, invoiceId || reference),
            }, settings.template);
        }
        if (!state.objects) continue;
        const existing = state.objects.getByReference('payment', reference);
        if (existing && !OPEN.includes(existing.status)) { counts.skipped += 1; continue; }
        const metadata = {
            ...(existing?.metadata ?? {}),
            phone: r.phone, name: r.name ?? '', amountText: String(r.remaining ?? ''), dueText: String(r.dueDate ?? ''),
            source: existing?.metadata?.source ?? 'sheet',
            ...(sent ? { lastRemindedAt: now.toISOString(), reminders: (existing?.metadata?.reminders ?? 0) + 1 } : {}),
        };
        const data = { amount, currency: settings.currency, dueAt: `${day}T12:00:00.000Z`, ...(invoiceId ? { invoiceId } : {}) };
        try {
            if (existing) {
                await state.objects.update(existing.id, { data, metadata }, { source: 'sheet' });
                counts.updated += 1;
            } else {
                const contact = state.contacts?.getByPhone(r.phone)
                    ?? state.contacts?.upsert({ phone: r.phone, name: r.name || undefined, source: 'payment_reminders' });
                await state.objects.create('payment', {
                    reference, contactId: contact?.id ?? null, source: 'sheet', metadata, data,
                    status: day < today ? 'overdue' : 'pending',
                });
                counts.created += 1;
            }
        } catch (err) {
            // Saved, but a workflow on payment.created failed to start: the due is kept, the send goes on.
            if (!(err instanceof ObjectError) || !err.object) throw err;
        }
    }
    state.broadcast?.({ type: 'changed', topic: 'payment-reminders' });
    return counts;
}

/** Which automatic reminder today is for a due, or null: 'before', 'due', or 'after<n>'. */
function stageFor(settings, maxFollowUps, diff) {
    if (settings.daysBefore > 0 && diff === -settings.daysBefore) return 'before';
    if (diff === 0 && settings.onDueDay) return 'due';
    if (diff > 0 && settings.everyDays > 0 && diff % settings.everyDays === 0) {
        const n = diff / settings.everyDays;
        return n <= maxFollowUps ? `after${n}` : null;
    }
    return null;
}

/**
 * MODULE_SWEEPS entry (moduleSweeps.js): marks dues past their date overdue, and with automatic reminders on sends
 * the one each open, unclaimed due has today. The key names the due, its date and the stage, so a reminder goes once
 * and a due moved to a new date starts over.
 */
export async function paymentReminderSweep(state, now = new Date()) {
    if (!state.objects) return;
    const store = new DueStore(state.db);
    const settings = store.settings();
    const rules = dueRules(state, store);
    const today = localNow(state.channel?.timezone, now);
    const auto = settings.auto && rules.allowAuto && today.time >= SEND_FROM;
    const maxFollowUps = Math.min(settings.maxFollowUps, rules.maxFollowUps);
    let changed = false;
    let used = rules.sentThisMonth;

    for (const status of OPEN) {
        for (const due of listAll(state.objects, { type: 'payment', status })) {
            const day = dueDay(due);
            if (!day) continue;
            const diff = daysBetween(day, today.date);
            if (diff > 0 && due.status === 'pending') {
                await state.objects.update(due.id, { status: 'overdue' }, { source: 'scheduler' }).catch(() => {});
                changed = true;
            }
            if (!auto || !due.metadata.phone || due.metadata.payment === 'claimed') continue;
            const stage = stageFor(settings, maxFollowUps, diff);
            if (!stage) continue;
            if (rules.maxPerMonth !== null && used >= rules.maxPerMonth) {
                ownerAlert(state, `Automatic payment reminders stopped: this month's ${rules.maxPerMonth} reminders are used up. They start again next month.`,
                    `payrem.cap.${monthOf(now)}`);
                state.broadcast?.({ type: 'changed', topic: 'payment-reminders' });
                return;
            }
            const outcome = deliver(state, {
                recipient: due.metadata.phone, text: dueMessage(state, due, settings),
                key: `payrem.${due.id}.${day}.${stage}`, messageType: 'transactional',
            });
            if (outcome !== 'sent') continue;
            used += 1;
            store.addSent(1, now);
            const fresh = state.objects.get(due.id) ?? due;
            await state.objects.update(due.id, {
                metadata: { ...fresh.metadata, lastRemindedAt: now.toISOString(), reminders: (fresh.metadata.reminders ?? 0) + 1 },
            }, { source: 'scheduler' }).catch(() => {});
            changed = true;
        }
    }
    if (changed) state.broadcast?.({ type: 'changed', topic: 'payment-reminders' });
}

/**
 * A customer with an open due writes PAID or sends a screenshot: the due is marked claimed (automatic reminders
 * stop for it), the customer is thanked and the owner told. Runs after the shop, whose own PAID wins.
 * @returns {Promise<{ handled: boolean, sent?: boolean }>}
 */
export async function handlePaymentReply(state, message, { greeting = '' } = {}) {
    const services = state.tenancy?.getTenant?.(state.db.tenantId)?.services;
    if (services && !services.includes('payment_reminders')) return { handled: false };
    const word = String(message.body ?? '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!PAID.has(word) && message.mediaType !== 'image') return { handled: false };
    const contact = state.contacts?.getByPhone(message.sender);
    if (!contact || !state.objects) return { handled: false };
    const open = OPEN.flatMap((status) => state.objects.list({ type: 'payment', contactId: contact.id, status }))
        .filter((due) => due.metadata.payment !== 'claimed');
    if (!open.length) return { handled: false };

    const at = new Date().toISOString();
    for (const due of open) {
        await state.objects.update(due.id, { metadata: { ...due.metadata, payment: 'claimed', claimedAt: at } }, { source: 'whatsapp' });
    }
    const settings = new DueStore(state.db).settings();
    const what = open.map((d) => `${d.metadata.amountText || moneyIn(d.data.currency || settings.currency)(d.data.amount)}${d.data.invoiceId ? ` (${d.data.invoiceId})` : ''}`).join(', ');
    ownerAlert(state, `${contact.name || open[0].metadata.name || 'A customer'} (+${message.sender}) says they have paid ${what}. `
        + 'Check it and mark it paid on the Payment reminders page.', `payrem.claim.${message.messageId}`);
    const text = "Thanks, we'll confirm your payment shortly.";
    const outcome = deliver(state, {
        recipient: message.sender, messageType: 'auto_reply', key: `payrem.paid.${message.messageId}`,
        text: greeting ? `${greeting}\n\n${text}` : text,
    });
    state.db.markInboundReplied?.(message.messageId, 'payment:paid');
    state.broadcast?.({ type: 'changed', topic: 'payment-reminders' });
    return { handled: true, sent: outcome === 'sent' };
}

/** "N dues open · ₹X pending · M paid this month" for the super admin's Payment reminders page. */
export function duesUsage(scoped) {
    const objects = new ObjectStore(scoped);
    const open = OPEN.flatMap((status) => listAll(objects, { type: 'payment', status }));
    const pending = open.reduce((sum, d) => sum + (Number(d.data.amount) || 0), 0);
    const month = monthOf(new Date());
    const paid = listAll(objects, { type: 'payment', status: 'paid' })
        .filter((d) => String(d.data.paidAt ?? d.updatedAt).startsWith(month)).length;
    return `${open.length} dues open · ${moneyIn('INR')(pending)} pending · ${paid} paid this month`;
}

/** /payment-reminders/dues and /settings. The sheet import and send stay in app.js. */
export function createPaymentDuesRouter({ db, state }) {
    const app = express.Router();
    const store = () => new DueStore(db);
    const fail = (res, err) => {
        if (err instanceof DueError || err instanceof ObjectError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };

    app.get('/payment-reminders/dues', (req, res) => {
        const dues = state.objects?.list({ type: 'payment', limit: 1000 }) ?? [];
        res.json({ dues, settings: store().settings(), rules: dueRules(state, store()), today: localNow(state.channel?.timezone).date });
    });

    app.put('/payment-reminders/settings', (req, res) => {
        try {
            if (req.body?.auto === true && !dueRules(state, store()).allowAuto) {
                return res.status(403).json({ errors: ['Automatic reminders are not part of your plan.'] });
            }
            res.json({ settings: store().saveSettings(req.body ?? {}) });
        } catch (err) {
            fail(res, err);
        }
    });

    /** Paid, cancelled, or back to pending ("not received": a claim that turned out wrong restarts reminders). */
    app.post('/payment-reminders/dues/:id', async (req, res) => {
        try {
            const due = state.objects?.get(req.params.id);
            if (!due || due.type !== 'payment') return res.status(404).json({ errors: ['Due not found.'] });
            const status = String(req.body?.status ?? '');
            if (!['paid', 'pending', 'cancelled'].includes(status)) return res.status(400).json({ errors: ['status must be paid, pending or cancelled'] });
            const today = localNow(state.channel?.timezone).date;
            const { payment, claimedAt, ...rest } = due.metadata;
            const patch = status === 'paid'
                ? { status, data: { paidAt: new Date().toISOString() }, metadata: { ...rest, payment: 'paid' } }
                : status === 'pending'
                    ? { status: dueDay(due) < today ? 'overdue' : 'pending', data: { paidAt: null }, metadata: rest }
                    : { status };
            res.json({ due: await state.objects.update(due.id, patch, { source: 'dashboard' }) });
        } catch (err) {
            fail(res, err);
        }
    });

    return app;
}
