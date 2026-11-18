/**
 * Tickets from WhatsApp (tickets/whatsapp.js): a handoff or a complaint word opens one ticket per customer, later
 * messages join it, the team replies from it, the owner hears about new and overdue tickets, and the super admin's
 * rules (tickets.autoCreate, maxOpen, allowCustomerReply, autoCloseDays) hold.
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
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tickets-wa-'));
const OWNER = '919000000099';
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
const say = async (from, body) => {
    await state.transport.events.emit('inbound', { messageId: `in.${Math.random()}`, sender: from, senderName: 'Asha', body });
    await new Promise((r) => setTimeout(r, 300));
};
const ticketsOf = async () => (await call(owner, 'GET', '/api/tickets')).body.tickets;
const eventsOf = async (id) => (await call(owner, 'GET', `/api/tickets/${id}/events`)).body.events;
const sweep = MODULE_SWEEPS.find((s) => s.name === 'tickets');

before(async () => {
    db = new Database(path.join(tmp, 't.db'));
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

describe('tickets from WhatsApp', () => {
    it('is off until the business turns it on', async () => {
        const { body } = await call(owner, 'GET', '/api/tickets/settings');
        assert.equal(body.settings.autoCreate, false);
        assert.ok(body.settings.keywords.includes('refund'));
        await say('919811111111', 'I want a refund');
        assert.equal((await ticketsOf()).length, 0);
    });

    it('a complaint word opens a ticket, tells the customer its reference and alerts the owner', async () => {
        assert.equal((await call(owner, 'PUT', '/api/tickets/settings', { autoCreate: true })).status, 200);
        await say('919811111111', 'My order has a problem, the box was broken');
        const [ticket] = await ticketsOf();
        assert.equal(ticket.source, 'whatsapp');
        assert.match(ticket.subject, /box was broken/);
        assert.equal(ticket.customer.phone.replace(/\D/g, ''), '919811111111');
        assert.match(sentTo('919811111111').at(-1), new RegExp(`ticket ${ticket.reference}`));
        assert.match(sentTo(OWNER).at(-1), new RegExp(`New ticket ${ticket.reference}`));
        const events = await eventsOf(ticket.id);
        assert.deepEqual(events.map((e) => e.kind), ['created', 'inbound']);
    });

    it('later messages join the open ticket instead of opening another', async () => {
        const before = sentTo('919811111111').length;
        await say('919811111111', 'Another problem: it was also late');
        const list = await ticketsOf();
        assert.equal(list.length, 1);
        const events = await eventsOf(list[0].id);
        assert.equal(events.at(-1).kind, 'inbound');
        assert.match(events.at(-1).body, /also late/);
        assert.equal(sentTo('919811111111').length, before, 'no second reference message');
    });

    it('the team replies from the ticket: sent on WhatsApp, on the thread, first response recorded', async () => {
        const [ticket] = await ticketsOf();
        const res = await call(owner, 'POST', `/api/tickets/${ticket.id}/reply`, { text: 'Sorry! A new one ships today.' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.ok(res.body.ticket.firstResponseAt);
        assert.equal(sentTo('919811111111').at(-1), 'Sorry! A new one ships today.');
        assert.equal((await eventsOf(ticket.id)).at(-1).kind, 'message');

        await rules({ 'tickets.allowCustomerReply': false });
        const refused = await call(owner, 'POST', `/api/tickets/${ticket.id}/reply`, { text: 'hello' });
        assert.equal(refused.status, 403);
        assert.match(refused.body.errors[0], /not part of your plan/);
        await rules({ 'tickets.allowCustomerReply': null });
    });

    it('a resolved ticket reopens when the customer writes again', async () => {
        const [ticket] = await ticketsOf();
        await call(owner, 'PATCH', `/api/tickets/${ticket.id}`, { status: 'RESOLVED' });
        await say('919811111111', 'still broken');
        const [again] = await ticketsOf();
        assert.equal(again.id, ticket.id);
        assert.equal(again.status, 'OPEN');
    });

    it('a handoff opens a ticket too', async () => {
        state.autoReply.store.saveSettings({ delaySec: 0, handoff: { enabled: true, keywords: ['agent'], text: 'Connecting you now' } });
        await say('919822222222', 'agent please');
        const ticket = (await ticketsOf()).find((t) => t.customer?.phone.endsWith('9822222222'));
        assert.ok(ticket, 'a ticket for the handoff');
        assert.equal(ticket.metadata.reason, 'Asked for a person');
        // The handoff reply went out, so no reference message on top.
        assert.deepEqual(sentTo('919822222222'), ['Connecting you now']);
    });

    it('the platform rules: autoCreate off and maxOpen', async () => {
        await rules({ 'tickets.autoCreate': false });
        await say('919833333333', 'refund now');
        assert.equal((await ticketsOf()).length, 2);
        await rules({ 'tickets.autoCreate': null, 'tickets.maxOpen': 2 });
        await say('919833333333', 'refund now');
        assert.equal((await ticketsOf()).length, 2, 'capped');
        const manual = await call(owner, 'POST', '/api/tickets', { subject: 'by hand' });
        assert.equal(manual.status, 403);
        assert.match(manual.body.errors[0], /allows 2 open tickets/);
        await rules({ 'tickets.maxOpen': null });
    });

    it('serves the SLA hours from the platform rule', async () => {
        await rules({ 'tickets.sla': [{ priority: 'Low', hours: 72 }, { priority: 'Normal', hours: 12 }, { priority: 'High', hours: 8 }, { priority: 'Urgent', hours: 2 }] });
        assert.equal((await call(owner, 'GET', '/api/tickets')).body.sla.normal, 12);
        await rules({ 'tickets.sla': null });
    });
});

describe('the tickets sweep', () => {
    it('alerts the owner once when a ticket passes its SLA', async () => {
        const ticket = state.tickets.create({ subject: 'late one', priority: 'urgent' });
        const later = new Date(Date.parse(ticket.slaDueAt) + 60_000);
        sweep.run(state, later);
        sweep.run(state, later);
        assert.equal(sentTo(OWNER).filter((m) => m.includes(`Ticket ${ticket.reference} is past`)).length, 1);
    });

    it('closes resolved tickets after tickets.autoCloseDays, and never by default', async () => {
        const ticket = state.tickets.create({ subject: 'done' });
        state.tickets.resolve(ticket.id);
        const in3Days = new Date(Date.now() + 3 * 86_400_000);
        sweep.run(state, in3Days);
        assert.equal(state.tickets.get(ticket.id).status, 'RESOLVED');
        await rules({ 'tickets.autoCloseDays': 2 });
        sweep.run(state, in3Days);
        assert.equal(state.tickets.get(ticket.id).status, 'CLOSED');
        await rules({ 'tickets.autoCloseDays': null });
    });
});
