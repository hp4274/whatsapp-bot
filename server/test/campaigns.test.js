/**
 * Phase 13: campaigns as records in front of the existing engine.
 *
 * The claims under test: a campaign is CRUD plus four controls; the audience
 * is resolved at send time and never includes someone we may not message; the
 * send itself is handed to CampaignManager untouched (no pacing, cap or
 * dedupe logic lives here); stats come from the message rows; a scheduled
 * campaign waits for a sweeper rather than a timer; and none of it leaks
 * across tenants.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { createCampaignRouter } from '../src/campaigns/routes.js';
import { CAMPAIGNS_SCHEMA } from '../src/campaigns/schema.js';
import { CampaignStore, campaignKey, dueCampaigns } from '../src/campaigns/store.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { TemplateStore } from '../src/templates/store.js';
import { WorkflowStore } from '../src/workflows/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-campaigns-'));
let db;
let A;
let B;

/**
 * A manager that records what it was handed. The real one is not exercised
 * here on purpose: the point of Phase 13 is that this file does not reimplement
 * it, and a fake is how that is checked.
 */
function fakeManager() {
    const manager = {
        calls: [],
        started: 0,
        paused: 0,
        resumeAnswer: true,
        stopped: 0,
        quota: { limit: 500 },
        pausedByQuota: false,
        queue: { reset() { manager.queue.resets += 1; }, resets: 0 },
        resetStats() { manager.resets = (manager.resets ?? 0) + 1; },
        enqueueContacts(contacts, template, options) {
            manager.calls.push({ contacts, template, options });
            return { queued: contacts.length, skipped: 0, campaignId: options.campaignId };
        },
        start() { manager.started += 1; },
        pause() { manager.paused += 1; },
        resume() { return manager.resumeAnswer; },
        stop() { manager.stopped += 1; return 3; },
        statsSnapshot() { return { total: 1, pending: 0 }; },
    };
    return manager;
}

function tenant(tenantId) {
    const scoped = db.forTenant(tenantId).forChannel(tenantId);
    const contacts = new ContactStore(scoped, '91');
    const templates = new TemplateStore(scoped);
    const manager = fakeManager();
    const store = new CampaignStore(scoped, { contacts, templates, manager });
    return { scoped, contacts, templates, manager, store };
}

