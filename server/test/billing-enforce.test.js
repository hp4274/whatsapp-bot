/** Plan quota enforcement (policy/billing.js): messages, public API requests and storage. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { BillingStore } from '../src/billing/store.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { MessageService } from '../src/messaging/service.js';
import { billingLimit } from '../src/policy/billing.js';
import { attachCampaignPolicy, bulkRules, capRemaining } from '../src/policy/campaignOps.js';
import { Status } from '../src/protocol.js';
import { ApiKeyStore } from '../src/publicapi/keys.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-billing-enforce-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end && !fn()) await wait(20);
    return fn();
}

let n = 0;
function fakeTransport() {
    const sent = [];
    return {
        sent, name: 'fake', realDelivery: true, supportsReceipts: false,
        isConnected: () => true,
        async sendMessage(to) { sent.push(to); return { providerId: `p${n++}`, status: Status.SENT }; },
        getStatus: () => null,
        async disconnect() {},
    };
}

/** A manager whose tenant is on `plan`, with policy values `policy`, wired as the runtime wires it. */
function rig(policy = {}, plan = 'business') {
    const root = new Database(path.join(tmp, `m${n++}.db`));
    const db = root.forTenant(1).forChannel(1);
    const transport = fakeTransport();
    const manager = new CampaignManager(db, transport,
        { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', maxRetries: 0, safetyEnabled: true, dailyLimit: 0 });
    manager.holdPollSeconds = 0.05;
    const values = { 'bulk.requireOptIn': false, ...policy };
    const billing = new BillingStore(db, { overrides: () => values });
    billing.subscribe(1, plan);
    const state = { manager, db, billing, limits: () => ({}), channel: { timezone: 'UTC' } };
    attachCampaignPolicy(state, { platformPolicy: () => values });
    const events = [];
    manager.on('event', (e) => events.push(e));
    return { db, manager, transport, billing, values, events };
}
const people = (count) => Array.from({ length: count }, (_, i) => ({ name: `P${i}`, phone: `9198100${String(i).padStart(5, '0')}` }));

describe('quota limits', () => {
    it('an override replaces the plan limit, 0 lifts it, null keeps the plan', () => {
        const plan = { messagesPerMonth: 1000, apiRequests: 0, storageMb: 500 };
        assert.equal(billingLimit('messages', plan, {}), 1000);
        assert.equal(billingLimit('messages', plan, { 'billing.messagesPerMonth': null }), 1000);
        assert.equal(billingLimit('messages', plan, { 'billing.messagesPerMonth': 5 }), 5);
        assert.equal(billingLimit('messages', plan, { 'billing.messagesPerMonth': 0 }), null);
        assert.equal(billingLimit('api_requests', plan, {}), 0, 'a plan limit of 0 is none at all');
    });

    it('usage and check show the effective limit', () => {
        const { billing, values } = rig({ 'billing.storageMb': 3 });
        assert.equal(billing.usage().metrics.find((m) => m.metric === 'storage_mb').limit, 3);
        values['billing.storageMb'] = 0;
        assert.equal(billing.check('storage_mb', 1e9).allowed, true);
    });

    it('the stricter of bulk.monthlyCap and the message quota caps bulk', () => {
        assert.equal(bulkRules({ 'bulk.monthlyCap': 50 }, {}, 10).monthlyCap, 10);
        assert.equal(bulkRules({ 'bulk.monthlyCap': 5 }, {}, 10).monthlyCap, 5);
        assert.equal(bulkRules({}, {}, null).monthlyCap, 0);
    });

    it('a plan message quota of 0 allows none; bulk.monthlyCap 0 is still no cap', () => {
        const none = bulkRules({ 'bulk.monthlyCap': 50 }, {}, 0);
        assert.equal(none.quotaBlocked, true);
        const { db } = rig();
        assert.equal(capRemaining(db.db, 1, none).left, 0);
        assert.equal(capRemaining(db.db, 1, bulkRules({ 'bulk.monthlyCap': 0 }, {}, null)), null);
    });

    it('usage reads storage_mb live from the stored files', () => {
        const { db, billing } = rig();
        db.db.prepare(`INSERT INTO stored_files (tenant_id, kind, sha256, name, size, stored_name, created_at, last_used_at)
            VALUES (1, 'sheet', 'h', 'a.csv', ?, 'a', 'x', 'x')`).run(1.5 * 1024 * 1024);
        assert.equal(billing.usage().metrics.find((m) => m.metric === 'storage_mb').used, 2);
    });
});

describe('message quota', () => {
    it('blocks new sends once the month is used up; an override of 0 means unlimited', async () => {
        const { db, manager, values } = rig({ 'billing.messagesPerMonth': 1 });
        const channel = { id: 1, status: 'active', capabilities: ['transactional_messages'] };
        const service = new MessageService(db, manager, channel, {
            guard: (job) => manager.sendBlock?.(job.messageType) ?? manager.capBlock?.() ?? null,
        });
        db.insert({ messageId: 'used', recipient: '919810000001', message: 'x', status: 'SENT' });
        const send = (key) => service.send({ messageType: 'transactional', recipient: '919810000002', text: 'hi', idempotencyKey: key });
        assert.throws(() => send('a'), (err) => err.reason === 'tenant_blocked' && /monthly message cap of 1/.test(err.message));
        values['billing.messagesPerMonth'] = 0;
        await wait(1100); // the cap is re-read once a second
        assert.ok(send('b').accepted);
    });

    it('bulk.monthlyCap alone caps campaigns only, not other sends', () => {
        const { db, manager } = rig({ 'bulk.monthlyCap': 1 });
        db.insert({ messageId: 'used', recipient: '919810000001', message: 'x', status: 'SENT' });
        assert.equal(manager.capBlock(), null);
        assert.equal(manager.capBlock(true), null);
    });

    it('a fan-out accepted under the old count stops at the quota when it goes out', async () => {
        const { db, manager, transport } = rig({ 'billing.messagesPerMonth': 2 });
        const channel = { id: 1, status: 'active', capabilities: ['transactional_messages'] };
        const service = new MessageService(db, manager, channel, {
            guard: (job) => manager.sendBlock?.(job.messageType) ?? manager.capBlock?.() ?? null,
        });
        db.insert({ messageId: 'used', recipient: '919810000001', message: 'x', status: 'SENT' });
        // One request, five parents: the cached count lets every one in.
        const ids = people(5).map((p, i) => service.send({ messageType: 'transactional', recipient: p.phone, text: 'notice', idempotencyKey: `n${i}` }).messageId);
        manager.start();
        assert.ok(await until(() => ids.every((id) => ['SENT', 'CANCELLED'].includes(db.db.prepare('SELECT status FROM messages WHERE message_id = ?').get(id)?.status))));
        await manager.shutdown();
        assert.equal(transport.sent.length, 1);
    });

    it('pauses a running campaign at the quota', async () => {
        const { db, manager, transport, events } = rig({ 'bulk.monthlyCap': 50, 'billing.messagesPerMonth': 2 });
        manager.enqueueContacts(people(2), 'Hi {name}');
        // Another number of the same business uses one message mid-run.
        db.forChannel(9).insert({ messageId: 'other', recipient: '3', message: 'x', status: 'SENT' });
        manager.start();
        assert.ok(await until(() => events.some((e) => e.type === 'policyHold')));
        await manager.shutdown();
        assert.equal(transport.sent.length, 1);
        assert.match(events.find((e) => e.type === 'policyHold').reason, /monthly message cap of 2/);
    });

    it('re-checks a campaign row after the gap, so it cannot go one over', async () => {
        const { db, manager, transport, events } = rig({ 'billing.messagesPerMonth': 1 });
        manager.enqueueContacts(people(1), 'Hi {name}');
        // Another number of the business sends while this row waits out its gap (after the first check).
        const real = manager.bulkPolicy;
        const lefts = [];
        manager.bulkPolicy = () => {
            const policy = real();
            return { ...policy, capRemaining: () => {
                const cap = policy.capRemaining();
                lefts.push(cap.left);
                if (lefts.length === 1) db.forChannel(9).insert({ messageId: 'gap', recipient: '3', message: 'x', status: 'SENT' });
                return cap;
            } };
        };
        manager.start();
        assert.ok(await until(() => events.some((e) => e.type === 'policyHold')));
        await manager.shutdown();
        assert.deepEqual(lefts.slice(0, 2), [1, 0], 'room before the gap, none after it');
        assert.equal(transport.sent.length, 0, 'held at the cap, not sent over it');
    });

    it('says a quick send refused at the quota was not sent', () => {
        const { db, manager } = rig({ 'billing.messagesPerMonth': 1 });
        db.insert({ messageId: 'used', recipient: '919810000001', message: 'x', status: 'SENT' });
        const text = manager.capBlock(true);
        assert.match(text, /^Not sent: .*monthly message cap of 1/);
        assert.doesNotMatch(text, /resumes/);
    });

    it('an ended subscription sends nothing, with the reason', async () => {
        const { db, manager, transport, events } = rig();
        const channel = { id: 1, status: 'active', capabilities: ['transactional_messages', 'auto_replies', 'workflow_messages'] };
        const service = new MessageService(db, manager, channel, {
            guard: (job) => manager.sendBlock?.(job.messageType) ?? manager.capBlock?.() ?? null,
        });
        manager.enqueueContacts(people(2), 'Hi {name}'); // queued while the subscription was live
        db.db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = ? WHERE tenant_id = 1")
            .run(new Date(Date.now() - 30 * 86_400_000).toISOString());
        // Auto-replies and workflow steps go through the same service guard.
        for (const messageType of ['transactional', 'auto_reply', 'workflow']) {
            assert.throws(() => service.send({ messageType, recipient: '919810000002', text: 'hi', idempotencyKey: messageType }),
                (err) => err.reason === 'tenant_blocked' && /subscription has ended/.test(err.message));
        }
        assert.throws(() => manager.enqueueContacts(people(1), 'Hi {name}'), /subscription has ended/);
        manager.start();
        assert.ok(await until(() => events.some((e) => e.type === 'policyHold')));
        await manager.shutdown();
        assert.equal(transport.sent.length, 0);
        assert.match(events.find((e) => e.type === 'policyHold').reason, /subscription has ended/);
    });
});

describe('API and storage quotas over HTTP', () => {
    let app;
    let server;
    let base;
    let db;
    let sup;
    let owner;
    let tenantId;
    const call = async (token, method, url, body) => {
        const res = await fetch(base + url, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const setPolicy = (values) => call(sup, 'PUT', `/api/admin/policy/tenant:${tenantId}`, { values });
    const upload = (url, bytes, type, name) => {
        const form = new FormData();
        form.set('file', new Blob([bytes], { type }), name);
        return fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${owner}` }, body: form });
    };
    /** A CSV of about `kb` kilobytes, unique per `tag` so it is never a duplicate. */
    const csv = (tag, kb) => `Name,Phone\n${Array.from({ length: Math.ceil(kb * 1024 / 22) },
        (_, i) => `${tag}${String(i).padStart(6, '0')},98${String(i).padStart(8, '0')}`).join('\n')}\n`;

    before(async () => {
        db = new Database(path.join(tmp, 'app.db'));
        app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        // Its own tenant, so these calls do not share tenant 1's request bucket.
        tenantId = app.locals.tenancy.createTenant('Quota Co', 'quota-co').id;
        new BillingStore(db.forTenant(tenantId)).subscribe(tenantId, 'business');
        sup = sessionFor(app, { role: 'super_admin' });
        owner = sessionFor(app, { tenantId, role: 'owner' });
    });
    after(async () => {
        await closeApp(app);
        server.close();
    });

    it('refuses /v1 calls past the API quota with 429, and counts the ones it serves', async () => {
        assert.equal((await setPolicy({ 'billing.apiRequestsPerMonth': 2 })).status, 200);
        const key = new ApiKeyStore(db.forTenant(tenantId)).createKey({ scopes: ['contacts:read'] }).key;
        // An unknown contact is a 404, but the call still reached the API and counts.
        const v1 = () => fetch(`${base}/api/v1/contacts/9876500001`, { headers: { authorization: `Bearer ${key}` } });
        assert.equal((await v1()).status, 404);
        assert.equal((await v1()).status, 404);
        const over = await v1();
        assert.equal(over.status, 429);
        assert.equal((await over.json()).error, 'quota_exceeded');
        assert.equal(new BillingStore(db.forTenant(tenantId)).usage().metrics.find((m) => m.metric === 'api_requests').used, 2);
        await setPolicy({ 'billing.apiRequestsPerMonth': 0 });
        assert.equal((await v1()).status, 404, '0 = unlimited');
        await setPolicy({ 'billing.apiRequestsPerMonth': null });
        new BillingStore(db.forTenant(tenantId)).subscribe(tenantId, 'starter');
        const none = await v1();
        assert.equal(none.status, 429);
        assert.match((await none.json()).message, /does not include API access/);
        new BillingStore(db.forTenant(tenantId)).subscribe(tenantId, 'business');
    });

    it('refuses an upload that would pass the storage quota with 413, and meters storage_mb', async () => {
        await setPolicy({ 'billing.storageMb': 1 });
        const first = await upload('/api/campaign/import/preview', csv('A', 600), 'text/csv', 'a.csv');
        assert.equal(first.status, 200);
        const usage = await call(owner, 'GET', '/api/billing/usage');
        assert.equal(usage.body.usage.metrics.find((m) => m.metric === 'storage_mb').used, 1);
        assert.equal(usage.body.usage.metrics.find((m) => m.metric === 'storage_mb').limit, 1);
        // The same sheet again stores nothing, so it is still let in.
        assert.equal((await upload('/api/campaign/import/preview', csv('A', 600), 'text/csv', 'a.csv')).status, 200);
        const sheet = await upload('/api/campaign/import/preview', csv('B', 600), 'text/csv', 'b.csv');
        assert.equal(sheet.status, 413);
        assert.match((await sheet.json()).errors[0], /storage is full \(1 MB/);
        const pdf = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(600 * 1024)]);
        assert.equal((await upload('/api/media/upload', pdf, 'application/pdf', 'big.pdf')).status, 413);
        await setPolicy({ 'billing.storageMb': 0 });
        assert.equal((await upload('/api/media/upload', pdf, 'application/pdf', 'big.pdf')).status, 201, '0 = unlimited');
    });

    it('applies the policy templates.maxMediaMb to uploads', async () => {
        await setPolicy({ 'templates.maxMediaMb': 1 });
        const pdf = Buffer.concat([Buffer.from('%PDF-1.4 '), Buffer.alloc(1100 * 1024)]);
        const res = await upload('/api/media/upload', pdf, 'application/pdf', 'too-big.pdf');
        assert.equal(res.status, 413);
        assert.match((await res.json()).errors[0], /up to 1 MB/);
    });
});
