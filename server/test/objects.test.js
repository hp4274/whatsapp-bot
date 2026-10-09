/**
 * Phase 11: business objects.
 *
 * The claims under test: the registry, not code, decides what is valid; every
 * change leaves an append-only log row; a create or status change reaches the
 * workflow engine, and a failed dispatch is reported rather than swallowed;
 * `due` reads what reminders need; and none of it leaks across tenants.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { Channels } from '../src/channels.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { createObjectRouter } from '../src/objects/routes.js';
import { OBJECTS_SCHEMA } from '../src/objects/schema.js';
import { ObjectStore } from '../src/objects/store.js';
import { OBJECT_TYPES, eventTypes, validateData } from '../src/objects/types.js';
import { WorkflowEngine } from '../src/workflows/engine.js';
import { WorkflowStore } from '../src/workflows/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-objects-'));
let db;
let A;
let B;

/** A store whose emit records every event, and can be told to fail. */
function recorder(tenantId) {
    const events = [];
    const scoped = db.forTenant(tenantId);
    const store = new ObjectStore(scoped, {
        emit: async (event) => {
            if (store.failNext) { store.failNext = false; throw new Error('engine down'); }
            events.push(event);
        },
    });
    store.failNext = false;
    return { scoped, store, events };
}

before(() => {
    db = new Database(path.join(tmp, 'o.db'));
    db.db.exec(OBJECTS_SCHEMA);
    db.db.prepare(`INSERT INTO tenants (id, name, slug, status, created_at) VALUES (2, 'B', 'b', 'active', ?)`)
        .run('2026-01-01T00:00:00+00:00');
    A = recorder(1);
    B = recorder(2);
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the registry', () => {
    it('has every Phase 11 object except ticket', () => {
        assert.deepEqual(Object.keys(OBJECT_TYPES).sort(),
            ['appointment', 'attendance', 'event', 'exam_result', 'fee', 'homework', 'lead', 'notice', 'order', 'payment', 'student', 'subscription', 'timetable']);
    });

    it('emits exactly the Phase 6 trigger names it owns', () => {
        const names = eventTypes();
        for (const expected of ['lead.created', 'lead.updated', 'appointment.created', 'appointment.updated',
            'order.created', 'order.status_changed', 'payment.due', 'subscription.expiring', 'event.created',
            'attendance.created', 'homework.created', 'exam_result.created', 'timetable.updated']) {
            assert.ok(names.includes(expected), expected);
        }
        assert.ok(!names.some((n) => n.startsWith('ticket.')));
    });

    it('rejects a missing required field, an unknown field and a bad value', () => {
        assert.throws(() => validateData('order', {}), /needs "amount"/);
        assert.throws(() => validateData('order', { amount: 1, colour: 'red' }), /no field "colour"/);
        assert.throws(() => validateData('order', { amount: 'lots' }), /must be a number/);
        assert.throws(() => validateData('appointment', { service: 'x', scheduledAt: 'tomorrow' }), /date-time/);
        assert.throws(() => validateData('invoice', {}), /unknown object type/);
    });

    it('coerces numbers, booleans and dates', () => {
        const data = validateData('subscription', { plan: 'pro', expiresAt: '2026-12-01', autoRenew: 'true', amount: '99' });
        assert.deepEqual(data, { plan: 'pro', expiresAt: '2026-12-01T00:00:00.000Z', autoRenew: true, amount: 99 });
    });
});

