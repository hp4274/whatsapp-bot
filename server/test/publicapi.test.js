/**
 * Phase 16: the external API and outbound webhooks.
 *
 * The claims under test:
 *   - an API key is a credential, so the plaintext exists exactly once and
 *     `list()` can never hand one back;
 *   - a revoked or expired key stops working immediately;
 *   - scopes are enforced per route, not per key-holder's good intentions;
 *   - a key reaches exactly one tenant's data and 403s against another's;
 *   - a retried POST with an Idempotency-Key returns the original result and
 *     creates nothing new;
 *   - every webhook delivery is signed over body *and* timestamp, so a
 *     capture cannot be replayed;
 *   - delivery retries come from the Phase 7 scheduler, not from a loop here.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { ObjectStore } from '../src/objects/store.js';
import { ApiKeyStore } from '../src/publicapi/keys.js';
import { PUBLIC_API_SCHEMA } from '../src/publicapi/schema.js';
import { createPublicApiRouter } from '../src/publicapi/routes.js';
import {
    SIGNATURE_HEADER, WEBHOOK_EVENTS, WEBHOOK_JOB_KIND, WebhookStore,
    createWebhookDeliveryHandler, createWebhookEmitter, signPayload, verifySignature,
} from '../src/publicapi/webhooks.js';
import { JobStore } from '../src/scheduler/store.js';
import { SchedulerWorker } from '../src/scheduler/worker.js';
import { TicketStore } from '../src/tickets/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-publicapi-'));
const ALL_SCOPES = ['events:write', 'contacts:read', 'contacts:write', 'objects:read', 'objects:write', 'tickets:write'];
let db;

before(() => {
    db = new Database(path.join(tmp, 'p.db'));
    db.db.exec(PUBLIC_API_SCHEMA);
    db.db.prepare("INSERT INTO tenants (id, name, slug, status, created_at) VALUES (2, 'B', 'b', 'active', ?)")
        .run('2026-01-01T00:00:00+00:00');
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('api keys', () => {
    it('returns the plaintext key once and never again', () => {
        const keys = new ApiKeyStore(db.forTenant(1));
        const created = keys.createKey({ name: 'Shopify', scopes: ['objects:write'] });
        assert.match(created.key, /^wsk_[\w-]{20,}$/);
        assert.equal(created.prefix, created.key.slice(0, 12));

        // Neither the read path nor the raw row can reproduce it.
        assert.equal(keys.get(created.id).key, undefined);
        assert.ok(!keys.list().some((k) => 'key' in k));
        const row = db.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(created.id);
        assert.ok(!String(row.key_hash).includes(created.key));
        assert.equal(row.key_hash.length, 64); // sha256 hex, like a session token
    });

    it('verifies a live key into a tenant and scopes', () => {
        const keys = new ApiKeyStore(db.forTenant(1));
        const created = keys.createKey({ name: 'ERP', scopes: ['events:write', 'contacts:read'] });
        assert.deepEqual(keys.verify(created.key), {
            id: created.id, tenantId: 1, scopes: ['events:write', 'contacts:read'],
        });
        assert.equal(keys.verify('wsk_nope'), null);
        assert.equal(keys.verify(''), null);
        assert.equal(keys.verify(null), null);
    });

    it('stops verifying once revoked', () => {
        const keys = new ApiKeyStore(db.forTenant(1));
        const created = keys.createKey({ scopes: ['objects:read'] });
        assert.ok(keys.verify(created.key));
        assert.ok(keys.revoke(created.id).revokedAt);
        assert.equal(keys.verify(created.key), null);
    });

    it('stops verifying once expired', () => {
        const keys = new ApiKeyStore(db.forTenant(1));
        const expired = keys.createKey({ scopes: ['objects:read'], expiresAt: '2020-01-01T00:00:00Z' });
        assert.equal(keys.verify(expired.key), null);
        const live = keys.createKey({ scopes: ['objects:read'], expiresAt: '2099-01-01T00:00:00Z' });
        assert.ok(keys.verify(live.key));
    });

    it('rejects an unknown or empty scope rather than dropping it', () => {
        const keys = new ApiKeyStore(db.forTenant(1));
        assert.throws(() => keys.createKey({ scopes: ['contacts:delete'] }), /unknown scope/);
        assert.throws(() => keys.createKey({ scopes: [] }), /at least one/);
        assert.throws(() => keys.createKey({ scopes: ['objects:read'], expiresAt: 'soon' }), /date-time/);
    });

    it('records last_used_at so Phase 18 has something to rate-limit on', () => {
        const keys = new ApiKeyStore(db.forTenant(1));
        const created = keys.createKey({ scopes: ['objects:read'] });
        assert.equal(created.lastUsedAt, null);
        keys.touch(created.id);
        assert.ok(keys.get(created.id).lastUsedAt);
    });

    it('keeps one tenant out of another tenant\'s keys', () => {
        const a = new ApiKeyStore(db.forTenant(1));
        const b = new ApiKeyStore(db.forTenant(2));
        const mine = b.createKey({ name: 'B key', scopes: ['objects:read'] });
        assert.ok(!a.list().some((k) => k.id === mine.id));
        assert.equal(a.get(mine.id), null);
        assert.throws(() => a.revoke(mine.id), /not found/);
        // Still live: A's attempt changed nothing.
        assert.equal(b.verify(mine.key).tenantId, 2);
    });
});

describe('webhook signatures', () => {
    const secret = 'shhh';
    const body = JSON.stringify({ event: 'ticket.created', data: { id: 1 } });

    it('round-trips', () => {
        assert.ok(verifySignature(body, signPayload(body, secret), secret));
    });

    it('fails on a tampered body, a wrong secret or a malformed header', () => {
        const header = signPayload(body, secret);
        assert.equal(verifySignature(`${body} `, header, secret), false);
        assert.equal(verifySignature(body, header, 'other'), false);
        assert.equal(verifySignature(body, 'garbage', secret), false);
        assert.equal(verifySignature(body, '', secret), false);
        assert.equal(verifySignature(body, 't=1,v1=zz', secret), false);
    });

    it('refuses a replayed capture, because the timestamp is signed too', () => {
        const old = signPayload(body, secret, Date.now() - 60 * 60 * 1000);
        assert.equal(verifySignature(body, old, secret), false);
        // The attacker cannot freshen the timestamp without the secret.
        const forged = old.replace(/t=\d+/, `t=${Math.floor(Date.now() / 1000)}`);
        assert.equal(verifySignature(body, forged, secret), false);
        // Still valid inside the tolerance.
        assert.ok(verifySignature(body, old, secret, { toleranceMs: 2 * 60 * 60 * 1000 }));
    });
});

describe('webhook endpoints and fan-out', () => {
    it('validates the url and the event list', () => {
        const hooks = new WebhookStore(db.forTenant(1));
        assert.throws(() => hooks.createEndpoint({ url: 'not-a-url', events: ['ticket.created'] }), /http\(s\) URL/);
        assert.throws(() => hooks.createEndpoint({ url: 'ftp://x.test/h', events: ['ticket.created'] }), /http\(s\) URL/);
        assert.throws(() => hooks.createEndpoint({ url: 'https://x.test/h', events: ['ticket.exploded'] }), /unknown webhook event/);
        assert.throws(() => hooks.createEndpoint({ url: 'https://x.test/h', events: [] }), /at least one/);
    });

    it('covers every Phase 16 event name', () => {
        assert.deepEqual([...WEBHOOK_EVENTS].sort(), [
            'message.delivered', 'message.failed', 'message.received',
            'ticket.created', 'ticket.updated',
            'workflow.completed', 'workflow.failed', 'workflow.started',
        ]);
    });

    it('delivers only to active, subscribed endpoints, one job each', () => {
        const scoped = db.forTenant(1);
        const hooks = new WebhookStore(scoped);
        const jobs = new JobStore(scoped);
        for (const e of hooks.listEndpoints()) hooks.removeEndpoint(e.id);

        const wanted = hooks.createEndpoint({ url: 'https://a.test/h', events: ['ticket.created', 'ticket.updated'] });
        const other = hooks.createEndpoint({ url: 'https://b.test/h', events: ['message.failed'] });
        const off = hooks.createEndpoint({ url: 'https://c.test/h', events: ['ticket.created'], isActive: false });
        assert.ok(wanted.secret.length >= 32); // generated, not optional

        const created = hooks.enqueue({ type: 'ticket.created', payload: { id: 9 } }, jobs);
        assert.deepEqual(created.map((d) => d.endpointId), [wanted.id]);
        assert.equal(created[0].status, 'pending');
        assert.equal(created[0].payload.data.id, 9);
        assert.ok(created[0].payload.occurredAt);

        const queued = jobs.list({ kind: WEBHOOK_JOB_KIND });
        assert.equal(queued.length, 1);
        assert.equal(queued[0].payload.deliveryId, created[0].id);
        assert.equal(queued[0].maxAttempts, 5);

        // An unsubscribed event and an unknown one both fan out to nobody.
        assert.deepEqual(hooks.enqueue({ type: 'workflow.failed', payload: {} }, jobs), []);
        assert.deepEqual(hooks.enqueue({ type: 'order.created', payload: {} }, jobs), []);
        assert.equal(jobs.list({ kind: WEBHOOK_JOB_KIND }).length, 1);

        hooks.removeEndpoint(off.id);
        hooks.removeEndpoint(other.id);
    });

    it('emits without throwing when the queue is unhappy', () => {
        const errors = [];
        const emit = createWebhookEmitter({
            db: db.forTenant(1),
            jobs: { schedule() { throw new Error('disk full'); } },
            onError: (err) => errors.push(err.message),
        });
        assert.deepEqual(emit('ticket.created', { id: 1 }), []);
        assert.deepEqual(errors, ['disk full']);
    });
});

describe('webhook delivery through the scheduler', () => {
    const scoped = () => db.forTenant(1);

    /** One endpoint, one queued delivery, and a fetch we control. */
    const setup = (fetchImpl) => {
        const handle = scoped();
        const hooks = new WebhookStore(handle);
        const jobs = new JobStore(handle);
        for (const e of hooks.listEndpoints()) hooks.removeEndpoint(e.id);
        const endpoint = hooks.createEndpoint({ url: 'https://hook.test/in', events: ['ticket.created'] });
        const [delivery] = hooks.enqueue({ type: 'ticket.created', payload: { id: 42 } }, jobs);
        const calls = [];
        const handler = createWebhookDeliveryHandler({
            db: handle,
            fetch: async (url, options) => {
                calls.push({ url, options });
                return fetchImpl(url, options);
            },
        });
        return { hooks, jobs, endpoint, delivery, handler, calls };
    };

    it('signs the body it actually sends and marks the delivery delivered', async () => {
        const { hooks, endpoint, delivery, handler, calls } = setup(async () => new Response('', { status: 200 }));
        await handler({ deliveryId: delivery.id }, { tenantId: 1, attempt: 1 });

        assert.equal(calls.length, 1);
        const { url, options } = calls[0];
        assert.equal(url, 'https://hook.test/in');
        assert.equal(options.headers['x-webhook-event'], 'ticket.created');
        // The signature is over the exact bytes on the wire, which is the only
        // thing a receiver can check.
        assert.ok(verifySignature(options.body, options.headers[SIGNATURE_HEADER], endpoint.secret));
        assert.equal(JSON.parse(options.body).data.id, 42);

        const saved = hooks.getDelivery(delivery.id);
        assert.equal(saved.status, 'delivered');
        assert.equal(saved.responseCode, 200);
        assert.equal(saved.attempt, 1);
    });

    it('throws on a 5xx so the scheduler retries, and records the attempt', async () => {
        const { hooks, delivery, handler } = setup(async () => new Response('nope', { status: 503 }));
        await assert.rejects(handler({ deliveryId: delivery.id }, { tenantId: 1, attempt: 1 }), /503/);
        const saved = hooks.getDelivery(delivery.id);
        assert.equal(saved.status, 'pending'); // still owed
        assert.equal(saved.responseCode, 503);
    });

    it('does not retry a 404, because more attempts will not fix a wrong url', async () => {
        const { hooks, delivery, handler } = setup(async () => new Response('', { status: 404 }));
        await handler({ deliveryId: delivery.id }, { tenantId: 1, attempt: 1 });
        const saved = hooks.getDelivery(delivery.id);
        assert.equal(saved.status, 'failed');
        assert.equal(saved.responseCode, 404);
    });

    it('retries a transport failure', async () => {
        const { hooks, delivery, handler } = setup(async () => { throw new Error('ECONNREFUSED'); });
        await assert.rejects(handler({ deliveryId: delivery.id }, { tenantId: 1, attempt: 1 }), /ECONNREFUSED/);
        assert.equal(hooks.getDelivery(delivery.id).status, 'pending');
    });

    it('is a no-op when the endpoint or delivery is gone', async () => {
        const { hooks, endpoint, delivery, handler, calls } = setup(async () => new Response('', { status: 200 }));
        hooks.updateEndpoint(endpoint.id, { isActive: false });
        await handler({ deliveryId: delivery.id }, { tenantId: 1, attempt: 1 });
        assert.equal(calls.length, 0);
        assert.equal(hooks.getDelivery(delivery.id).status, 'failed');
        await handler({ deliveryId: 999_999 }, { tenantId: 1, attempt: 1 });
    });

    it('leaves retry and dead-lettering to the Phase 7 worker', async () => {
        let hits = 0;
        const { hooks, jobs, delivery, handler } = setup(async () => { hits += 1; return new Response('', { status: 500 }); });
        let clock = Date.now();
        const worker = new SchedulerWorker(jobs, {
            now: () => clock,
            setTimeoutFn: (fn) => { fn(); return 0; },
        });
        worker.register(WEBHOOK_JOB_KIND, handler);

        const job = jobs.list({ kind: WEBHOOK_JOB_KIND }).at(-1);
        for (let i = 0; i < 20 && jobs.get(job.id).status !== 'dead'; i += 1) {
            await worker.tick();
            clock += 24 * 60 * 60 * 1000; // past any backoff the policy picked
        }
        assert.equal(hits, 5);                        // maxAttempts, no more
        assert.equal(jobs.get(job.id).status, 'dead'); // the worker's dead-letter, not ours
        assert.equal(hooks.getDelivery(delivery.id).status, 'pending');
    });
});

