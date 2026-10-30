/**
 * One number, several campaigns: every control acts on the campaign it names, never on whichever run the number
 * happens to be sending, and every run ends somewhere (done, cancelled) instead of reading `running` forever.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { CampaignManager } from '../src/campaign/manager.js';
import { createCampaignRouter } from '../src/campaigns/routes.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { attachCampaignPolicy } from '../src/policy/campaignOps.js';
import { Status } from '../src/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !fn()) await sleep(20);
    return fn();
};
const config = {
    ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, pacingMode: 'fixed', maxRetries: 0,
    safetyEnabled: false, humanTiming: false, dailyLimit: 0,
};
let seq = 0;
const people = (count, prefix) => Array.from({ length: count }, (_, i) => ({ name: `P${i}`, phone: `91${prefix}${String(i).padStart(5, '0')}` }));

/** A transport whose sends wait on `gate` while `held` is true, so a run can be caught mid-way. */
function slowTransport() {
    const transport = {
        name: 'fake', realDelivery: true, supportsReceipts: false, held: false, sent: [],
        isConnected: () => true,
        async sendMessage(to) {
            while (transport.held) await sleep(10);
            transport.sent.push(to);
            return { providerId: `p${seq++}`, status: Status.SENT };
        },
        getStatus: () => null,
        async disconnect() {},
    };
    return transport;
}