describe('the store', () => {
    it('creates with the default status, logs it and emits the create event', async () => {
        const order = await A.store.create('order', { reference: 'ORD-1', contactId: 7, data: { amount: 250, currency: 'INR' } });
        assert.equal(order.status, 'placed');
        assert.equal(order.reference, 'ORD-1');
        assert.deepEqual(order.data, { amount: 250, currency: 'INR' });

        const events = A.store.events(order.id);
        assert.equal(events.length, 1);
        assert.equal(events[0].change, 'created');

        const emitted = A.events.at(-1);
        assert.equal(emitted.type, 'order.created');
        assert.equal(emitted.tenantId, 1);
        assert.deepEqual(emitted.subject, { kind: 'order', id: String(order.id) });
        assert.equal(emitted.data.amount, 250); // flattened, so {amount} interpolates
        assert.equal(emitted.data.contactId, 7); // what the engine finds the contact by
        assert.equal(emitted.source, 'api');
    });

    it('refuses a duplicate reference per tenant+type but allows it in another tenant', async () => {
        await assert.rejects(A.store.create('order', { reference: 'ORD-1', data: { amount: 1 } }), /already exists/);
        const other = await B.store.create('order', { reference: 'ORD-1', data: { amount: 1 } });
        assert.equal(other.tenantId, 2);
        await A.store.create('payment', { reference: 'ORD-1', data: { amount: 1, dueAt: '2026-10-09' } }); // other type
    });

    it('logs every changed field on update and emits status_changed only when status moved', async () => {
        const order = A.store.getByReference('order', 'ORD-1');
        const before = A.events.length;

        const same = await A.store.update(order.id, { data: { amount: 250 } });
        assert.equal(same.updatedAt, order.updatedAt);
        assert.equal(A.events.length, before, 'a no-op patch emits nothing');

        const tracked = await A.store.update(order.id, { data: { trackingId: 'TRK9', currency: null } });
        assert.deepEqual(tracked.data, { amount: 250, trackingId: 'TRK9' });
        assert.equal(A.events.length, before, 'order declares no updated event');

        const shipped = await A.store.update(order.id, { status: 'shipped', metadata: { carrier: 'dhl' } });
        assert.equal(shipped.status, 'shipped');
        const emitted = A.events.at(-1);
        assert.equal(emitted.type, 'order.status_changed');
        assert.equal(emitted.data.previousStatus, 'placed');
        assert.deepEqual(emitted.data.changes.status, { from: 'placed', to: 'shipped' });

        const trail = A.store.events(order.id).map((e) => [e.change, e.field, e.from, e.to]);
        assert.deepEqual(trail, [
            ['created', 'status', null, 'placed'],
            ['updated', 'trackingId', null, 'TRK9'],
            ['updated', 'currency', 'INR', null],
            ['status', 'status', 'placed', 'shipped'],
            ['updated', 'metadata', '{}', '{"carrier":"dhl"}'],
        ]);
    });

    it('rejects a status outside the enum and a patch that drops a required field', async () => {
        const order = A.store.getByReference('order', 'ORD-1');
        await assert.rejects(A.store.update(order.id, { status: 'lost' }), /status must be one of/);
        await assert.rejects(A.store.update(order.id, { data: { amount: null } }), /needs "amount"/);
    });

    it('emits lead.updated for a plain field change, since the Phase 6 list names it', async () => {
        const lead = await A.store.create('lead', { data: { name: 'Asha' } });
        assert.equal(A.events.at(-1).type, 'lead.created');
        await A.store.update(lead.id, { data: { interest: 'premium' } });
        assert.equal(A.events.at(-1).type, 'lead.updated');
        await A.store.update(lead.id, { status: 'qualified' });
        assert.equal(A.events.at(-1).type, 'lead.updated');
    });

    it('does not swallow a failed dispatch: the object is saved, the trail says so, the caller is told', async () => {
        A.store.failNext = true;
        await assert.rejects(
            A.store.create('order', { reference: 'ORD-FAIL', data: { amount: 9 } }),
            (err) => err.status === 502 && /could not be dispatched/.test(err.message) && err.object.reference === 'ORD-FAIL',
        );
        const saved = A.store.getByReference('order', 'ORD-FAIL');
        assert.ok(saved, 'the write is durable even when the engine is not');
        const trail = A.store.events(saved.id);
        assert.equal(trail.at(-1).change, 'emit_failed');
        assert.equal(trail.at(-1).field, 'order.created');
        assert.equal(trail.at(-1).to, 'engine down');
    });

    it('filters by status, contact, JSON data and occurs_at range', async () => {
        await A.store.create('appointment', { reference: 'AP-1', contactId: 3, data: { service: 'dental', scheduledAt: '2026-10-10T09:00:00Z' } });
        await A.store.create('appointment', { reference: 'AP-2', contactId: 4, data: { service: 'dental', scheduledAt: '2026-10-20T09:00:00Z' }, status: 'confirmed' });
        await A.store.create('appointment', { reference: 'AP-3', contactId: 3, data: { service: 'eye', scheduledAt: '2026-10-30T09:00:00Z' } });

        const refs = (opts) => A.store.list({ type: 'appointment', ...opts }).map((o) => o.reference).sort();
        assert.deepEqual(refs({}), ['AP-1', 'AP-2', 'AP-3']);
        assert.deepEqual(refs({ status: 'confirmed' }), ['AP-2']);
        assert.deepEqual(refs({ contactId: 3 }), ['AP-1', 'AP-3']);
        assert.deepEqual(refs({ filter: { service: 'dental' } }), ['AP-1', 'AP-2']);
        assert.deepEqual(refs({ from: '2026-10-15', to: '2026-10-25' }), ['AP-2']);
        assert.equal(A.store.count({ type: 'appointment', filter: { service: 'eye' } }), 1);
        assert.deepEqual(A.store.list({ type: 'order', filter: { amount: 250 } }).map((o) => o.reference), ['ORD-1']);
    });

    it('promotes the registry\'s occursAt field to a column and keeps it in sync', async () => {
        const ap = A.store.getByReference('appointment', 'AP-1');
        assert.equal(ap.occursAt, '2026-10-10T09:00:00.000Z');
        const moved = await A.store.update(ap.id, { data: { scheduledAt: '2026-10-11T09:00:00Z' } });
        assert.equal(moved.occursAt, '2026-10-11T09:00:00.000Z');
        assert.equal(A.events.at(-1).type, 'appointment.updated');
    });

    it('due() reads what "24 hours before" and "overdue" need, skipping closed objects', async () => {
        const upcoming = A.store.due({ type: 'appointment', before: '2026-10-12T00:00:00Z' }).map((o) => o.reference);
        assert.deepEqual(upcoming, ['AP-1']);
        const all = A.store.due({ type: 'appointment', before: '2027-01-01' }).map((o) => o.reference);
        assert.deepEqual(all, ['AP-1', 'AP-2', 'AP-3']);

        const ap2 = A.store.getByReference('appointment', 'AP-2');
        await A.store.update(ap2.id, { status: 'cancelled' });
        assert.ok(!A.store.due({ type: 'appointment', before: '2027-01-01' }).some((o) => o.reference === 'AP-2'));
    });

    it('sweepDue emits each due event once, however often it runs', async () => {
        const first = await A.store.sweepDue({ type: 'appointment', before: '2027-01-01' });
        assert.deepEqual(first.emitted.map((id) => A.store.get(id).reference), ['AP-1', 'AP-3']);
        assert.equal(A.events.at(-1).type, 'appointment.due');
        assert.equal(A.events.at(-1).source, 'scheduler');

        const again = await A.store.sweepDue({ type: 'appointment', before: '2027-01-01' });
        assert.deepEqual(again, { emitted: [], failed: [] });

        // A type with no due event is a no-op, not an error.
        assert.deepEqual(await A.store.sweepDue({ type: 'lead' }), { emitted: [], failed: [] });
    });

    it('sweepDue keeps going when one dispatch fails', async () => {
        await A.store.create('payment', { reference: 'PAY-1', data: { amount: 10, dueAt: '2026-10-01' } });
        await A.store.create('payment', { reference: 'PAY-2', data: { amount: 10, dueAt: '2026-10-02' } });
        A.store.failNext = true;
        const result = await A.store.sweepDue({ type: 'payment', before: '2026-10-05' });
        assert.equal(result.failed.length, 1);
        assert.equal(result.emitted.length, 1);
        const retry = await A.store.sweepDue({ type: 'payment', before: '2026-10-05' });
        assert.equal(retry.emitted.length, 1, 'the failed one is still due');
    });

    it('isolates tenants: another tenant\'s id reads as nothing', async () => {
        const mine = A.store.getByReference('order', 'ORD-1');
        assert.equal(B.store.get(mine.id), null);
        assert.deepEqual(B.store.events(mine.id), []);
        await assert.rejects(B.store.update(mine.id, { status: 'cancelled' }), /not found/);
        assert.throws(() => B.store.remove(mine.id), /not found/);
        assert.equal(A.store.get(mine.id).status, 'shipped');
        assert.ok(!B.store.list({}).some((o) => o.tenantId !== 2));
        assert.equal(B.stats?.total ?? B.store.stats().total, 1);
    });

    it('remove keeps the trail', async () => {
        const gone = A.store.remove(A.store.getByReference('order', 'ORD-FAIL').id);
        assert.equal(A.store.get(gone.id), null);
        assert.equal(A.store.events(gone.id).at(-1).change, 'deleted');
    });

    it('stats counts by type and status', () => {
        const stats = A.store.stats();
        assert.equal(stats.byType.order.byStatus.shipped, 1);
        assert.equal(stats.byType.appointment.byStatus.cancelled, 1);
        assert.equal(stats.total, Object.values(stats.byType).reduce((n, t) => n + t.total, 0));
    });
});

