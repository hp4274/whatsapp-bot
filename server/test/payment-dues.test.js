/**
 * Payment reminders' dues ledger (paymentDues.js): sheet rows kept as dues, the business's own message and UPI link,
 * automatic reminders before / on / after the due date, a customer's PAID pausing them, and the platform's rules.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { MODULE_SWEEPS } from '../src/moduleSweeps.js';
import { parseDueDate } from '../src/paymentDues.js';
import { localNow, zonedToUtc } from '../src/school/routes.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-dues-'));
const OWNER = '919800099999';
let app;
let server;
let base;
let db;
let owner;
let admin;
let state;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const rules = async (values) => {
    const res = await call(admin, 'PUT', '/api/admin/policy/tenant:1', { values });
    assert.equal(res.status, 200, JSON.stringify(res.body));
};
const sentTo = (phone) => db.db.prepare('SELECT message FROM messages WHERE recipient LIKE ? ORDER BY rowid')
    .all(`%${phone.slice(-10)}%`).map((r) => r.message);
const say = async (from, body, extra = {}) => {
    await state.transport.events.emit('inbound', { messageId: `in.${Math.random()}`, sender: from, senderName: 'Asha', body, ...extra });
    await new Promise((r) => setTimeout(r, 400));
};
const sweep = MODULE_SWEEPS.find((s) => s.service === 'payment_reminders');
const plusDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
/** Noon, business time, `n` days from today. */
const at = (n) => zonedToUtc(plusDays(localNow(state.channel?.timezone).date, n), '12:00', state.channel?.timezone || 'UTC');
const dues = async () => (await call(owner, 'GET', '/api/payment-reminders/dues')).body;

async function importSheet(rows) {
    const XLSX = await import('xlsx');
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Dues');
    const form = new FormData();
    form.set('file', new Blob([XLSX.write(book, { type: 'buffer', bookType: 'xlsx' })]), 'dues.xlsx');
    const res = await fetch(`${base}/api/payment-reminders/import`, { method: 'POST', body: form, headers: { authorization: `Bearer ${owner}` } });
    return { status: res.status, body: await res.json() };
}