describe('campaign lifecycle on one number', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-lifecycle-'));
    let root;
    const rigs = [];

    /** The channel runtime's campaign wiring: real manager, real store and router (its event handler), fake audit. */
    function rig({ policy = {}, transport = slowTransport() } = {}) {
        const db = root.forTenant(++seq).forChannel(1);
        const manager = new CampaignManager(db, transport, config);
        manager.holdPollSeconds = 0.02;
        const audits = [];
        const events = [];
        const state = {
            manager, db, transport, channel: { id: 1, timezone: 'UTC' }, limits: () => ({}),
            contacts: new ContactStore(db, '91'), templates: null,
            broadcast: (e) => events.push(e), tenancy: { audit: (row) => audits.push(row) },
        };
        attachCampaignPolicy(state, { platformPolicy: () => ({ 'bulk.requireOptIn': false, ...policy }) });
        const router = createCampaignRouter({ db, state });
        const r = { db, manager, transport, store: state.campaigns, audits, events, state, router };
        rigs.push(r);
        return r;
    }
    const rows = (db, id) => Object.fromEntries(db.db.prepare(
        'SELECT status, COUNT(*) AS n FROM messages WHERE campaign_id = ? GROUP BY status').all(`camp-${id}`).map((x) => [x.status, x.n]));

    before(() => {
        root = new Database(path.join(tmp, 'life.db'));
    });
    after(async () => {
        for (const r of rigs) {
            r.transport.held = false;
            await r.manager.shutdown();
        }
        root.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('refuses a second start while the number still sends the first, and pause/cancel touch only the one named', async () => {
        const { db, manager, transport, store } = rig();
        transport.held = true;
        const a = store.create({ name: 'Alpha', body: 'Hi {name}', audience: people(6, '98100') });
        const b = store.create({ name: 'Beta', body: 'Hi {name}', audience: people(4, '98200') });
        store.start(a.id);
        assert.ok(await until(() => manager.inFlight === 1));
        assert.throws(() => store.start(b.id), (err) => err.status === 409 && /still sending «Alpha»/.test(err.message));
        assert.equal(store.get(b.id).status, 'draft');

        // A run the manager does not hold (here: left over from before a restart) is paused and cancelled on its own.
        db.db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(b.id);
        for (const p of people(3, '98200')) {
            db.insert({ messageId: `orphan-${p.phone}`, recipient: p.phone, message: 'x', status: 'QUEUED', campaignId: `camp-${b.id}` });
        }
        store.pause(b.id);
        assert.equal(manager.queue.isPaused, false, 'pausing Beta leaves Alpha sending');
        assert.equal(store.get(a.id).status, 'running');
        const cancelled = store.cancel(b.id);
        assert.equal(cancelled.status, 'cancelled');
        assert.deepEqual(rows(db, b.id), { CANCELLED: 3 });
        assert.equal(manager.queue.isStopped, false, 'cancelling Beta leaves Alpha queued');
        assert.equal(rows(db, a.id).CANCELLED, undefined);
        assert.equal(manager.pendingByType().campaign, 5, 'Alpha still has its five waiting');

        // Pausing the run it holds does pause the number; a paused run still blocks a new start.
        store.pause(a.id);
        assert.equal(manager.queue.isPaused, true);
        const c = store.create({ name: 'Gamma', body: 'Hi {name}', audience: people(2, '98300') });
        assert.throws(() => store.start(c.id), /«Alpha» is paused on this number/);
        store.cancel(a.id);
        transport.held = false;
        assert.ok(await until(() => !manager.inFlight && !manager.queue.isStopped), 'the queue reopens once the send in flight ends');
        assert.equal(rows(db, a.id).QUEUED, undefined, 'none of Alpha is left waiting');
        assert.equal(store.start(c.id).queued, 2, 'the number is free again');
    });

    it('closes a run at once when everybody was skipped, so it never holds a running slot', () => {
        const { db, store, audits } = rig({ 'campaigns.maxRunning': 1 });
        const list = people(3, '98400');
        for (const p of list) db.addOptOut(p.phone);
        const skipped = store.create({ name: 'Nobody', body: 'Hi {name}', audience: list });
        const result = store.start(skipped.id);
        assert.equal(result.queued, 0);
        assert.equal(result.campaign.status, 'done');
        assert.match(result.campaign.options.statusReason, /Nothing was sent: all 3 recipients were skipped \(3 opted out\)/);
        assert.ok(audits.some((row) => row.action === 'campaign.done'));
        const next = store.create({ name: 'Next', body: 'Hi {name}', audience: people(1, '98410') });
        assert.equal(store.start(next.id).campaign.status, 'running', 'the skipped run took no slot');
    });

    it('deleting a paused run cancels its waiting rows, so a later quick send goes out', async () => {
        const { db, manager, transport, store } = rig();
        transport.held = true;
        const a = store.create({ name: 'Paused', body: 'Hi {name}', audience: people(4, '98500') });
        store.start(a.id);
        assert.ok(await until(() => manager.inFlight === 1));
        store.pause(a.id);
        assert.equal(store.remove(a.id), true);
        assert.equal(manager.pendingByType().campaign ?? 0, 0);
        transport.held = false;
        assert.ok(await until(() => !manager.inFlight && !manager.queue.isStopped), 'the queue reopens after the cancel');
        assert.equal(rows(db, a.id).QUEUED, undefined);
        // No start() first: a quick send must be taken as it is, not refused as a "duplicate" by a stopped queue.
        const id = manager.enqueueJob({ recipient: '919850099999', text: 'Your order shipped', messageType: 'transactional' });
        assert.ok(id);
        assert.ok(await until(() => transport.sent.includes('919850099999')), 'the quick send is not stuck behind orphans');
        // A quick send after a run is not counted in that run.
        assert.equal(db.db.prepare('SELECT campaign_id FROM messages WHERE message_id = ?').get(id).campaign_id, 'transactional');
    });

    it('writes a snapshot at start, and a retried success replaces its failure in the counts', async () => {
        const { db, store, transport } = rig();
        transport.held = true;
        const a = store.create({ name: 'Snap', body: 'Hi {name}', audience: people(3, '98600') });
        const started = store.start(a.id).campaign;
        assert.deepEqual([started.stats.total, started.stats.pending, started.stats.sent], [3, 3, 0], 'no "3 of 3 done" at second one');
        transport.held = false;
        assert.ok(await until(() => store.stats(a.id).campaign.status === 'done'));
        // One person failed, then a retry got through: they count once, as sent.
        const [first] = people(1, '98600');
        db.db.prepare("UPDATE messages SET status = 'FAILED' WHERE campaign_id = ? AND recipient = ?").run(`camp-${a.id}`, first.phone);
        assert.equal(store.stats(a.id).stats.failed, 1);
        db.insert({ messageId: `retry-${first.phone}`, recipient: first.phone, message: 'x', status: 'SENT', campaignId: `camp-${a.id}` });
        const { stats } = store.stats(a.id);
        assert.deepEqual([stats.total, stats.failed, stats.sent], [3, 0, 3]);
    });

    it('holds a run at the business daily cap, keeps it running with the reason, and lets it go by itself', async () => {
        const policy = { 'bulk.dailyCap': 2 };
        const { db, manager, store, audits, transport } = rig({ policy });
        const a = store.create({ name: 'Capped', body: 'Hi {name}', audience: people(2, '98700') });
        store.start(a.id);
        // Another number of the business uses one of the two.
        root.forTenant(db.tenantId).forChannel(9).insert({ messageId: `other-${seq++}`, recipient: '1', message: 'x', status: 'SENT' });
        assert.ok(await until(() => manager.pausedByQuota), 'a quota-style pause, which lifts itself');
        let held = store.get(a.id);
        assert.equal(held.status, 'running');
        assert.match(held.options.statusReason, /daily message cap of 2/);
        assert.ok(audits.some((row) => row.action === 'campaign.auto_paused' && row.detail.resumesByItself));
        assert.equal(transport.sent.length, 1);

        policy['bulk.dailyCap'] = 10; // the next day, as far as the cap is concerned
        manager.quotaCheckedAt = 0;
        assert.ok(await until(() => store.get(a.id).status === 'done' || transport.sent.length === 2));
        held = store.get(a.id);
        assert.equal(held.options.statusReason, null, 'the reason goes once it carries on');
        assert.equal(transport.sent.length, 2);
    });

    it('announces and audits the owner\'s actions by name', async () => {
        const { store, router, events, audits, manager, transport } = rig();
        const app = express();
        app.use(express.json());
        app.use((req, res, next) => { req.user = { id: 42 }; next(); });
        app.use(router);
        const server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = (url) => fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        try {
            transport.held = true;
            const a = store.create({ name: 'Named', body: 'Hi {name}', audience: people(3, '98800') });
            assert.equal((await post(`/campaigns/${a.id}/start`)).status, 200);
            assert.ok(await until(() => manager.inFlight === 1));
            assert.equal((await post(`/campaigns/${a.id}/pause`)).status, 200);
            assert.equal((await post(`/campaigns/${a.id}/resume`)).status, 200);
            assert.equal((await post(`/campaigns/${a.id}/cancel`)).status, 200);
            assert.equal((await fetch(`${base}/campaigns/${a.id}`, { method: 'DELETE' })).status, 200);
            const types = events.map((e) => e.type);
            for (const type of ['campaignStarted', 'campaignPaused', 'campaignResumed', 'campaignCancelled', 'campaignDeleted']) {
                assert.ok(types.includes(type), type);
            }
            assert.ok(!types.includes('campaignCanceld'));
            const mine = audits.filter((row) => row.userId === 42).map((row) => row.action);
            assert.deepEqual(mine, ['campaign.start', 'campaign.pause', 'campaign.resume', 'campaign.cancel', 'campaign.delete']);
            assert.ok(audits.every((row) => row.detail.name === 'Named'));

            // Word choices and variables with a fallback are never reported as unfilled; a bare blank one is.
            const spun = store.create({
                name: 'Spun', body: '{Hi|Hello} {name}, {20|25}% off in {city|your town}, code {code}',
                audience: [{ phone: '919880000001', name: '', extra: { city: '' } }], options: { fallbacks: { name: 'there' } },
            });
            const preview = await (await post(`/campaigns/${spun.id}/preview`)).json();
            assert.deepEqual(preview.missing, ['code']);
            assert.match(preview.previews[0].preview, /^(Hi|Hello) there, (20|25)% off in your town, code {code}$/);
        } finally {
            transport.held = false;
            server.close();
        }
    });
});