describe('with the real workflow engine', () => {
    it('an order.created event starts the workflow that listens for it', async () => {
        const scoped = db.forTenant(1);
        const channels = new Channels(scoped);
        const channel = channels.create({ displayName: 'T1', phoneNumber: '919100000001', isDefault: true });
        const contacts = new ContactStore(scoped, '91');
        const contact = contacts.upsert({ phone: '9876543210', name: 'Ravi' });
        const sent = [];
        const engine = new WorkflowEngine({
            store: new WorkflowStore(scoped), contacts, channels,
            messages: { send: (job) => { sent.push(job); return { accepted: true, messageId: `m${sent.length}` }; } },
            renderTemplate: () => ({ text: '' }),
        });
        engine.store.create({
            name: 'confirm', status: 'active', channelId: channel.id,
            trigger: { type: 'order.created' },
            steps: [{ id: 'a', action: 'send_message', params: { text: 'Order {reference} for {amount} received, {name}' }, next: null }],
        });

        // Channel-scoped, as the router is: a workflow pinned to a channel only
        // matches events that carry that channel id.
        const objects = new ObjectStore(scoped.forChannel(channel.id), { emit: (event) => engine.dispatch(event) });
        await objects.create('order', { reference: 'ORD-WF', contactId: contact.id, data: { amount: 499 } });

        assert.equal(sent.length, 1);
        assert.equal(sent[0].text, 'Order ORD-WF for 499 received, Ravi');
    });
});

