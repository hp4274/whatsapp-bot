/**
 * Super-admin rules for the modules opened on 2026-11-18 (policy/modules.js): set through the same policy API as
 * every other rule, refused at the module's own create/send, and shown per business on the service page.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { slaDueAt, slaTable } from '../src/tickets/store.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-svc-policy-'));
let app;
let server;
let base;
let db;
let owner;
let admin;
let transport;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
/** Set rules for business #1 (null clears one). */
const rules = async (values) => {
    const res = await call(admin, 'PUT', '/api/admin/policy/tenant:1', { values });
    assert.equal(res.status, 200, JSON.stringify(res.body));
};
const sentTo = (phone) => db.db.prepare('SELECT message FROM messages WHERE recipient LIKE ? ORDER BY rowid')
    .all(`%${phone.slice(-10)}%`).map((r) => r.message);
const last = (phone) => sentTo(phone).at(-1) ?? '';
const say = async (from, body) => {
    await transport.events.emit('inbound', { messageId: `in.${Math.random()}`, sender: from, senderName: 'Asha', body });
    await new Promise((r) => setTimeout(r, 400));
};

before(async () => {
    db = new Database(path.join(tmp, 's.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connection/connect`, { method: 'POST' });
    const rt = app.locals.runtimeFor(1);
    transport = rt.runtimeFor(rt.channels.getDefault()).state.transport;
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
    admin = sessionFor(app, { role: 'super_admin' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('module rules', () => {
    it('the six modules declare rules the admin editor can draw', async () => {
        const { fields } = (await call(admin, 'GET', '/api/admin/policy')).body;
        const services = new Set(fields.map((f) => f.service));
        for (const s of ['orders', 'appointments', 'leads', 'payment_reminders', 'faq', 'tickets']) assert.ok(services.has(s), s);
    });

    it('orders: product and monthly caps, WhatsApp and UPI switches', async () => {
        await call(owner, 'PUT', '/api/shop/order/settings', { enabled: true, upiId: 'asha@okbank' });
        await rules({ 'orders.maxProducts': 1 });
        assert.equal((await call(owner, 'POST', '/api/shop/order/products', { name: 'Brownie', price: 60 })).status, 201);
        const second = await call(owner, 'POST', '/api/shop/order/products', { name: 'Cake', price: 500 });
        assert.equal(second.status, 403);
        assert.match(second.body.errors[0], /allows 1 products/);
        assert.equal((await call(owner, 'GET', '/api/shop/order')).body.rules.maxProducts, 1);

        await rules({ 'orders.allowUpi': false });
        const buyer = '919800000101';
        for (const m of ['menu', '1', 'checkout', '12 MG Road, Pune 411001']) await say(buyer, m);
        assert.match(last(buyer), /Order \*ORD-/);
        assert.doesNotMatch(last(buyer), /upi:\/\//, 'no payment step when UPI is off');

        await rules({ 'orders.maxPerMonth': 1 });
        const refused = await call(owner, 'POST', '/api/objects/order', { data: { amount: 10 } });
        assert.equal(refused.status, 403, 'the WhatsApp order used the month');
        const buyer2 = '919800000102';
        for (const m of ['menu', '1', 'checkout', '9 FC Road, Pune 411004']) await say(buyer2, m);
        assert.match(last(buyer2), /can't take new orders on WhatsApp right now/);

        await rules({ 'orders.allowWhatsapp': false });
        const buyer3 = '919800000103';
        await say(buyer3, 'menu');
        assert.doesNotMatch(last(buyer3), /Reply with a number/);
        assert.equal((await call(owner, 'GET', '/api/shop/order')).body.rules.allowWhatsapp, false);
        await rules({ 'orders.allowWhatsapp': null, 'orders.maxPerMonth': null, 'orders.allowUpi': null, 'orders.maxProducts': null });
    });

    it('leads and FAQ: a cap on how many a business keeps', async () => {
        await rules({ 'leads.maxLeads': 1, 'faq.maxItems': 1 });
        assert.equal((await call(owner, 'POST', '/api/objects/lead', { data: { name: 'Ravi' } })).status, 201);
        assert.equal((await call(owner, 'POST', '/api/objects/lead', { data: { name: 'Sana' } })).status, 403);
        assert.equal((await call(owner, 'POST', '/api/faq', { question: 'Timings?', answer: '10 to 7', matchType: 'CONTAINS', keywords: ['timing'] })).status, 201);
        const faq = await call(owner, 'POST', '/api/faq', { question: 'Address?', answer: 'MG Road' });
        assert.equal(faq.status, 403);
        assert.match(faq.body.errors[0], /1 FAQ answers/);
    });

    it('payment reminders: one send is capped', async () => {
        await rules({ 'paymentReminders.maxPerSend': 1 });
        const two = [{ phone: '9800000201', remaining: '100' }, { phone: '9800000202', remaining: '200' }];
        const res = await call(owner, 'POST', '/api/payment-reminders/send', { reminders: two });
        assert.equal(res.status, 403);
        assert.match(res.body.errors[0], /up to 1 reminders/);
    });

    it('tickets: the SLA table sets the due time', () => {
        const table = slaTable([{ priority: 'low', hours: 72 }, { priority: 'normal', hours: 24 }, { priority: 'high', hours: 1 }, { priority: 'urgent', hours: 2 }]);
        assert.equal(slaDueAt('2026-11-18T10:00:00Z', 'high', table), '2026-11-18T11:00:00Z');
        assert.equal(slaDueAt('2026-11-18T10:00:00Z', 'high'), '2026-11-18T18:00:00Z', 'the built-in 8 h without a rule');
    });

    it('the service page gets one usage line per business', async () => {
        const orders = (await call(admin, 'GET', '/api/admin/services/orders/usage')).body.usage;
        assert.match(orders[1], /^1 orders this month · 1 open$/);
        assert.match((await call(admin, 'GET', '/api/admin/services/faq/usage')).body.usage[1], /1 answers/);
        assert.match((await call(admin, 'GET', '/api/admin/services/tickets/usage')).body.usage[1], /0 open · 0 overdue/);
        assert.deepEqual((await call(admin, 'GET', '/api/admin/services/campaigns/usage')).body.usage, {});
    });
});
