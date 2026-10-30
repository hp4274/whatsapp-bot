/**
 * A campaign whose last message left the queue reads `done` everywhere at once: in the list, in the admin view and
 * in the audit log, without anyone opening its detail page (which used to be the only thing that closed it).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { CampaignStore, finishedCampaigns } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return false;
};

const config = { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', transport: TRANSPORT_SANDBOX, safetyEnabled: false, humanTiming: false };
const phones = Array.from({ length: 4 }, (_, i) => `9198222${String(i).padStart(5, '0')}`);
const audience = phones.map((phone, i) => ({ name: `P${i}`, phone }));

describe('closing a finished campaign', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-done-'));
    let db;
    let scoped;
    let sent = 0;
    const transport = {
        name: 'fake', realDelivery: true, supportsReceipts: false, isConnected: () => true,
        async sendMessage() {
            sent += 1;
            return { providerId: `p${sent}`, status: Status.SENT };
        },
        getStatus: () => null,
        async disconnect() {},
    };

    before(() => {
        db = new Database(path.join(tmp, 'done.db'));
        scoped = db.forTenant(1).forChannel(1);
    });
    after(() => {
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('the sweeper query finds a running campaign with nothing left to send, and stats() closes it once', async () => {
        const manager = new CampaignManager(scoped, transport, config);
        const store = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), manager, canSend: () => true });
        const settled = [];
        store.onSettled = (campaign, stats) => settled.push({ status: campaign.status, sent: stats.sent });
        const campaign = store.create({ name: 'Sweep', body: 'Hi {name}', audience });
        store.start(campaign.id);
        assert.ok(await waitFor(() => sent === phones.length), 'every message went out');
        await sleep(50);

        // Nobody opened the detail page: the row still reads running, and the sweep sees it.
        assert.equal(store.get(campaign.id).status, 'running');
        assert.deepEqual(finishedCampaigns(scoped).map((c) => c.id), [campaign.id]);

        store.stats(campaign.id);
        assert.equal(store.get(campaign.id).status, 'done');
        assert.ok(store.get(campaign.id).finishedAt, 'finished_at is written');
        assert.deepEqual(settled, [{ status: 'done', sent: phones.length }]);
        assert.deepEqual(finishedCampaigns(scoped), [], 'a done campaign is never swept again');
        store.stats(campaign.id);
        assert.equal(settled.length, 1, 'the hook fires once, not on every later read');
        await manager.shutdown();
    });

    it('stopping a run cancels its rows but keeps a waiting quick send, and the queue takes messages again', async () => {
        const manager = new CampaignManager(scoped, transport, config);
        manager.queue.pause(); // nothing leaves while we look
        const bulk = manager.enqueueJob({ recipient: phones[0], text: 'Bulk', campaignId: 'camp-900', messageType: 'campaign' });
        const quick = manager.enqueueJob({ recipient: phones[1], text: 'Your OTP is 1234', messageType: 'transactional' });
        assert.equal(manager.stop('Stopped by operator'), 1, 'only the bulk row is dropped');
        const status = (id) => scoped.db.prepare('SELECT status FROM messages WHERE message_id = ?').get(id).status;
        assert.equal(status(bulk), Status.CANCELLED);
        assert.equal(status(quick), Status.QUEUED);
        assert.equal(manager.queue.isStopped, false, 'reopened: nothing was in flight');
        assert.equal(manager.queue.pending, 1, 'the quick send kept its place');
        assert.ok(manager.enqueueJob({ recipient: phones[2], text: 'Reply', messageType: 'auto_reply' }), 'a later reply is accepted');
        await manager.shutdown();
    });

    it('a kept quick send survives a new run reopening the queue before the stop\'s own reopen', async () => {
        const manager = new CampaignManager(scoped, transport, config);
        manager.queue.pause();
        manager.enqueueJob({ recipient: phones[0], text: 'Bulk', campaignId: 'camp-901', messageType: 'campaign' });
        const quick = manager.enqueueJob({ recipient: phones[1], text: 'Your OTP is 5678', messageType: 'transactional' });
        manager.inFlight = 1; // a send is still out: the reopen has to wait for it
        manager.stop('Stopped by operator');
        // Before that send returns, a new run starts and reopens the queue itself.
        manager.queue.reset();
        manager.inFlight = 0;
        await sleep(250);
        assert.ok(manager.queue.snapshot().some((item) => item.messageId === quick), 'the quick send is queued again');
        await manager.shutdown();
    });

    it('a quick send during a run is not counted in the run\'s progress', async () => {
        const manager = new CampaignManager(scoped, transport, config);
        manager.queue.pause();
        manager.campaignId = 'camp-902';
        manager.enqueueJob({ recipient: phones[0], text: 'Bulk', campaignId: 'camp-902', messageType: 'campaign' });
        manager.enqueueJob({ recipient: phones[1], text: 'Your OTP is 4321', messageType: 'transactional' });
        const snap = manager.statsSnapshot();
        assert.equal(snap.total, 1, 'the run has one message');
        assert.equal(snap.pending, 1, 'and one waiting: the OTP is not the run\'s');
        await manager.shutdown();
    });

    it('only a campaign\'s own number acts on it', () => {
        const one = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), canSend: () => true });
        const other = db.forTenant(1).forChannel(2);
        const two = new CampaignStore(other, { contacts: new ContactStore(other, '91'), canSend: () => true });
        const campaign = one.create({ name: 'Mine', body: 'Hi', audience, channelId: 1 });
        scoped.db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id);
        for (const act of [() => two.pause(campaign.id), () => two.cancel(campaign.id), () => two.remove(campaign.id)]) {
            assert.throws(act, (err) => err.status === 409 && /another number/.test(err.message));
        }
        assert.equal(two.recover(campaign.id), false);
        assert.equal(one.get(campaign.id).status, 'running', 'untouched');
    });

    it('a running campaign with messages still queued is left alone', () => {
        const store = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), canSend: () => true });
        const campaign = store.create({ name: 'Open', body: 'Hi', audience });
        scoped.db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(campaign.id);
        scoped.db.prepare(
            `INSERT INTO messages (message_id, tenant_id, channel_id, recipient, message, status, campaign_id, created_at, updated_at)
             VALUES ('open-1', 1, 1, ?, 'Hi', 'QUEUED', ?, datetime('now'), datetime('now'))`).run(phones[0], `camp-${campaign.id}`);
        assert.ok(!finishedCampaigns(scoped).some((c) => c.id === campaign.id));
        // And a running campaign that has no messages yet (still being queued) is not "finished" either.
        const empty = store.create({ name: 'Empty', body: 'Hi', audience });
        scoped.db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(empty.id);
        assert.ok(!finishedCampaigns(scoped).some((c) => c.id === empty.id));
    });
});