describe('the routes', () => {
    let base;
    let server;
    const state = { engine: null, broadcast: () => {} };
    const call = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    before(async () => {
        state.engine = { dispatched: [], async dispatch(event) { this.dispatched.push(event); return []; } };
        const app = express();
        app.use(express.json());
        app.use(createObjectRouter({ db: db.forTenant(1).forChannel(1), state }));
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => server?.close());

    it('exposes the registry', async () => {
        const { status, body } = await call('GET', '/object-types');
        assert.equal(status, 200);
        assert.equal(body.types.order.defaultStatus, 'placed');
        assert.ok(body.eventTypes.includes('payment.due'));
        assert.equal(body.types.ticket, undefined);
    });

    it('creates, reads, filters, updates, lists events and deletes', async () => {
        const created = await call('POST', '/objects/order', { reference: 'ORD-API', contactId: 1, data: { amount: 10 } });
        assert.equal(created.status, 201);
        const id = created.body.object.id;
        assert.equal(created.body.object.channelId, 1);
        assert.equal(state.engine.dispatched.at(-1).type, 'order.created');

        assert.equal((await call('GET', `/objects/order/${id}`)).body.object.reference, 'ORD-API');
        assert.equal((await call('GET', '/objects/order?data.amount=10')).body.objects.length, 1);
        assert.equal((await call('GET', '/objects/order?status=placed&limit=1')).body.total >= 1, true);

        const updated = await call('PUT', `/objects/order/${id}`, { status: 'confirmed' });
        assert.equal(updated.body.object.status, 'confirmed');
        assert.equal(state.engine.dispatched.at(-1).type, 'order.status_changed');

        const events = await call('GET', `/objects/order/${id}/events`);
        assert.deepEqual(events.body.events.map((e) => e.change), ['created', 'status']);

        assert.deepEqual((await call('DELETE', `/objects/order/${id}`)).body, { deleted: id });
        assert.equal((await call('GET', `/objects/order/${id}`)).status, 404);
    });

    it('answers 400 for bad input, 404 for an unknown type, a wrong type or another tenant\'s id', async () => {
        assert.equal((await call('POST', '/objects/order', { data: {} })).status, 400);
        assert.equal((await call('POST', '/objects/invoice', { data: {} })).status, 404);
        assert.equal((await call('GET', '/objects/invoice')).status, 404);
        const ap = A.store.getByReference('appointment', 'AP-1');
        assert.equal((await call('GET', `/objects/order/${ap.id}`)).status, 404, 'right id, wrong type');
        const theirs = B.store.getByReference('order', 'ORD-1');
        assert.equal((await call('GET', `/objects/order/${theirs.id}`)).status, 404);
        assert.equal((await call('PUT', `/objects/order/${theirs.id}`, { status: 'cancelled' })).status, 404);
        assert.equal(B.store.get(theirs.id).status, 'placed');
    });

    it('serves due objects and stats', async () => {
        const due = await call('GET', '/objects/appointment/due?before=2027-01-01');
        assert.deepEqual(due.body.objects.map((o) => o.reference), ['AP-1', 'AP-3']);
        assert.equal((await call('GET', '/objects/appointment/due?before=soon')).status, 400);
        const stats = await call('GET', '/objects-stats');
        assert.ok(stats.body.byType.appointment.total >= 3);
    });

    it('reports a failed dispatch as 502 with the saved object', async () => {
        state.engine.dispatch = async () => { throw new Error('engine down'); };
        const res = await call('POST', '/objects/lead', { reference: 'L-502', data: { name: 'x' } });
        assert.equal(res.status, 502);
        assert.equal(res.body.object.reference, 'L-502');
        assert.match(res.body.errors[0], /could not be dispatched/);
        assert.ok(A.store.getByReference('lead', 'L-502'));
    });
});