before(() => {
    db = new Database(path.join(tmp, 'c.db'));
    db.db.exec(CAMPAIGNS_SCHEMA);
    db.db.prepare("INSERT INTO tenants (id, name, slug, status, created_at) VALUES (2, 'B', 'b', 'active', ?)")
        .run('2026-01-01T00:00:00+00:00');
    A = tenant(1);
    B = tenant(2);

    A.contacts.upsert({ phone: '+919000000001', name: 'Asha', tags: ['vip'] });
    A.contacts.upsert({ phone: '+919000000002', name: 'Bobby', tags: ['vip'] });
    const gone = A.contacts.upsert({ phone: '+919000000003', name: 'Gone', tags: ['vip'] });
    A.scoped.addOptOut(gone.phone);
    A.contacts.upsert({ phone: '+919000000004', name: 'Archived', tags: ['vip'], status: 'archived' });
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('campaign records', () => {
    it('creates, reads, edits and deletes', () => {
        const campaign = A.store.create({ name: 'Diwali', body: 'Hi {name}' });
        assert.equal(campaign.status, 'draft');
        assert.equal(A.store.get(campaign.id).name, 'Diwali');
        assert.equal(A.store.update(campaign.id, { name: 'Diwali sale' }).name, 'Diwali sale');
        assert.ok(A.store.list().some((c) => c.id === campaign.id));
        assert.equal(A.store.remove(campaign.id), true);
        assert.equal(A.store.get(campaign.id), null);
    });

    it('refuses a nameless campaign, a schedule with no time, and a status it does not own', () => {
        assert.throws(() => A.store.create({ name: '  ' }), /needs a name/);
        assert.throws(() => A.store.create({ name: 'x', status: 'scheduled' }), /needs scheduled_at/);
        assert.throws(() => A.store.create({ name: 'x', status: 'running' }), /draft or scheduled/);
    });

    it('keeps one tenant out of another tenant\'s campaigns', () => {
        const mine = A.store.create({ name: 'Mine', body: 'hi' });
        assert.equal(B.store.get(mine.id), null);
        assert.throws(() => B.store.require(mine.id), /not found/);
        assert.throws(() => B.store.update(mine.id, { name: 'theirs' }), /not found/);
        assert.throws(() => B.store.cancel(mine.id), /not found/);
        assert.equal(B.store.list().length, 0);
        A.store.remove(mine.id);
    });

    it('will not edit a campaign that has already started', () => {
        const campaign = A.store.create({ name: 'Live', body: 'hi {name}', audience: { tags: ['vip'] } });
        A.store.start(campaign.id);
        assert.throws(() => A.store.update(campaign.id, { body: 'different' }), /cannot be edited/);
        A.store.cancel(campaign.id);
    });
});

describe('the audience', () => {
    it('resolves a segment at send time and drops anyone not messageable', () => {
        const segment = A.contacts.saveSegment({ name: 'VIPs', filter: { tags: ['vip'] } });
        const campaign = A.store.create({ name: 'Seg', body: 'hi', segmentId: segment.id });
        const list = A.store.resolveAudience(campaign).map((c) => c.name);
        assert.deepEqual(list, ['Asha', 'Bobby']); // opted out and blocked are gone
    });

    it('resolves an inline filter the same way', () => {
        const campaign = A.store.create({ name: 'Inline', body: 'hi', audience: { tags: ['vip'] } });
        assert.deepEqual(A.store.resolveAudience(campaign).map((c) => c.name), ['Asha', 'Bobby']);
    });

    it('takes an explicit list, dropping a known number we may not message', () => {
        const campaign = A.store.create({
            name: 'List',
            body: 'hi',
            audience: [
                { name: 'Asha', phone: '+919000000001' },
                { name: 'Gone', phone: '+919000000003' },   // opted out
                { name: 'Stranger', phone: '+919000009999' }, // unknown: keep
            ],
        });
        assert.deepEqual(A.store.resolveAudience(campaign).map((c) => c.name), ['Asha', 'Stranger']);
    });

    it('sees nobody when the tenant has no matching contacts', () => {
        const campaign = B.store.create({ name: 'Empty', body: 'hi', audience: { tags: ['vip'] } });
        assert.deepEqual(B.store.resolveAudience(campaign), []);
        assert.throws(() => B.store.start(campaign.id), /audience is empty/);
    });
});

describe('the message', () => {
    it('uses the template body when a template is named', () => {
        const template = A.templates.create({ name: 'promo', body: 'Hi {name}, 20% off' });
        const campaign = A.store.create({ name: 'Promo', templateId: template.id, audience: { tags: ['vip'] } });
        assert.equal(A.store.messageText(campaign), 'Hi {name}, 20% off');
        A.store.start(campaign.id);
        assert.equal(A.manager.calls.at(-1).template, 'Hi {name}, 20% off');
        A.store.cancel(campaign.id);
    });

    it('refuses a campaign with neither a template nor a body, or a template that is gone', () => {
        const bare = A.store.create({ name: 'Bare', audience: { tags: ['vip'] } });
        assert.throws(() => A.store.start(bare.id), /a template or a body/);
        const ghost = A.store.create({ name: 'Ghost', templateId: 9999, audience: { tags: ['vip'] } });
        assert.throws(() => A.store.start(ghost.id), /template 9999 not found/);
    });
});

describe('the controls', () => {
    it('hands the audience to the manager and never paces it itself', () => {
        const campaign = A.store.create({ name: 'Hand off', body: 'hi {name}', audience: { tags: ['vip'] } });
        const result = A.store.start(campaign.id);
        const call = A.manager.calls.at(-1);

        assert.equal(result.audience, 2);
        assert.equal(call.contacts.length, 2);
        assert.equal(call.options.campaignId, campaignKey(campaign.id));
        assert.equal(call.options.onePerNumber, true);
        assert.equal(A.manager.started > 0, true);
        assert.equal(A.store.get(campaign.id).status, 'running');
        assert.ok(A.store.get(campaign.id).startedAt);
        // The store holds no rate limiter, no quota and no dedupe of its own.
        for (const key of ['rateLimiter', 'quota', 'pace', 'sentRecipients']) {
            assert.equal(key in A.store, false, key);
        }
        A.store.cancel(campaign.id);
    });

    it('pauses, resumes and cancels, and refuses the moves that make no sense', () => {
        const campaign = A.store.create({ name: 'Controls', body: 'hi', audience: { tags: ['vip'] } });
        assert.throws(() => A.store.pause(campaign.id), /draft campaign cannot be paused/);
        assert.throws(() => A.store.resume(campaign.id), /draft campaign cannot be resumed/);

        A.store.start(campaign.id);
        assert.throws(() => A.store.start(campaign.id), /already running/);
        assert.equal(A.store.pause(campaign.id).status, 'paused');
        assert.throws(() => A.store.start(campaign.id), /is paused/);
        assert.equal(A.store.resume(campaign.id).status, 'running');

        assert.equal(A.store.cancel(campaign.id).status, 'cancelled');
        assert.ok(A.store.get(campaign.id).finishedAt);
        assert.throws(() => A.store.start(campaign.id), /is cancelled/);
        assert.equal(A.store.cancel(campaign.id).status, 'cancelled'); // idempotent
    });

    it('lets the manager refuse a resume that would hit the daily cap', () => {
        const campaign = A.store.create({ name: 'Capped', body: 'hi', audience: { tags: ['vip'] } });
        A.store.start(campaign.id);
        A.store.pause(campaign.id);
        A.manager.resumeAnswer = false;
        assert.throws(() => A.store.resume(campaign.id), /daily limit of 500/);
        assert.equal(A.store.get(campaign.id).status, 'paused');
        A.manager.resumeAnswer = true;
        A.store.cancel(campaign.id);
    });
});

describe('stats', () => {
    it('counts the message rows and marks a drained campaign done', () => {
        const campaign = A.store.create({ name: 'Counted', body: 'hi', audience: { tags: ['vip'] } });
        A.store.start(campaign.id);
        const insert = (status) => A.scoped.insert({
            messageId: `m-${Math.random().toString(36).slice(2)}`,
            recipient: '+919000000001',
            message: 'hi',
            status,
            campaignId: campaignKey(campaign.id),
        });
        insert('SENT');
        insert('SENT');
        insert('FAILED');
        insert('QUEUED');

        let { stats } = A.store.stats(campaign.id);
        assert.deepEqual({ ...stats, byStatus: undefined },
            { total: 4, pending: 1, failed: 1, sent: 2, byStatus: undefined });
        assert.equal(A.store.get(campaign.id).status, 'running'); // one still queued

        A.scoped.db.prepare("UPDATE messages SET status = 'SENT' WHERE campaign_id = ? AND status = 'QUEUED'")
            .run(campaignKey(campaign.id));
        ({ stats } = A.store.stats(campaign.id));
        assert.equal(stats.pending, 0);
        const done = A.store.get(campaign.id);
        assert.equal(done.status, 'done');
        assert.ok(done.finishedAt);
        assert.equal(done.stats.sent, 3); // the snapshot is kept on the row
    });

    it('does not count another tenant\'s messages', () => {
        const mine = A.store.create({ name: 'Isolated', body: 'hi' });
        B.scoped.insert({
            messageId: 'other-tenant', recipient: '+919000000001', message: 'hi',
            status: 'SENT', campaignId: campaignKey(mine.id),
        });
        assert.equal(A.store.stats(mine.id).stats.total, 0);
    });
});

describe('scheduling', () => {
    it('reports a scheduled campaign as due, and never starts it itself', () => {
        const campaign = A.store.create({ name: 'Later', body: 'hi', status: 'scheduled', scheduledAt: '2026-01-01T09:00:00+00:00' });
        const before = A.store.create({ name: 'Much later', body: 'hi', status: 'scheduled', scheduledAt: '2030-01-01T09:00:00+00:00' });

        const due = A.store.due('2026-06-01T00:00:00+00:00').map((c) => c.id);
        assert.ok(due.includes(campaign.id));
        assert.ok(!due.includes(before.id));
        // Still scheduled: `due` reads, a sweeper starts.
        assert.equal(A.store.get(campaign.id).status, 'scheduled');

        // The cross-tenant view the scheduler needs.
        const all = dueCampaigns(db, '2026-06-01T00:00:00+00:00');
        assert.ok(all.some((row) => row.id === campaign.id && row.tenantId === 1));
        A.store.remove(campaign.id);
        A.store.remove(before.id);
    });
});

describe('the routes', () => {
    const state = {};
    let server;
    let base;

    before(async () => {
        const T = tenant(1);
        Object.assign(state, {
            channel: { id: 1 },
            contacts: T.contacts,
            templates: T.templates,
            workflows: new WorkflowStore(T.scoped),
            manager: T.manager,
            media: new Map([['m1', { kind: 'image' }]]),
            transport: { isConnected: () => true },
            broadcast: () => {},
        });
        const app = express();
        app.use(express.json());
        app.use(createCampaignRouter({ db: T.scoped, state }));
        server = app.listen(0);
        await new Promise((done) => server.once('listening', done));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(() => server?.close());

    const call = async (method, url, body) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, body: await res.json() };
    };

    it('does CRUD, start, pause, resume, cancel and stats over HTTP', async () => {
        const created = await call('POST', '/campaigns', { name: 'HTTP', body: 'Hi {name}', audience: { tags: ['vip'] } });
        assert.equal(created.status, 201);
        const id = created.body.campaign.id;

        assert.equal((await call('GET', `/campaigns/${id}`)).body.campaign.name, 'HTTP');
        assert.equal((await call('PUT', `/campaigns/${id}`, { name: 'HTTP 2' })).body.campaign.name, 'HTTP 2');
        assert.ok((await call('GET', '/campaigns')).body.campaigns.length > 0);

        const started = await call('POST', `/campaigns/${id}/start`);
        assert.equal(started.status, 200);
        assert.equal(started.body.audience, 2);
        assert.equal((await call('POST', `/campaigns/${id}/pause`)).body.campaign.status, 'paused');
        assert.equal((await call('POST', `/campaigns/${id}/resume`)).body.campaign.status, 'running');

        const stats = await call('GET', `/campaigns/${id}/stats`);
        assert.equal(stats.status, 200);
        assert.equal(stats.body.campaignId, campaignKey(id));

        assert.equal((await call('POST', `/campaigns/${id}/cancel`)).body.campaign.status, 'cancelled');
        assert.equal((await call('POST', `/campaigns/${id}/explode`)).status, 404);
        assert.equal((await call('GET', '/campaigns/99999')).status, 404);
    });

    it('previews against the first few of the audience and names the unfilled variables', async () => {
        const created = await call('POST', '/campaigns', {
            name: 'Preview', body: 'Hi {name}, your code is {coupon}', audience: { tags: ['vip'] },
        });
        const preview = await call('POST', `/campaigns/${created.body.campaign.id}/preview`, { limit: 2 });
        assert.equal(preview.status, 200);
        assert.equal(preview.body.previews.length, 2);
        assert.equal(preview.body.previews[0].preview, 'Hi Asha, your code is {coupon}');
        assert.deepEqual(preview.body.missing, ['coupon']);
        assert.equal(preview.body.audience, 2);
    });

    it('refuses to start without a transport, and reports media that is gone', async () => {
        const created = await call('POST', '/campaigns', { name: 'No wire', body: 'hi', audience: { tags: ['vip'] }, mediaId: 'nope' });
        const id = created.body.campaign.id;
        state.transport = { isConnected: () => false };
        assert.equal((await call('POST', `/campaigns/${id}/start`)).status, 409);
        state.transport = { isConnected: () => true };
        assert.equal((await call('POST', `/campaigns/${id}/start`)).status, 404);
        assert.equal((await call('PUT', `/campaigns/${id}`, { mediaId: 'm1' })).status, 200);
        assert.equal((await call('POST', `/campaigns/${id}/start`)).status, 200);
        assert.deepEqual(state.manager.calls.at(-1).options.media, { kind: 'image' });
        await call('POST', `/campaigns/${id}/cancel`);
    });

    it('rejects a bad campaign with the message, not a stack trace', async () => {
        const res = await call('POST', '/campaigns', { name: '' });
        assert.equal(res.status, 400);
        assert.match(res.body.errors[0], /needs a name/);
    });
});
