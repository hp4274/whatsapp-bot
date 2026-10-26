/**
 * Repeating campaigns.
 *
 * Claims under test: `options.recurrence` is validated (and refused with
 * spread); the next run date steps from the schedule and skips missed runs;
 * a finished run books exactly one next run with its reply rules, and the
 * chain stops after `until` or when the plan refuses the booking - without
 * retrying every sweep; the app sweep notices a run finishing and books it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignStore, campaignKey, nextRun } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { InteractiveStore } from '../src/messaging/replies.js';
import { Status } from '../src/protocol.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-recur-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return false;
};

describe('nextRun', () => {
    const now = new Date('2026-03-10T12:00:00Z');
    it('steps a day, a week or a month past now, skipping missed runs', () => {
        assert.equal(nextRun('2026-03-10T09:00:00Z', 'day', now).toISOString(), '2026-03-11T09:00:00.000Z');
        assert.equal(nextRun('2026-03-01T09:00:00Z', 'week', now).toISOString(), '2026-03-15T09:00:00.000Z');
        assert.equal(nextRun('2026-02-10T09:00:00Z', 'month', now).toISOString(), '2026-04-10T09:00:00.000Z');
        assert.equal(nextRun('2026-01-31T09:00:00Z', 'month', new Date('2026-02-01T00:00:00Z')).toISOString(),
            '2026-02-28T09:00:00.000Z', 'the 31st repeats on the last day of a short month');
        assert.equal(nextRun(null, 'day', now), null);
        assert.equal(nextRun('2026-03-10T09:00:00Z', 'hour', now), null);
    });
});

function fakeManager() {
    const manager = {
        campaignId: '',
        quota: { limit: 500 },
        pausedByQuota: false,
        queue: { reset() {} },
        resetStats() {},
        enqueueContacts(contacts, template, options) {
            manager.campaignId = options.campaignId;
            return { queued: contacts.length, skipped: 0, campaignId: options.campaignId };
        },
        start() {},
        stop() { return 0; },
    };
    return manager;
}

describe('the campaign store', () => {
    let db;
    let scoped;
    let store;
    let interactions;
    let policy = {};

    before(() => {
        db = new Database(path.join(tmp, 'store.db'));
        scoped = db.forTenant(1).forChannel(1);
        interactions = new InteractiveStore(scoped);
        store = new CampaignStore(scoped, {
            contacts: new ContactStore(scoped, '91'),
            manager: fakeManager(),
            policy: () => policy,
            replies: () => interactions,
        });
    });
    after(() => db?.close());

    /** Start a campaign and mark its one row delivered, so the next stats() calls it done. */
    const runToEnd = (campaign) => {
        store.start(campaign.id);
        scoped.insert({ messageId: `m-${campaign.id}`, recipient: '919800000201', message: 'hi', status: Status.SENT, campaignId: campaignKey(campaign.id) });
    };

    it('validates the recurrence and refuses it with spread', () => {
        const ok = store.create({ name: 'R', body: 'hi', options: { recurrence: { every: 'week', until: '2026-12-31' } } });
        assert.deepEqual(ok.options.recurrence, { every: 'week', until: '2026-12-31' });
        assert.equal(store.create({ name: 'R0', body: 'hi', options: { recurrence: null } }).options.recurrence, null);
        assert.throws(() => store.create({ name: 'x', options: { recurrence: { every: 'hour' } } }), (e) => e.status === 400);
        assert.throws(() => store.create({ name: 'x', options: { recurrence: { every: 'day', until: 'soon' } } }), (e) => e.status === 400);
        assert.throws(() => store.create({
            name: 'x', audience: [{ phone: '919800000299' }],
            options: { recurrence: { every: 'day' }, spread: { from: '2026-11-01', to: '2026-11-02' } },
        }), (e) => e.status === 400 && /spread/.test(e.message));
    });

    it('books exactly one next run when a run finishes, reply rules included', () => {
        const parent = store.create({
            name: 'Weekly', body: 'Hi {name}', status: 'scheduled', scheduledAt: '2026-10-19T09:00:00+00:00',
            audience: [{ name: 'Ann', phone: '919800000201' }],
            options: { recurrence: { every: 'week' }, pacing: 'safe', statusReason: 'old note' },
        });
        interactions.setRules(campaignKey(parent.id), [{ optionId: 'any', action: 'tag', value: 'x' }]);
        assert.deepEqual(store.spawnRecurrences(new Date('2026-10-24T00:00:00Z')), [], 'nothing until it ran');
        runToEnd(parent);

        const now = new Date('2026-10-24T00:00:00Z');
        const [next] = store.spawnRecurrences(now);
        assert.ok(next, 'booked');
        assert.equal(store.get(parent.id).status, 'done', 'the sweep noticed the run finishing');
        assert.equal(next.status, 'scheduled');
        assert.equal(next.scheduledAt, '2026-10-26T09:00:00+00:00');
        assert.equal(next.body, 'Hi {name}');
        assert.equal(next.audienceSize, 1);
        assert.equal(next.options.pacing, 'safe');
        assert.deepEqual(next.options.recurrence, { every: 'week' });
        assert.equal(next.options.previousId, parent.id);
        assert.equal(next.options.statusReason, undefined);
        assert.equal(store.get(parent.id).options.nextId, next.id);
        assert.deepEqual(interactions.rules(campaignKey(next.id)), interactions.rules(campaignKey(parent.id)));

        assert.deepEqual(store.spawnRecurrences(now), [], 'once only');
        assert.equal(store.list().filter((c) => c.name === 'Weekly').length, 2);
    });

    it('stops after the until date', () => {
        const parent = store.create({
            name: 'Ends', body: 'hi', status: 'scheduled', scheduledAt: '2026-10-20T09:00:00+00:00',
            audience: [{ phone: '919800000201' }], options: { recurrence: { every: 'week', until: '2026-10-26' } },
        });
        runToEnd(parent);
        assert.deepEqual(store.spawnRecurrences(new Date('2026-10-24T00:00:00Z')), [], 'the 27th is past the end');
        assert.match(store.get(parent.id).options.recurrenceNote, /ended/);
        assert.equal(store.list().filter((c) => c.name === 'Ends').length, 1);
    });

    it('notes a plan refusal on the parent instead of retrying every sweep', () => {
        const parent = store.create({
            name: 'Refused', body: 'hi', status: 'scheduled', scheduledAt: '2026-10-20T09:00:00+00:00',
            audience: [{ phone: '919800000201' }], options: { recurrence: { every: 'day' } },
        });
        runToEnd(parent);
        policy = { 'campaigns.maxScheduled': 1 }; // the 'Weekly' child already holds the one slot
        try {
            assert.deepEqual(store.spawnRecurrences(new Date('2026-10-24T00:00:00Z')), []);
            assert.match(store.get(parent.id).options.recurrenceNote, /could not be booked: Your plan allows 1 scheduled/);
            policy = {};
            assert.deepEqual(store.spawnRecurrences(new Date('2026-10-24T00:00:00Z')), [], 'no retry loop');
        } finally {
            policy = {};
        }
    });
});

