/**
 * Orders, Appointments and Leads touching WhatsApp: the customer on a record, status notices from the Records page
 * (one message even when the shop page moves it too), booking reminders, owner alerts, and leads made from chats
 * with their follow-up alert.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { APPOINTMENT_REMINDERS, LEAD_FOLLOW_UPS } from '../src/objects/sweeps.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-records-wa-'));
let app;
let server;
let base;
let db;
let owner;
let admin;
let transport;
let state;
const OWNER_PHONE = '919800000099';

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
const say = async (from, body, senderName = 'Asha') => {
    await transport.events.emit('inbound', { messageId: `in.${Math.random()}`, sender: from, senderName, body });
    await new Promise((r) => setTimeout(r, 100));
};

before(async () => {
    db = new Database(path.join(tmp, 's.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connection/connect`, { method: 'POST' });
    const rt = app.locals.runtimeFor(1);
    state = rt.runtimeFor(rt.channels.getDefault()).state;
    transport = state.transport;
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
    admin = sessionFor(app, { role: 'super_admin' });
    const services = app.locals.tenancy.getTenant(1).services.filter((s) => !['orders', 'appointments', 'leads'].includes(s));
    app.locals.tenancy.db.prepare('UPDATE tenants SET services = ?, contact_phone = ? WHERE id = 1')
        .run(JSON.stringify([...services, 'orders', 'appointments', 'leads']), `+${OWNER_PHONE}`);
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('records on WhatsApp', () => {
    const buyer = '919811100001';
    let order;

    it('a record carries its customer, picked from the contacts', async () => {
        const contact = state.contacts.upsert({ phone: `+${buyer}`, name: 'Ravi Kumar' });
        const found = (await call(owner, 'GET', '/api/objects/order/customers?search=Ravi')).body.contacts;
        assert.deepEqual(found.map((c) => c.id), [contact.id]);
        const created = await call(owner, 'POST', '/api/objects/order', { contactId: contact.id, data: { amount: 500 } });
        assert.equal(created.status, 201);
        order = created.body.object;
        assert.equal(order.customer.name, 'Ravi Kumar');
        const listed = (await call(owner, 'GET', '/api/objects/order')).body.objects.find((o) => o.id === order.id);
        assert.equal(listed.customer.phone, contact.phone);
    });

    it('moving an order on the Records page tells the customer, once even if the shop page moves it too', async () => {
        const before = sentTo(buyer).length;
        const moved = await call(owner, 'PUT', `/api/objects/order/${order.id}`, { status: 'confirmed' });
        assert.equal(moved.body.notified, true);
        assert.match(sentTo(buyer).at(-1), new RegExp(`Your order \\*${order.reference}\\* is confirmed`));
        // The same move from the shop page is the same message key: nothing new.
        await call(owner, 'PUT', `/api/objects/order/${order.id}`, { status: 'placed', notify: false });
        await call(owner, 'POST', `/api/shop/order/orders/${order.id}`, { status: 'confirmed' });
        assert.equal(sentTo(buyer).length, before + 1);

        const quiet = await call(owner, 'PUT', `/api/objects/order/${order.id}`, { status: 'processing', notify: false });
        assert.equal(quiet.body.notified, false);
        await rules({ 'orders.notifyOnStatus': false });
        const off = await call(owner, 'PUT', `/api/objects/order/${order.id}`, { status: 'shipped' });
        assert.equal(off.body.notified, false);
        assert.equal(sentTo(buyer).length, before + 1);
        await rules({ 'orders.notifyOnStatus': null });
    });

    it('reminds the customer before a booking, once, when the business set the hours', async () => {
        const client = '919811100002';
        const contact = state.contacts.upsert({ phone: `+${client}`, name: 'Meera' });
        const now = Date.now();
        const at = new Date(now + 30 * 3_600_000).toISOString();
        const appt = (await call(owner, 'POST', '/api/objects/appointment', { contactId: contact.id, data: { service: 'Haircut', scheduledAt: at } })).body.object;
        const later = new Date(now + 28.5 * 3_600_000);

        await APPOINTMENT_REMINDERS.run(state, later);
        assert.equal(sentTo(client).length, 0, 'off until the business sets the hours');
        assert.equal((await call(owner, 'PUT', '/api/shop/booking/settings', { reminderHours: 2 })).status, 200);
        await rules({ 'appointments.allowReminders': false });
        await APPOINTMENT_REMINDERS.run(state, later);
        assert.equal(sentTo(client).length, 0, 'the platform rule wins');
        await rules({ 'appointments.allowReminders': null });
        await APPOINTMENT_REMINDERS.run(state, new Date(now + 20 * 3_600_000));
        assert.equal(sentTo(client).length, 0, 'not yet');
        await APPOINTMENT_REMINDERS.run(state, later);
        await APPOINTMENT_REMINDERS.run(state, later);
        assert.equal(sentTo(client).length, 1);
        assert.match(sentTo(client)[0], /^Reminder: your Haircut is at .+\. Reply here if you need to change it\.$/);
        assert.equal(appt.customer.name, 'Meera');
    });

    it('alerts the owner on a new WhatsApp order and on PAID, unless switched off', async () => {
        await call(owner, 'PUT', '/api/shop/order/settings', { enabled: true, upiId: 'asha@okbank', askAddress: false });
        await call(owner, 'POST', '/api/shop/order/products', { name: 'Brownie', price: 60 });
        const shopper = '919811100003';
        await say(shopper, 'MENU');
        await say(shopper, '1');
        await say(shopper, 'checkout');
        await new Promise((r) => setTimeout(r, 400));
        assert.match(sentTo(OWNER_PHONE).at(-1), /^New order ORD-[A-Z0-9]{5} on WhatsApp from Asha \+919811100003: 1 x Brownie - ₹60 - total ₹60$/);
        await say(shopper, 'PAID');
        assert.match(sentTo(OWNER_PHONE).at(-1), /\+919811100003 says they have paid ₹60 for ORD-/);

        const count = sentTo(OWNER_PHONE).length;
        await call(owner, 'PUT', '/api/shop/order/settings', { alertOwner: false });
        await say(shopper, 'MENU');
        await say(shopper, '1');
        await say(shopper, 'checkout');
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(sentTo(OWNER_PHONE).length, count);
        await call(owner, 'PUT', '/api/shop/order/settings', { enabled: false });
    });

    it('makes one open lead per new person who messages, when switched on, within the daily rule', async () => {
        const leads = () => state.objects.list({ type: 'lead' });
        await say('919811100004', 'hello');
        assert.equal(leads().length, 0, 'off by default');

        await rules({ 'leads.autoCapture': false });
        assert.equal((await call(owner, 'PUT', '/api/objects/lead/settings', { autoCapture: true })).status, 403);
        await rules({ 'leads.autoCapture': null, 'leads.maxAutoPerDay': 1 });
        assert.equal((await call(owner, 'PUT', '/api/objects/lead/settings', { autoCapture: true })).body.settings.autoCapture, true);

        await say('919811100005', 'Price of the 1 kg cake?', 'Kiran');
        await say('919811100005', 'and delivery?', 'Kiran');
        assert.equal(leads().length, 1);
        const [lead] = leads();
        assert.deepEqual([lead.status, lead.data.name, lead.data.phone, lead.data.interest, lead.data.source],
            ['new', 'Kiran', '919811100005', 'Price of the 1 kg cake?', 'whatsapp']);
        await say('919811100006', 'hi');
        assert.equal(leads().length, 1, 'the day\'s limit is reached');
        await rules({ 'leads.maxAutoPerDay': null });
        await say('919811100006', 'hi again');
        assert.equal(leads().length, 2);

        const followUpAt = new Date(Date.now() + 3_600_000).toISOString();
        await call(owner, 'PUT', `/api/objects/lead/${lead.id}`, { data: { followUpAt } });
        await LEAD_FOLLOW_UPS.run(state, new Date());
        assert.doesNotMatch(sentTo(OWNER_PHONE).at(-1) ?? '', /Follow up/);
        const due = new Date(Date.now() + 2 * 3_600_000);
        await LEAD_FOLLOW_UPS.run(state, due);
        await LEAD_FOLLOW_UPS.run(state, due);
        const alerts = sentTo(OWNER_PHONE).filter((m) => m.startsWith('Follow up'));
        assert.deepEqual(alerts, ['Follow up: Kiran +919811100005 - Price of the 1 kg cake?']);
    });
});
