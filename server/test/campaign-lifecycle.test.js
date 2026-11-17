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
        // The store reads campaigns.* limits from state.platformPolicy; the manager's bulk.* rules from the deps.
        state.platformPolicy = () => ({ 'bulk.requireOptIn': false, ...policy });
        attachCampaignPolicy(state, { platformPolicy: state.platformPolicy });
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

    it('a second start sends together with the first: they take turns, and pause/resume/cancel touch only the one named', async () => {
        const { db, manager, transport, store } = rig();
        transport.held = true;
        const a = store.create({ name: 'Alpha', body: 'Hi {name}', audience: people(6, '98100') });
        const b = store.create({ name: 'Beta', body: 'Hi {name}', audience: people(4, '98200') });
        store.start(a.id);
        assert.ok(await until(() => manager.inFlight === 1));
        const joined = store.start(b.id);
        assert.equal(joined.queued, 4);
        assert.equal(joined.campaign.status, 'running');
        assert.equal(joined.together, 'Alpha');
        assert.match(joined.policyNotes[0], /Sending together with «Alpha»: they take turns on this number/);
        assert.equal(rows(db, a.id).CANCELLED, undefined, 'Alpha keeps its rows');
        // They alternate: Alpha's five still waiting and Beta's four, one each in turn.
        const order = manager.queue.snapshot().map((i) => i.campaignId);
        assert.deepEqual(order.slice(0, 8), Array.from({ length: 8 }, (_, i) => (i % 2 ? `camp-${b.id}` : `camp-${a.id}`)));

        // Pausing Beta leaves Alpha sending; Beta's rows wait in the table for its resume.
        store.pause(b.id);
        assert.equal(manager.queue.isPaused, false);
        assert.equal(manager.queue.snapshot().filter((i) => i.campaignId === `camp-${b.id}`).length, 0);
        assert.equal(rows(db, b.id).QUEUED, 4);
        store.resume(b.id);
        assert.equal(store.get(b.id).status, 'running');
        assert.equal(manager.queue.snapshot().filter((i) => i.campaignId === `camp-${b.id}`).length, 4, 'back in turn');

        // Cancelling Beta closes only its rows; Alpha carries on.
        store.cancel(b.id);
        assert.deepEqual(rows(db, b.id), { CANCELLED: 4 });
        assert.equal(manager.queue.isStopped, false);
        assert.equal(manager.pendingByType().campaign, 5, 'Alpha still has its five waiting');
        transport.held = false;
        assert.ok(await until(() => rows(db, a.id).SENT === 6), 'Alpha sends all six');
        assert.deepEqual(rows(db, b.id), { CANCELLED: 4 }, 'nothing of the cancelled one went');
    });

    it('a campaign paused on its own does not block a new one, and rejoins when resumed', async () => {
        const { db, manager, transport, store } = rig();
        transport.held = true;
        const a = store.create({ name: 'Alpha', body: 'Hi {name}', audience: people(3, '98400') });
        const c = store.create({ name: 'Gamma', body: 'Hi {name}', audience: people(2, '98600') });
        store.start(a.id);
        assert.ok(await until(() => manager.inFlight === 1));
        store.pause(a.id);
        assert.equal(manager.queue.isPaused, true, 'alone, a pause holds the queue');
        const started = store.start(c.id);
        assert.equal(started.queued, 2);
        assert.equal(started.together, null, 'the paused one is out of the queue');
        assert.equal(manager.queue.isPaused, false);
        transport.held = false;
        assert.ok(await until(() => rows(db, c.id).SENT === 2), 'Gamma sends');
        assert.deepEqual(rows(db, a.id), { QUEUED: 3 }, 'Alpha waits, paused: the row in its gap did not go either');
        store.resume(a.id);
        assert.ok(await until(() => rows(db, a.id).SENT === 3), 'Alpha finishes after its resume');
    });

    it('says how much of a joining campaign today\'s limit covers after what is already queued', async () => {
        const { manager, transport, store } = rig();
        transport.held = true;
        manager.quota.remaining = () => 7;
        const a = store.create({ name: 'Alpha', body: 'Hi {name}', audience: people(6, '98700') });
        const b = store.create({ name: 'Beta', body: 'Hi {name}', audience: people(4, '98710') });
        store.start(a.id);
        assert.ok(await until(() => manager.inFlight === 1));
        const joined = store.start(b.id);
        // Seven left today, five of them for Alpha's rows still queued: two of Beta's go today.
        assert.equal(joined.overQuota, 2);
        assert.match(joined.policyNotes.at(-1), /Today's limit covers 2 of these 4 messages, after what is already queued\. The other 2 go out tomorrow/);
        transport.held = false;
    });

    it('the plan\'s campaigns-running limit still caps how many send together', async () => {
        const { manager, transport, store } = rig({ policy: { 'campaigns.maxRunning': 2 } });
        transport.held = true;
        const [a, b, c] = ['A', 'B', 'C'].map((n, i) => store.create({ name: n, body: 'Hi {name}', audience: people(2, `9880${i}`) }));
        store.start(a.id);
        assert.ok(await until(() => manager.inFlight === 1));
        assert.equal(store.start(b.id).queued, 2);
        assert.throws(() => store.start(c.id), /allows 2 campaigns running at once/);
        assert.equal(store.get(c.id).status, 'draft');
        transport.held = false;
    });

    it('a start that can never succeed is refused on a busy number too', async () => {
        const { manager, transport, store } = rig();
        transport.held = true;
        const a = store.create({ name: 'Alpha', body: 'Hi {name}', audience: people(2, '98810') });
        store.start(a.id);
        assert.ok(await until(() => manager.inFlight === 1));
        const empty = store.create({ name: 'Empty', body: 'Hi', audience: [] });
        assert.throws(() => store.start(empty.id), /audience is empty/);
        assert.equal(store.get(empty.id).status, 'draft');
        const noText = store.create({ name: 'NoText', body: '', audience: people(1, '98820') });
        assert.throws(() => store.start(noText.id), /template or a body/);
        assert.equal(manager.pendingByType().campaign, 1, 'Alpha untouched');
        transport.held = false;
    });

    it('closes a run at once when everybody was skipped, so it never holds a running slot', () => {
        const { db, store, audits } = rig({ policy: { 'campaigns.maxRunning': 1 } });
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
            assert.match(preview.previews[0].preview, /^(Hi|Hello) there, (20|25)% off in your town, code$/);
        } finally {
            transport.held = false;
            server.close();
        }
    });
});
