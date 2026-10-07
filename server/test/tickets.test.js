/**
 * Phase 9: the ticket engine.
 *
 * The claims under test: a reference is unique and per-tenant; every field
 * change leaves a history row and nothing ever updates one; the SLA comes from
 * the priority and moves when the priority does; stats report a median, not a
 * mean; the customer is messaged only when a caller asks; and guessing another
 * tenant's id or reference gets a 404, not a ticket.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { Database } from '../src/db.js';
import { createTicketRouter } from '../src/tickets/routes.js';
import { TICKETS_SCHEMA } from '../src/tickets/schema.js';
import { SLA_HOURS, TicketError, TicketStore, slaDueAt } from '../src/tickets/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tickets-'));
let db;
let clock = new Date('2026-10-08T10:00:00Z');
const now = () => clock;
const tick = (hours) => { clock = new Date(clock.getTime() + hours * 3600_000); };

let A;
let B;

before(() => {
    db = new Database(path.join(tmp, 't.db'));
    db.db.exec(TICKETS_SCHEMA);
    db.db.prepare("INSERT INTO tenants (id, name, slug, status, created_at) VALUES (2, 'B', 'tb', 'active', ?)")
        .run('2026-01-01T00:00:00+00:00');
    A = new TicketStore(db.forTenant(1).forChannel(7), { now });
    B = new TicketStore(db.forTenant(2), { now });
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('creating a ticket', () => {
    it('allocates a per-tenant reference and a created event', () => {
        const a1 = A.create({ subject: 'order never arrived', contactId: 11 });
        const a2 = A.create({ subject: 'wrong size' });
        assert.equal(a1.reference, 'TKT-0001');
        assert.equal(a2.reference, 'TKT-0002');
        // Tenant B starts its own numbering, so the reference leaks no volume.
        assert.equal(B.create({ subject: 'b complaint' }).reference, 'TKT-0001');

        assert.equal(a1.status, 'OPEN');
        assert.equal(a1.priority, 'normal');
        assert.equal(a1.source, 'manual');
        assert.equal(a1.channelId, 7);
        const events = A.events(a1.id);
        assert.equal(events.length, 1);
        assert.equal(events[0].kind, 'created');
        assert.equal(events[0].to, 'OPEN');
    });

    it('sets sla_due_at from the priority', () => {
        const urgent = A.create({ subject: 'down', priority: 'urgent' });
        assert.equal(urgent.slaDueAt, slaDueAt(urgent.createdAt, 'urgent'));
        assert.equal(
            Date.parse(urgent.slaDueAt) - Date.parse(urgent.createdAt),
            SLA_HOURS.urgent * 3600_000,
        );
    });

    it('falls back to safe values instead of storing junk', () => {
        const t = A.create({ subject: 's', priority: 'immediately', status: 'PENDING', source: 'telepathy' });
        assert.equal(t.priority, 'normal');
        assert.equal(t.status, 'OPEN');
        assert.equal(t.source, 'manual');
    });
});

describe('the history', () => {
    it('records one row per field that actually changed', () => {
        const t = A.create({ subject: 'late delivery', contactId: 11 });
        const before = A.events(t.id).length;

        A.update(t.id, { status: 'IN_PROGRESS', assignedTo: 5 }, { userId: 42, note: 'picked up' });
        const events = A.events(t.id).slice(before);
        assert.deepEqual(events.map((e) => e.kind), ['status', 'assigned']);
        assert.equal(events[0].from, 'OPEN');
        assert.equal(events[0].to, 'IN_PROGRESS');
        assert.equal(events[0].body, 'picked up');
        assert.equal(events[0].userId, 42);
        assert.equal(events[1].to, '5');
    });

    it('writes nothing when a patch changes nothing', () => {
        const t = A.create({ subject: 'no-op' });
        const before = A.events(t.id).length;
        const same = A.update(t.id, { status: 'OPEN', subject: 'no-op' });
        assert.equal(A.events(t.id).length, before);
        assert.equal(same.updatedAt, t.updatedAt);
    });

    it('records a note without changing the ticket', () => {
        const t = A.create({ subject: 'notes' });
        const event = A.addNote(t.id, 'called the courier', { userId: 9 });
        assert.equal(event.kind, 'note');
        assert.equal(event.body, 'called the courier');
        assert.deepEqual(A.get(t.id).updatedAt, t.updatedAt);
        assert.throws(() => A.addNote(t.id, '   '), TicketError);
    });

    it('is append-only: no UPDATE statement anywhere touches ticket_events', () => {
        const source = fs.readFileSync(new URL('../src/tickets/store.js', import.meta.url), 'utf8')
            + fs.readFileSync(new URL('../src/tickets/routes.js', import.meta.url), 'utf8');
        assert.equal(/UPDATE\s+ticket_events/i.test(source), false);
        assert.equal(/DELETE\s+FROM\s+ticket_events/i.test(source), false);
    });
});

describe('status, priority and SLA', () => {
    it('moves the SLA when the priority moves', () => {
        const t = A.create({ subject: 'sla', priority: 'low' });
        const raised = A.setPriority(t.id, 'urgent', { userId: 1 });
        assert.equal(raised.slaDueAt, slaDueAt(t.createdAt, 'urgent'));
        assert.ok(A.events(t.id).some((e) => e.kind === 'priority' && e.to === 'urgent'));
        assert.throws(() => A.setPriority(t.id, 'whenever'), TicketError);
        assert.throws(() => A.setStatus(t.id, 'DONE'), TicketError);
    });

    it('stamps resolved_at once and records the first response once', () => {
        const t = A.create({ subject: 'resolve me' });
        tick(1);
        const answered = A.recordFirstResponse(t.id, { userId: 3 });
        assert.ok(answered.firstResponseAt);
        // A second call is a no-op: first response means first.
        assert.equal(A.recordFirstResponse(t.id).firstResponseAt, answered.firstResponseAt);

        tick(2);
        const resolved = A.resolve(t.id, { userId: 3 });
        assert.equal(resolved.status, 'RESOLVED');
        assert.equal(Date.parse(resolved.resolvedAt) - Date.parse(t.createdAt), 3 * 3600_000);
        const closed = A.close(t.id, { userId: 3 });
        assert.equal(closed.status, 'CLOSED');
        assert.equal(closed.resolvedAt, resolved.resolvedAt);
    });

    it('lists SLA breaches and leaves closed tickets out of them', () => {
        const fresh = new TicketStore(db.forTenant(2), { now });
        const breached = fresh.create({ subject: 'breached', priority: 'urgent' });
        const fine = fresh.create({ subject: 'fine', priority: 'low' });
        const ignored = fresh.create({ subject: 'closed and late', priority: 'urgent' });
        fresh.close(ignored.id);

        tick(4); // past the 2h urgent SLA, inside the 72h low one
        const ids = fresh.overdue().map((t) => t.id);
        assert.ok(ids.includes(breached.id));
        assert.ok(!ids.includes(fine.id));
        assert.ok(!ids.includes(ignored.id));
        assert.deepEqual(fresh.list({ overdue: true }).map((t) => t.id), ids);
    });
});

describe('satisfaction', () => {
    it('records a 1-5 score and rejects anything else', () => {
        const t = A.create({ subject: 'csat' });
        const scored = A.recordSatisfaction(t.id, 4, 'quick enough');
        assert.equal(scored.satisfactionScore, 4);
        assert.equal(scored.satisfactionComment, 'quick enough');
        for (const bad of [0, 6, 'great', 3.5, null]) {
            assert.throws(() => A.recordSatisfaction(t.id, bad), TicketError);
        }
    });
});

describe('listing and stats', () => {
    it('filters by status, priority, assignee and contact', () => {
        const store = new TicketStore(db.forTenant(2), { now });
        const mine = store.create({ subject: 'mine', priority: 'high', contactId: 99 });
        store.assign(mine.id, 5);
        store.setStatus(mine.id, 'WAITING_CUSTOMER');

        assert.ok(store.list({ status: 'WAITING_CUSTOMER' }).some((t) => t.id === mine.id));
        assert.ok(store.list({ priority: 'high' }).some((t) => t.id === mine.id));
        assert.ok(store.list({ assignedTo: 5 }).some((t) => t.id === mine.id));
        assert.ok(store.list({ contactId: 99 }).every((t) => t.contactId === 99));
        assert.ok(store.list({ assignedTo: 'unassigned' }).every((t) => t.assignedTo === null));
        assert.ok(!store.list({ assignedTo: 'unassigned' }).some((t) => t.id === mine.id));
    });

    it('reports counts, overdue and a median time-to-resolve', () => {
        const scoped = db.forTenant(1);
        scoped.db.prepare('DELETE FROM tickets WHERE tenant_id = 1').run();
        const store = new TicketStore(scoped, { now });
        const start = clock;

        // Three resolved tickets at 1h, 2h and 9h: the median is 2h, the mean
        // would be four.
        for (const hours of [1, 2, 9]) {
            clock = start;
            const t = store.create({ subject: `r${hours}` });
            tick(hours);
            store.resolve(t.id);
        }
        clock = start;
        store.create({ subject: 'open', priority: 'urgent' });
        tick(5);

        const stats = store.stats();
        assert.equal(stats.total, 4);
        assert.equal(stats.byStatus.RESOLVED, 3);
        assert.equal(stats.byStatus.OPEN, 1);
        assert.equal(stats.byStatus.CLOSED, 0);
        assert.equal(stats.byPriority.urgent, 1);
        assert.equal(stats.byPriority.normal, 3);
        assert.equal(stats.overdue, 1);
        assert.equal(stats.medianResolveSeconds, 2 * 3600);
    });
});

describe('tenant isolation', () => {
    it('refuses another tenant\'s id and reference', () => {
        const mine = A.create({ subject: 'tenant 1 only' });
        assert.equal(B.get(mine.id), null);
        assert.throws(() => B.update(mine.id, { status: 'CLOSED' }), /not found/);
        assert.throws(() => B.events(mine.id), /not found/);
        assert.throws(() => B.addNote(mine.id, 'peeking'), /not found/);
        // Both tenants own a TKT-0001; neither sees the other's.
        assert.notEqual(A.getByReference('TKT-0001').tenantId, B.getByReference('TKT-0001').tenantId);
        assert.ok(B.list({ limit: 1000 }).every((t) => t.tenantId === 2));
    });
});

describe('the routes', () => {
    let server;
    let base;
    const sent = [];
    const contacts = { get: (id) => (id === 11 ? { id: 11, phone: '919000000011', name: 'Asha' } : null) };

    before(async () => {
        const app = express();
        app.use(express.json());
        app.use('/api', createTicketRouter({
            db: db.forTenant(3).forChannel(1),
            state: {
                channel: { id: 1 },
                contacts,
                messages: { send: (job) => { sent.push(job); return { accepted: true, messageId: `m${sent.length}` }; } },
                broadcast: () => {},
            },
        }));
        db.db.prepare("INSERT INTO tenants (id, name, slug, status, created_at) VALUES (3, 'C', 'tc', 'active', ?)")
            .run('2026-01-01T00:00:00+00:00');
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}/api`;
    });

    after(() => server?.close());

    const call = async (method, url, body) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
    };

    it('creates, reads, patches and lists', async () => {
        const bad = await call('POST', '/tickets', {});
        assert.equal(bad.status, 400);
        assert.ok(bad.body.errors[0]);

        const made = await call('POST', '/tickets', { subject: 'broken item', contactId: 11, priority: 'high' });
        assert.equal(made.status, 201);
        const id = made.body.ticket.id;
        assert.equal(made.body.ticket.priority, 'high');

        assert.equal((await call('GET', `/tickets/${id}`)).body.ticket.id, id);
        // Looking a ticket up by the reference a customer quotes.
        assert.equal((await call('GET', `/tickets/${made.body.ticket.reference}`)).body.ticket.id, id);
        assert.equal((await call('GET', '/tickets/9999')).status, 404);

        const patched = await call('PATCH', `/tickets/${id}`, { status: 'IN_PROGRESS', assignedTo: 2 });
        assert.equal(patched.body.ticket.status, 'IN_PROGRESS');
        assert.equal(patched.body.notified, false);

        const listed = await call('GET', '/tickets?status=IN_PROGRESS');
        assert.ok(listed.body.tickets.some((t) => t.id === id));
        assert.equal((await call('GET', '/tickets/stats')).body.stats.byStatus.IN_PROGRESS >= 1, true);
    });

    it('messages the customer only when the caller asks, and only on a close-out', async () => {
        const { body: { ticket } } = await call('POST', '/tickets', { subject: 'notify me', contactId: 11 });
        sent.length = 0;

        // A plain edit stays silent even with notify: true - nothing was closed out.
        await call('PATCH', `/tickets/${ticket.id}`, { subject: 'notify me please', notify: true });
        assert.equal(sent.length, 0);

        // Resolving without asking is also silent.
        await call('PATCH', `/tickets/${ticket.id}`, { status: 'IN_PROGRESS' });
        await call('PATCH', `/tickets/${ticket.id}`, { status: 'RESOLVED' });
        assert.equal(sent.length, 0);

        const closed = await call('PATCH', `/tickets/${ticket.id}`, { status: 'CLOSED', notify: true });
        assert.equal(closed.body.notified, true);
        assert.equal(sent.length, 1);
        assert.equal(sent[0].recipient, '919000000011');
        assert.equal(sent[0].messageType, 'transactional');
        assert.equal(sent[0].idempotencyKey, `ticket:${ticket.id}:CLOSED`);
        assert.ok(sent[0].text.includes(ticket.reference));
        // The outbound message is part of the history.
        const events = await call('GET', `/tickets/${ticket.id}/events`);
        assert.ok(events.body.events.some((e) => e.kind === 'message'));
    });

    it('does not message a ticket with no contact', async () => {
        const { body: { ticket } } = await call('POST', '/tickets', { subject: 'anonymous' });
        sent.length = 0;
        const res = await call('PATCH', `/tickets/${ticket.id}`, { status: 'RESOLVED', notify: true });
        assert.equal(res.body.notified, false);
        assert.equal(sent.length, 0);
    });

    it('takes notes and a satisfaction score, and rejects a bad one', async () => {
        const { body: { ticket } } = await call('POST', '/tickets', { subject: 'feedback' });
        const note = await call('POST', `/tickets/${ticket.id}/notes`, { body: 'rang the customer' });
        assert.equal(note.status, 201);
        assert.equal(note.body.event.kind, 'note');
        assert.equal((await call('POST', `/tickets/${ticket.id}/notes`, { body: '' })).status, 400);

        const scored = await call('POST', `/tickets/${ticket.id}/satisfaction`, { score: 5, comment: 'great' });
        assert.equal(scored.body.ticket.satisfactionScore, 5);
        assert.equal((await call('POST', `/tickets/${ticket.id}/satisfaction`, { score: 9 })).status, 400);
        assert.equal((await call('POST', '/tickets/4242/notes', { body: 'x' })).status, 404);
    });
});