describe('the /v1 facade', () => {
    let server;
    let base;
    const dispatched = [];
    const keys = () => new ApiKeyStore(db.forTenant(1));
    let full;
    let narrow;
    let otherTenant;

    const call = (method, url, { body, key, idempotencyKey } = {}) => {
        const headers = {};
        if (body) headers['content-type'] = 'application/json';
        if (key) headers.authorization = `Bearer ${key}`;
        if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
        return fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined })
            .then(async (res) => ({ status: res.status, body: await res.json(), replay: res.headers.get('idempotent-replay') }));
    };

    before(async () => {
        const handle = db.forTenant(1).forChannel(1);
        const engine = { async dispatch(event) { dispatched.push(event); return [{ id: 1, status: 'running' }]; } };
        const state = {
            channel: { id: 1 },
            engine,
            contacts: new ContactStore(handle, '91'),
            objects: new ObjectStore(handle, { emit: (e) => engine.dispatch(e) }),
            tickets: new TicketStore(handle),
            broadcast: () => {},
        };
        const app = express();
        app.use(express.json());
        app.use(createPublicApiRouter({ db: handle, state }));
        // Tenant 2's mount, to prove a key cannot cross.
        const handleB = db.forTenant(2).forChannel(1);
        app.use('/b', createPublicApiRouter({
            db: handleB,
            state: {
                channel: { id: 1 },
                engine,
                contacts: new ContactStore(handleB, '91'),
                objects: new ObjectStore(handleB, { emit: (e) => engine.dispatch(e) }),
                tickets: new TicketStore(handleB),
                broadcast: () => {},
            },
        }));
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;

        full = keys().createKey({ name: 'full', scopes: ALL_SCOPES }).key;
        narrow = keys().createKey({ name: 'orders only', scopes: ['objects:write'] }).key;
        otherTenant = new ApiKeyStore(db.forTenant(2)).createKey({ name: 'B', scopes: ALL_SCOPES }).key;
    });

    after(() => server?.close());

    it('manages keys and webhook endpoints, showing secrets only on create', async () => {
        const made = await call('POST', '/api-keys', { body: { name: 'ui', scopes: ['objects:read'] } });
        assert.equal(made.status, 201);
        assert.match(made.body.key.key, /^wsk_/);
        const listed = await call('GET', '/api-keys');
        assert.ok(listed.body.scopes.includes('objects:write'));
        assert.ok(listed.body.keys.every((k) => !('key' in k)));
        assert.equal((await call('POST', '/api-keys', { body: { scopes: ['nope'] } })).status, 400);
        assert.ok((await call('DELETE', `/api-keys/${made.body.key.id}`)).body.key.revokedAt);
        assert.equal((await call('GET', '/v1/', { key: made.body.key.key })).status, 401);
        assert.equal((await call('GET', '/b/api-keys')).body.keys.some((k) => k.id === made.body.key.id), false);

        const ep = await call('POST', '/webhook-endpoints', {
            body: { url: 'https://example.com/hook', events: ['ticket.created'], secret: 'chosen' },
        });
        assert.equal(ep.status, 201);
        assert.ok(ep.body.endpoint.secret && ep.body.endpoint.secret !== 'chosen');
        const eps = await call('GET', '/webhook-endpoints');
        assert.ok(eps.body.events.includes('message.received'));
        assert.equal(eps.body.endpoints.find((e) => e.id === ep.body.endpoint.id).secret, undefined);
        const paused = await call('PUT', `/webhook-endpoints/${ep.body.endpoint.id}`, { body: { isActive: false } });
        assert.equal(paused.body.endpoint.isActive, false);
        assert.deepEqual((await call('GET', `/webhook-endpoints/${ep.body.endpoint.id}/deliveries`)).body, { deliveries: [] });
        assert.equal((await call('PUT', `/b/webhook-endpoints/${ep.body.endpoint.id}`, { body: {} })).status, 404);
        assert.equal((await call('DELETE', `/webhook-endpoints/${ep.body.endpoint.id}`)).status, 200);
    });

    it('refuses an absent, unknown or revoked key', async () => {
        assert.equal((await call('GET', '/v1/')).status, 401);
        assert.equal((await call('GET', '/v1/', { key: 'wsk_bogus' })).status, 401);
        const doomed = keys().createKey({ scopes: ['objects:read'] });
        assert.equal((await call('GET', '/v1/', { key: doomed.key })).status, 200);
        keys().revoke(doomed.id);
        assert.equal((await call('GET', '/v1/', { key: doomed.key })).status, 401);
    });

    it('records last_used_at on a real call', async () => {
        const key = keys().createKey({ scopes: ['objects:read'] });
        await call('GET', '/v1/', { key: key.key });
        assert.ok(keys().get(key.id).lastUsedAt);
    });

    it('enforces a scope on every route', async () => {
        // The orders-only key can write an order and nothing else.
        assert.equal((await call('POST', '/v1/orders', { key: narrow, body: { reference: 'SC-1', amount: 5 } })).status, 201);
        for (const [method, url, body] of [
            ['POST', '/v1/events', { type: 'x.y' }],
            ['POST', '/v1/contacts', { phone: '9876500001' }],
            ['GET', '/v1/contacts/9876500001', undefined],
            ['GET', '/v1/orders/SC-1', undefined],
            ['POST', '/v1/tickets', { subject: 'hi' }],
        ]) {
            const res = await call(method, url, { key: narrow, body });
            assert.equal(res.status, 403, `${method} ${url}`);
            assert.equal(res.body.error, 'insufficient_scope');
        }
    });

    it('creates and reads a contact in a shape it owns', async () => {
        const created = await call('POST', '/v1/contacts', {
            key: full,
            body: { phone: '9876500002', name: 'Asha', email: 'a@x.test', tags: ['vip'], customFields: { city: 'Pune' } },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.contact.phone, '919876500002'); // normalised for us, not by the caller
        assert.deepEqual(created.body.contact.tags, ['vip']);
        assert.equal(created.body.contact.customFields.city, 'Pune');

        const read = await call('GET', '/v1/contacts/9876500002', { key: full });
        assert.equal(read.body.contact.id, created.body.contact.id);
        assert.equal((await call('GET', '/v1/contacts/9999999999', { key: full })).status, 404);
        assert.equal((await call('POST', '/v1/contacts', { key: full, body: {} })).status, 400);
    });

    it('maps orders, appointments and payments onto the object store', async () => {
        const order = await call('POST', '/v1/orders', {
            key: full, body: { reference: 'ORD-V1', amount: 250, currency: 'INR' },
        });
        assert.equal(order.status, 201);
        assert.equal(order.body.order.type, 'order');
        assert.equal(order.body.order.status, 'placed');
        assert.equal(order.body.order.data.amount, 250);
        assert.equal(dispatched.at(-1).type, 'order.created');

        const appt = await call('POST', '/v1/appointments', {
            key: full, body: { reference: 'APT-V1', data: { service: 'Cleaning', scheduledAt: '2026-11-01T09:00:00Z' } },
        });
        assert.equal(appt.status, 201);
        assert.equal(appt.body.appointment.occursAt, '2026-11-01T09:00:00.000Z');

        const pay = await call('POST', '/v1/payments', {
            key: full, body: { reference: 'PAY-V1', amount: 99, dueAt: '2026-11-02' },
        });
        assert.equal(pay.status, 201);

        assert.equal((await call('GET', '/v1/orders/ORD-V1', { key: full })).body.order.reference, 'ORD-V1');
        assert.equal((await call('GET', '/v1/orders/nope', { key: full })).status, 404);
        // The façade still refuses what the registry refuses.
        assert.equal((await call('POST', '/v1/orders', { key: full, body: { reference: 'X', colour: 'red' } })).status, 400);
        assert.equal((await call('POST', '/v1/orders', { key: full, body: { reference: 'ORD-V1', amount: 1 } })).status, 409);
    });

    it('creates and reads a ticket', async () => {
        const created = await call('POST', '/v1/tickets', {
            key: full, body: { subject: 'Package late', priority: 'high', category: 'delivery' },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.ticket.priority, 'high');
        assert.ok(created.body.ticket.slaDueAt);
        const reference = created.body.ticket.reference;
        assert.equal((await call('GET', `/v1/tickets/${reference}`, { key: full })).body.ticket.subject, 'Package late');
        assert.equal((await call('GET', '/v1/tickets/TKT-nope', { key: full })).status, 404);
    });

    it('dispatches a generic event to the workflow engine', async () => {
        const res = await call('POST', '/v1/events', {
            key: full, body: { type: 'erp.invoice_paid', contactPhone: '9876500002', data: { amount: 10 } },
        });
        assert.equal(res.status, 202);
        assert.deepEqual(res.body.workflowRuns, [{ id: 1, status: 'running' }]);
        const event = dispatched.at(-1);
        assert.equal(event.type, 'erp.invoice_paid');
        assert.equal(event.source, 'api');
        assert.equal(event.data.phone, '9876500002');
        assert.equal((await call('POST', '/v1/events', { key: full, body: {} })).status, 400);
    });

    it('replays the original result for a repeated Idempotency-Key', async () => {
        const body = { reference: 'ORD-IDEM', amount: 10 };
        const first = await call('POST', '/v1/orders', { key: full, body, idempotencyKey: 'abc-123' });
        assert.equal(first.status, 201);

        const again = await call('POST', '/v1/orders', { key: full, body, idempotencyKey: 'abc-123' });
        assert.equal(again.status, 201);          // not the 409 a second create would give
        assert.equal(again.replay, 'true');
        assert.deepEqual(again.body, first.body); // the same id, not a second order

        // One object, however many times the integration retried.
        assert.equal(db.db.prepare(
            "SELECT COUNT(*) AS n FROM business_objects WHERE tenant_id = 1 AND reference = 'ORD-IDEM'").get().n, 1);

        // The same key on a different route is a caller bug, not a replay.
        const crossed = await call('POST', '/v1/tickets', { key: full, body: { subject: 'x' }, idempotencyKey: 'abc-123' });
        assert.equal(crossed.status, 409);
        assert.equal(crossed.body.error, 'idempotency_key_reused');
    });

    it('cannot reach another tenant with a valid key', async () => {
        // Tenant 2's key against tenant 1's mount: a live credential, wrong door.
        const res = await call('GET', '/v1/', { key: otherTenant });
        assert.equal(res.status, 403);
        assert.equal(res.body.error, 'wrong_tenant');
        assert.equal((await call('GET', '/v1/orders/ORD-V1', { key: otherTenant })).status, 403);

        // And tenant 1's key on tenant 2's mount sees none of tenant 1's data.
        assert.equal((await call('GET', '/b/v1/orders/ORD-V1', { key: full })).status, 403);
        const theirs = await call('POST', '/b/v1/orders', { key: otherTenant, body: { reference: 'ORD-V1', amount: 1 } });
        assert.equal(theirs.status, 201); // same reference, different tenant, no collision
        assert.equal((await call('GET', '/b/v1/orders/ORD-V1', { key: otherTenant })).body.order.id !== undefined, true);
        assert.equal((await call('GET', '/v1/orders/ORD-V1', { key: full })).body.order.reference, 'ORD-V1');
    });
});