describe('the sweep', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'http.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, retryDelay: 0.01, maxRetries: 1 };
        delete config.misc;
        app = createTestApp({ db, config });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
    });

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    it('starts a due repeating campaign, then books its next run once it is done', async () => {
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        const created = await api('POST', '/api/campaigns', {
            name: 'Daily', body: 'Hi {name}', status: 'scheduled', scheduledAt: '2020-01-01T08:00:00+00:00',
            audience: [{ name: 'Sam', phone: '919855500201' }],
            options: { recurrence: { every: 'day' }, pacing: 'fast' },
        });
        assert.equal(created.status, 201);
        const { id } = created.body.campaign;
        await app.locals.sweep();
        assert.ok(await waitFor(() => db.history({ campaignId: campaignKey(id) }).some((r) => r.status === Status.SANDBOX)));
        await app.locals.sweep();
        await app.locals.sweep();

        const parent = (await api('GET', `/api/campaigns/${id}`)).body.campaign;
        assert.equal(parent.status, 'done');
        assert.ok(parent.options.nextId);
        const next = (await api('GET', `/api/campaigns/${parent.options.nextId}`)).body.campaign;
        assert.equal(next.status, 'scheduled');
        assert.ok(new Date(next.scheduledAt) > new Date());
        assert.equal(next.scheduledAt.slice(11), '08:00:00+00:00', 'same time of day');
        const all = (await api('GET', '/api/campaigns')).body.campaigns.filter((c) => c.name === 'Daily');
        assert.equal(all.length, 2, 'exactly one next run');
    });
});