before(async () => {
    db = new Database(path.join(tmp, 'd.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connection/connect`, { method: 'POST' });
    const rt = app.locals.runtimeFor(1);
    state = rt.runtimeFor(rt.channels.getDefault()).state;
    db.db.prepare('UPDATE tenants SET contact_phone = ? WHERE id = 1').run(OWNER);
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
    admin = sessionFor(app, { role: 'super_admin' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('payment dues', () => {
    it('reads Indian due dates day first', () => {
        assert.equal(parseDueDate('05/11/2026'), '2026-11-05');
        assert.equal(parseDueDate('2026-11-25'), '2026-11-25');
        assert.equal(parseDueDate('11/25/26'), '2026-11-25');
        assert.equal(parseDueDate('25 Nov 2026'), '2026-11-25');
        assert.equal(parseDueDate('31/02/2026'), null);
    });

    it('keeps every imported row as a due, once, and lists it', async () => {
        const due = plusDays(localNow(state.channel?.timezone).date, 2);
        const rows = [
            { Name: 'Isha', Phone: '9800000301', Remaining: '2500', Invoice: 'INV-1', 'Due Date': due },
            { Name: 'Isha', Phone: '9800000301', Remaining: '400', Invoice: 'INV-2', 'Due Date': due },
            { Name: 'Dev', Phone: '9800000302', Remaining: '3100', 'Due Date': due },
        ];
        const first = await importSheet(rows);
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.reminders.length, 3, 'two invoices for one number are two dues');
        assert.deepEqual(first.body.saved, { created: 3, updated: 0, skipped: 0 });
        assert.deepEqual((await importSheet(rows)).body.saved, { created: 0, updated: 3, skipped: 0 });
        const list = (await dues()).dues;
        assert.equal(list.length, 3);
        const isha = list.find((d) => d.data.invoiceId === 'INV-1');
        assert.equal(isha.status, 'pending');
        assert.equal(isha.data.amount, 2500);
        assert.equal(isha.data.dueAt.slice(0, 10), due);
        assert.equal(isha.metadata.phone, '919800000301');
        assert.ok(isha.contactId, 'the contact is made from the phone');
    });

    it('uses the business message and adds the UPI link', async () => {
        assert.equal((await call(owner, 'PUT', '/api/payment-reminders/settings', { upiId: 'not a upi' })).status, 400);
        const saved = await call(owner, 'PUT', '/api/payment-reminders/settings', {
            template: 'Namaste {name}, {amount} for {invoice} is due on {due_date}. Pay: {upi_link}', upiId: 'asha@okbank', payeeName: 'Asha Stores',
        });
        assert.equal(saved.status, 200);
        const { body } = await importSheet([{ Name: 'Isha', Phone: '9800000301', Remaining: '2500', Invoice: 'INV-1', 'Due Date': '2026-12-01' }]);
        assert.match(body.reminders[0].finalMessage, /^Namaste Isha, 2500 for INV-1 is due on 2026-12-01\. Pay: upi:\/\/pay\?pa=asha%40okbank&pn=Asha%20Stores&am=2500/);

        await rules({ 'paymentReminders.allowUpi': false });
        const off = await importSheet([{ Name: 'Isha', Phone: '9800000301', Remaining: '2500', Invoice: 'INV-1', 'Due Date': '2026-12-01' }]);
        assert.doesNotMatch(off.body.reminders[0].finalMessage, /upi:/);
        await rules({ 'paymentReminders.allowUpi': null });
    });

    it('caps reminders a month, by hand and automatic together', async () => {
        await rules({ 'paymentReminders.maxPerMonth': 1 });
        const two = [{ phone: '9800000201', remaining: '100' }, { phone: '9800000202', remaining: '200' }];
        const res = await call(owner, 'POST', '/api/payment-reminders/send', { reminders: two });
        assert.equal(res.status, 403);
        assert.match(res.body.errors[0], /up to 1 payment reminders a month/);
        await rules({ 'paymentReminders.maxPerMonth': null });
    });

    it('sends automatically before, on and after the due date, once each', async () => {
        await call(owner, 'PUT', '/api/payment-reminders/settings', { template: 'Hi {name}, {amount} is due on {due_date}.' });
        await sweep.run(state, at(0));
        assert.equal(sentTo('919800000302').length, 0, 'off until the business turns it on');

        await rules({ 'paymentReminders.allowAuto': false });
        const refused = await call(owner, 'PUT', '/api/payment-reminders/settings', { auto: true });
        assert.equal(refused.status, 403);
        await rules({ 'paymentReminders.allowAuto': null });
        assert.equal((await call(owner, 'PUT', '/api/payment-reminders/settings', { auto: true, daysBefore: 2, everyDays: 2, maxFollowUps: 1 })).status, 200);

        await sweep.run(state, zonedToUtc(localNow(state.channel?.timezone).date, '08:00', state.channel?.timezone || 'UTC'));
        assert.equal(sentTo('919800000302').length, 0, 'not before the business day starts');
        await sweep.run(state, at(0));
        await sweep.run(state, at(0));
        assert.equal(sentTo('919800000302').length, 1, 'two days before, once');
        assert.match(sentTo('919800000302')[0], /^Hi Dev, 3100 is due on/);
        await sweep.run(state, at(1));
        assert.equal(sentTo('919800000302').length, 1, 'nothing the day between');
        await sweep.run(state, at(2));
        assert.equal(sentTo('919800000302').length, 2, 'on the due day');
        await sweep.run(state, at(4));
        assert.equal(sentTo('919800000302').length, 3, 'the one follow-up');
        await sweep.run(state, at(6));
        assert.equal(sentTo('919800000302').length, 3, 'no more than the follow-ups allowed');
        const dev = (await dues()).dues.find((d) => d.metadata.phone === '919800000302');
        assert.equal(dev.status, 'overdue');
        assert.equal(dev.metadata.reminders, 3);
    });

    it('a customer\'s PAID claims the due, thanks them, tells the owner and pauses reminders', async () => {
        await say('919800000302', 'Paid');
        assert.equal(sentTo('919800000302').at(-1), "Thanks, we'll confirm your payment shortly.");
        assert.match(sentTo(OWNER).at(-1), /says they have paid 3100/);
        let dev = (await dues()).dues.find((d) => d.metadata.phone === '919800000302');
        assert.equal(dev.metadata.payment, 'claimed');

        await call(owner, 'PUT', '/api/payment-reminders/settings', { maxFollowUps: 3 });
        const before = sentTo('919800000302').length;
        await sweep.run(state, at(6));
        assert.equal(sentTo('919800000302').length, before, 'paused while the claim is checked');

        const paid = await call(owner, 'POST', `/api/payment-reminders/dues/${dev.id}`, { status: 'paid' });
        assert.equal(paid.status, 200);
        dev = paid.body.due;
        assert.equal(dev.status, 'paid');
        assert.ok(dev.data.paidAt);
        await say('919800000302', 'PAID');
        assert.equal(sentTo('919800000302').filter((m) => /confirm your payment/.test(m)).length, 1, 'nothing open: not answered as a payment');
    });

    it('shows the super admin one usage line per business', async () => {
        const { usage } = (await call(admin, 'GET', '/api/admin/services/payment_reminders/usage')).body;
        assert.match(usage[1], /^2 dues open · ₹2,900 pending · 1 paid this month$/);
    });
});
