/** Platform policy enforcement for bulk.* and campaigns.* (policy/campaignOps.js). */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { CampaignStore } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { attachCampaignPolicy, bulkKillReason, retentionSweep } from '../src/policy/campaignOps.js';
import { Status } from '../src/protocol.js';
import { TransportError } from '../src/transports/base.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-policy-camp-'));
const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end && !fn()) await wait(20);
    return fn();
}

let n = 0;
function fakeTransport(send = async () => ({ providerId: `p${n++}`, status: Status.SENT })) {
    const sent = [];
    return {
        sent, name: 'fake', realDelivery: true, supportsReceipts: false,
        isConnected: () => true,
        async sendMessage(to, text) { sent.push(to); return send(to, text); },
        getStatus: () => null,
        async disconnect() {},
    };
}

/** A real manager on its own tenant, wired the way createChannelRuntime wires it. */
function rig(values = {}, { limits = {}, transport = fakeTransport(), tenantId } = {}) {
    const root = new Database(path.join(tmp, `m${n++}.db`));
    const db = root.forTenant(tenantId ?? 1).forChannel(1);
    const manager = new CampaignManager(db, transport,
        { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', maxRetries: 0, safetyEnabled: true, dailyLimit: 0 });
    manager.holdPollSeconds = 0.05;
    const policy = { 'bulk.requireOptIn': false, ...values };
    const state = { manager, db, limits: () => limits, channel: { timezone: 'UTC' } };
    attachCampaignPolicy(state, { platformPolicy: () => policy });
    const events = [];
    manager.on('event', (e) => events.push(e));
    return { root, db, manager, policy, transport, events };
}
const people = (count) => Array.from({ length: count }, (_, i) => ({ name: `P${i}`, phone: `9198000${String(i).padStart(5, '0')}` }));

describe('bulk.* in the campaign manager', () => {
    it('caps recipients per send at the stricter of policy and the legacy plan limit', () => {
        const { manager } = rig({ 'bulk.maxRecipients': 5 }, { limits: { maxContactsPerCampaign: 2 } });
        assert.throws(() => manager.enqueueContacts(people(3), 'Hi {name}'),
            (err) => err.status === 403 && /reach 2 recipients/.test(err.message));
        assert.equal(manager.enqueueContacts(people(2), 'Hi {name}').queued, 2);
    });

    it('skips contacts who have not opted in and says how many', () => {
        const { db, manager } = rig({ 'bulk.requireOptIn': true });
        const contacts = new ContactStore(db);
        const [a, b] = people(2);
        contacts.upsert({ name: 'A', phone: a.phone, optInStatus: 'opted_in' });
        contacts.upsert({ name: 'B', phone: b.phone });
        const result = manager.enqueueContacts([a, b], 'Hi {name}');
        assert.equal(result.queued, 1);
        assert.equal(result.skippedNoOptIn, 1);
        assert.match(result.policyNotes[0], /1 contacts were skipped because they have not opted in/);
    });

    it('clamps a faster speed preset to the ceiling', () => {
        const { manager } = rig({ 'bulk.maxSpeed': 'safe' });
        const result = manager.enqueueContacts(people(1), 'Hi {name}', { pacing: 'fast' });
        assert.deepEqual(result.pacingClamped, { requested: 'fast', applied: 'safe' });
        assert.equal(manager.pacePreset, 'safe');
        manager.setPace('balanced');
        assert.equal(manager.pacePreset, 'safe');
    });

    it('refuses a send bigger than the business has left of its daily cap', () => {
        const { db, manager } = rig({ 'bulk.dailyCap': 3 });
        db.forChannel(2).insert({ messageId: 'old1', recipient: '1', message: 'x', status: 'SENT' });
        db.insert({ messageId: 'old2', recipient: '2', message: 'x', status: 'DELIVERED' });
        assert.throws(() => manager.enqueueContacts(people(2), 'Hi {name}'),
            (err) => err.status === 403 && /only 1 messages left of its daily cap of 3/.test(err.message));
        assert.equal(manager.enqueueContacts(people(1), 'Hi {name}').queued, 1);
    });

    it('holds the rest of a running send once the monthly cap is reached', async () => {
        const { db, manager, transport, events } = rig({ 'bulk.monthlyCap': 2 });
        manager.enqueueContacts(people(2), 'Hi {name}');
        // Another number of the same business uses one message mid-run.
        db.forChannel(9).insert({ messageId: 'other', recipient: '3', message: 'x', status: 'SENT' });
        manager.start();
        assert.ok(await until(() => events.some((e) => e.type === 'policyHold')));
        await manager.shutdown();
        assert.equal(transport.sent.length, 1);
        assert.match(events.find((e) => e.type === 'policyHold').reason, /monthly message cap of 2/);
        assert.equal(manager.resume(), false);
    });

    it('waits outside the sending window and goes once it opens', async () => {
        const { manager, policy, transport } = rig({ 'bulk.windowEnabled': true, 'bulk.windowStart': '00:00', 'bulk.windowEnd': '00:00' });
        manager.enqueueContacts(people(1), 'Hi {name}');
        manager.start();
        await wait(250);
        assert.equal(transport.sent.length, 0);
        assert.equal(manager.holding, true);
        policy['bulk.windowEnabled'] = false;
        assert.ok(await until(() => transport.sent.length === 1));
        await manager.shutdown();
    });

    it('kill switch: refuses new sends and stops a running one at once', async () => {
        const slow = fakeTransport(async () => { await wait(30); return { providerId: `k${n++}`, status: Status.SENT }; });
        const { manager, transport, events } = rig({}, { transport: slow });
        let kill = null;
        manager.killSwitch = () => kill;
        manager.enqueueContacts(people(20), 'Hi {name}');
        manager.start();
        assert.ok(await until(() => transport.sent.length >= 1));
        kill = 'Stopped: the platform has paused all bulk sending.';
        assert.ok(await until(() => events.some((e) => e.type === 'policyStop')));
        await manager.shutdown();
        assert.ok(transport.sent.length < 20);
        assert.throws(() => manager.enqueueContacts(people(1), 'Hi {name}'), (err) => err.status === 409);
    });

    it('auto-pauses a campaign once failures pass the platform rate after 20 attempts', async () => {
        const failing = fakeTransport(async () => { throw new TransportError('nope', { retryable: false }); });
        const { manager, events } = rig({ 'campaigns.autoPauseFailurePct': 50 }, { transport: failing });
        manager.enqueueContacts(people(30), 'Hi {name}');
        manager.start();
        assert.ok(await until(() => events.some((e) => e.type === 'failureStop')));
        await manager.shutdown();
        const stop = events.find((e) => e.type === 'failureStop');
        assert.equal(stop.processed, 20);
        assert.ok(stop.campaignId);
    });

    it('refuses interactive buttons when the plan turns them off', () => {
        const { manager } = rig({ 'campaigns.allowInteractive': false });
        assert.throws(() => manager.enqueueContacts(people(1), 'Hi', {
            interactive: { type: 'buttons', body: 'Pick', buttons: [{ id: 'a', title: 'A' }] },
        }), (err) => err.status === 403 && /not on your plan/.test(err.message));
    });
});

describe('campaigns.* in the campaign store', () => {
    let store;
    let values;
    const manager = {
        stopped: 0, resumeRefusal: null, quota: { limit: 0 }, queue: { reset() {} },
        resetStats() {}, start() {}, pause() {}, resume: () => true, stop() { manager.stopped += 1; return 0; },
        enqueueContacts: (contacts, t, o) => ({ queued: contacts.length, skipped: 0, campaignId: o.campaignId }),
    };
    before(() => {
        const db = new Database(path.join(tmp, 'store.db')).forTenant(1).forChannel(1);
        values = {};
        store = new CampaignStore(db, { contacts: new ContactStore(db), manager, policy: () => values });
    });

    it('refuses scheduling when the plan turns it off, and beyond maxScheduled', () => {
        values = { 'campaigns.allowScheduling': false };
        assert.throws(() => store.create({ name: 's', body: 'hi', status: 'scheduled', scheduledAt: stamp() }),
            (err) => err.status === 403 && /Scheduling/.test(err.message));
        values = { 'campaigns.maxScheduled': 1 };
        store.create({ name: 's1', body: 'hi', status: 'scheduled', scheduledAt: stamp() });
        assert.throws(() => store.create({ name: 's2', body: 'hi', status: 'scheduled', scheduledAt: stamp() }),
            (err) => err.status === 409 && /1 scheduled campaigns/.test(err.message));
        const draft = store.create({ name: 'd', body: 'hi' });
        assert.throws(() => store.update(draft.id, { status: 'scheduled', scheduledAt: stamp() }), (err) => err.status === 409);
    });

    it('refuses follow-ups and interactive campaigns when the plan turns them off', () => {
        values = { 'campaigns.allowFollowUps': false, 'campaigns.allowInteractive': false };
        assert.throws(() => store.create({ name: 'f', body: 'hi', audience: { retarget: { campaignId: 1, filter: 'failed' } } }),
            (err) => err.status === 403 && /Follow-up/.test(err.message));
        assert.throws(() => store.create({
            name: 'i', body: 'hi', options: { interactive: { type: 'buttons', body: 'Pick', buttons: [{ id: 'a', title: 'A' }] } },
        }), (err) => err.status === 403 && /Interactive/.test(err.message));
    });

    it('refuses to start beyond maxRunning, records an auto-pause reason, and clears it on resume', () => {
        values = { 'campaigns.maxRunning': 1 };
        const a = store.create({ name: 'a', body: 'hi', audience: [{ phone: '919800000001' }] });
        const b = store.create({ name: 'b', body: 'hi', audience: [{ phone: '919800000002' }] });
        store.start(a.id);
        assert.throws(() => store.start(b.id), (err) => err.status === 409 && /1 campaigns running/.test(err.message));
        const paused = store.policyHalt(`camp-${a.id}`, 'paused', 'Auto-paused: 12 of 20 messages failed (limit 50%).');
        assert.equal(paused.status, 'paused');
        assert.match(paused.options.statusReason, /Auto-paused/);
        assert.equal(store.resume(a.id).options.statusReason, null);
        const cancelled = store.cancel(a.id, 'Cancelled by the platform administrator.');
        assert.equal(cancelled.options.statusReason, 'Cancelled by the platform administrator.');
    });
});

describe('platform admin endpoints, kill switch scope and retention', () => {
    let app;
    let server;
    let base;
    let sup;
    let owner;
    let db;
    const call = async (token, method, url, body) => {
        const res = await fetch(base + url, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };
    const insertCampaign = (status, extra = {}) => Number(db.db.prepare(
        `INSERT INTO campaigns (tenant_id, channel_id, name, status, body, created_at, updated_at, finished_at)
         VALUES (1, NULL, ?, ?, 'hi', ?, ?, ?)`).run(`C ${status}`, status, stamp(), stamp(), extra.finishedAt ?? null)
        .lastInsertRowid);

    before(async () => {
        db = new Database(path.join(tmp, 'app.db'));
        app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        sup = sessionFor(app, { role: 'super_admin' });
        owner = sessionFor(app, { tenantId: 1, role: 'owner' });
    });
    after(async () => {
        await closeApp(app);
        server.close();
    });

    it('lists campaigns across tenants with failure rate, filterable by status', async () => {
        const id = insertCampaign('running');
        const scoped = db.forTenant(1).forChannel(1);
        for (const [i, status] of ['SENT', 'SENT', 'SENT', 'FAILED'].entries()) {
            scoped.insert({ messageId: `adm${id}-${i}`, recipient: `1555${i}`, message: 'hi', status, campaignId: `camp-${id}` });
        }
        const res = await call(sup, 'GET', '/api/admin/campaigns?status=running');
        assert.equal(res.status, 200);
        const row = res.body.campaigns.find((c) => c.id === id);
        assert.deepEqual([row.sent, row.failed, row.total, row.failureRate], [3, 1, 4, 25]);
        assert.ok(res.body.campaigns.every((c) => c.status === 'running'));
        assert.equal((await call(owner, 'GET', '/api/admin/campaigns')).status, 403);
    });

    it('pauses, resumes and cancels a tenant campaign, audited', async () => {
        const id = insertCampaign('running');
        assert.equal((await call(sup, 'POST', `/api/admin/campaigns/${id}/pause`)).body.campaign.status, 'paused');
        assert.equal((await call(sup, 'POST', `/api/admin/campaigns/${id}/resume`)).body.campaign.status, 'running');
        const cancelled = await call(sup, 'POST', `/api/admin/campaigns/${id}/cancel`);
        assert.equal(cancelled.body.campaign.status, 'cancelled');
        assert.match(cancelled.body.campaign.options.statusReason, /platform administrator/);
        const actions = app.locals.tenancy.listAudit({ tenantId: 1 }).map((a) => a.action);
        assert.ok(['campaign.admin_pause', 'campaign.admin_resume', 'campaign.admin_cancel'].every((a) => actions.includes(a)));
    });

    it('stops every running bulk send, platform-wide and per tenant, audited', async () => {
        const id = insertCampaign('running');
        app.locals.runtimeFor(1); // a live runtime, as a sending tenant has
        const all = await call(sup, 'POST', '/api/admin/bulk/stop-all');
        assert.equal(all.status, 200);
        assert.ok(all.body.cancelled >= 1);
        assert.equal(db.db.prepare('SELECT status FROM campaigns WHERE id = ?').get(id).status, 'cancelled');
        assert.equal((await call(sup, 'POST', '/api/admin/tenants/1/bulk/stop')).status, 200);
        assert.equal((await call(sup, 'POST', '/api/admin/tenants/999/bulk/stop')).status, 404);
        const actions = app.locals.tenancy.listAudit({}).map((a) => a.action);
        assert.ok(actions.includes('bulk.stop_all') && actions.includes('bulk.stop'));
    });

    it('a global kill switch beats a tenant override; a tenant one stops only that tenant', () => {
        const policy = app.locals.policy;
        policy.set('tenant:1', { 'bulk.killSwitch': false });
        assert.equal(bulkKillReason(policy, 1), null);
        policy.set('global', { 'bulk.killSwitch': true });
        assert.match(bulkKillReason(policy, 1), /platform/);
        policy.set('global', { 'bulk.killSwitch': null });
        policy.set('tenant:1', { 'bulk.killSwitch': true });
        assert.match(bulkKillReason(policy, 1), /your business/);
        policy.set('tenant:1', { 'bulk.killSwitch': null });
    });

    it('retention deletes finished campaigns and their rows past retentionDays; 0 keeps', () => {
        const old = insertCampaign('done', { finishedAt: stamp(Date.now() - 40 * 86_400_000) });
        const fresh = insertCampaign('done', { finishedAt: stamp() });
        db.forTenant(1).insert({ messageId: `ret-${old}`, recipient: '1', message: 'x', status: 'SENT', campaignId: `camp-${old}` });
        const exists = (id) => Boolean(db.db.prepare('SELECT 1 FROM campaigns WHERE id = ?').get(id));
        retentionSweep(db, app.locals.policy, { force: true });
        assert.ok(exists(old));
        app.locals.policy.set('global', { 'campaigns.retentionDays': 30 });
        retentionSweep(db, app.locals.policy, { force: true });
        assert.ok(!exists(old) && exists(fresh));
        assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ?').get(`camp-${old}`).n, 0);
        app.locals.policy.set('global', { 'campaigns.retentionDays': null });
    });

    it('tenant API refuses scheduling a campaign when the plan turns it off', async () => {
        app.locals.policy.set('tenant:1', { 'campaigns.allowScheduling': false });
        const res = await call(owner, 'POST', '/api/campaigns', { name: 'later', body: 'hi', status: 'scheduled', scheduledAt: stamp() });
        assert.equal(res.status, 403);
        assert.match(res.body.errors[0], /not on your plan/);
        app.locals.policy.set('tenant:1', { 'campaigns.allowScheduling': null });
    });
});
