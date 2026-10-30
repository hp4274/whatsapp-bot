/**
 * The sending-safety audit fixes: an admin form saved back unchanged pins nothing, a business's own config save
 * never freezes the admin's enforced values, `fixed` pacing never switches a QR number's gaps off, the rest count
 * carries across back-to-back campaigns, quiet windows show only while they hold bulk, long quiet hours never
 * overlap, a pin can always be cleared, and a start level is logged as one.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { BRAKES, LEVELS, MAX_QUIET_HOURS, dayPlan, levelFor } from '../src/campaign/humanize.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULT_SENDING } from '../src/campaign/safety.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { applySendingPolicy } from '../src/policy/levels.js';
import { Status } from '../src/protocol.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-safety-card-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !check()) await sleep(20);
    return check();
};
let file = 0;
const freshDb = () => new Database(path.join(tmp, `m${(file += 1)}.db`));
const qr = (extra = {}) => {
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, rateLimitPerSecond: 1000, retryDelay: 0.01, ...extra };
    delete config.misc;
    return config;
};
const people = (phones) => phones.map((phone, i) => ({ name: `P${i}`, phone }));

class FakeLive {
    realDelivery = true;
    supportsReceipts = false;
    supportsRegistrationCheck = false;
    sent = [];
    isConnected() { return true; }
    async sendMessage(to) {
        this.sent.push({ to, at: Date.now() });
        return { providerId: `p${this.sent.length}`, status: Status.SENT };
    }
    getStatus() { return null; }
    async disconnect() {}
}

describe('admin and business saves', () => {
    let app;
    let db;
    let server;
    let base;
    let tenant;
    let sup;
    let owner;
    let qrId;
    let sandboxId;
    const call = async (token, method, url, body, channel) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                ...(body ? { 'content-type': 'application/json' } : {}),
                ...(channel ? { 'x-channel-id': String(channel) } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const safetyUrl = () => `/api/admin/tenants/${tenant.id}/safety`;
    const ceiling = async () => (await call(owner, 'GET', '/api/safety', null, qrId)).body.safety.ceiling;
    const stored = (id) => new Channels(db.forTenant(tenant.id)).get(id).settings;

    before(async () => {
        db = new Database(path.join(tmp, 'app.db'));
        app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        tenant = app.locals.tenancy.createTenant('Card Shop', 'card-shop');
        app.locals.policy.set(`tenant:${tenant.id}`, { 'channels.dailyCap': 500 });
        sup = sessionFor(app, { role: 'super_admin' });
        owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
        const channels = new Channels(db.forTenant(tenant.id));
        qrId = channels.create({ displayName: 'QR', settings: { transport: TRANSPORT_BAILEYS, autoConnect: false, dailyLimit: 0 } }).id;
        sandboxId = channels.create({ displayName: 'Box', settings: { transport: TRANSPORT_SANDBOX, autoConnect: false } }).id;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
    });

    it('shows no admin day as 0, and an unchanged form saved back pins nothing (H1)', async () => {
        assert.equal(await ceiling(), 500, 'the plan\'s day');
        const shown = await call(sup, 'GET', safetyUrl());
        assert.equal(shown.body.safety.dailyLimit, 0, 'no admin value, not DEFAULTS\' 250');
        const enforcedBefore = app.locals.tenancy.enforcedSafety(app.locals.tenancy.getTenant(tenant.id));

        const saved = await call(sup, 'PUT', safetyUrl(), shown.body.safety);
        assert.equal(saved.status, 200);
        assert.deepEqual(app.locals.tenancy.getTenant(tenant.id).safety, {}, 'nothing the admin did not choose is stored');
        assert.deepEqual(app.locals.tenancy.enforcedSafety(app.locals.tenancy.getTenant(tenant.id)), enforcedBefore);
        assert.equal(await ceiling(), 500, 'still the plan\'s day, not 250');

        // A real change among the unchanged fields is the only thing kept.
        await call(sup, 'PUT', safetyUrl(), { ...shown.body.safety, restEvery: 12 });
        assert.deepEqual(app.locals.tenancy.getTenant(tenant.id).safety, { restEvery: 12 });
        await call(sup, 'PUT', safetyUrl(), { restEvery: null });
    });

    it('a business\'s config save never stores the admin\'s enforced values as its own (H2)', async () => {
        await call(sup, 'PUT', safetyUrl(), { minDelaySeconds: 30, maxDelaySeconds: 40 });
        assert.equal((await call(owner, 'GET', '/api/config', null, qrId)).body.config.minDelaySeconds, 30);

        const put = await call(owner, 'PUT', '/api/config', { defaultCountryCode: '91' }, qrId);
        assert.equal(put.status, 200);
        assert.equal(put.body.config.minDelaySeconds, 30, 'the running config keeps the enforced value');
        assert.equal(stored(qrId).defaultCountryCode, '91');
        assert.notEqual(stored(qrId).minDelaySeconds, 30, 'not frozen into the number\'s own settings');

        // The admin lifts it: the number goes back to its own value, as it would after a restart.
        await call(sup, 'PUT', safetyUrl(), { minDelaySeconds: null, maxDelaySeconds: null });
        const live = (await call(owner, 'GET', '/api/config', null, qrId)).body.config;
        assert.equal(live.minDelaySeconds, stored(qrId).minDelaySeconds);
        assert.notEqual(live.minDelaySeconds, 30);
    });

    it('a level pin can be cleared on a number that is no longer QR (L4)', async () => {
        assert.equal((await call(sup, 'PUT', `/api/admin/numbers/${qrId}/level`, { level: 5 })).status, 200);
        assert.equal((await call(owner, 'PUT', '/api/config', { transport: TRANSPORT_SANDBOX }, qrId)).status, 200);
        assert.equal((await call(sup, 'PUT', `/api/admin/numbers/${qrId}/level`, { level: 6 })).status, 400, 'no new pin');
        const cleared = await call(sup, 'PUT', `/api/admin/numbers/${qrId}/level`, { level: null });
        assert.equal(cleared.status, 200);
        assert.equal(db.db.prepare('SELECT level_pin FROM channel_ops WHERE channel_id = ?').get(qrId)?.level_pin ?? null, null);
        assert.equal((await call(sup, 'PUT', `/api/admin/numbers/${sandboxId}/brakes`, { hours: null })).status, 200,
            'brakes back on works anywhere too');
        await call(owner, 'PUT', '/api/config', { transport: TRANSPORT_BAILEYS }, qrId);
    });
});

describe('pacing on a QR number', () => {
    // Recipient daytime all day and no rest windows, so only the gap can hold a send.
    const awake = (manager, levels = null) => applySendingPolicy(manager.quota, {
        'sending.daytimeFrom': 0, 'sending.daytimeTo': 24, 'sending.skipQuietTime': true,
        ...(levels ? { 'sending.levels': levels } : {}),
    }, () => ({ level: 11, at: new Date().toISOString() }));

    it('ignores pacingMode fixed while the number runs on a level (H3)', async () => {
        const db = freshDb();
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr({ pacingMode: 'fixed', humanTiming: true }));
        awake(manager);
        const events = [];
        manager.on('event', (e) => events.push(e));
        try {
            assert.equal(manager.safetyStatus().pacingMode, 'adaptive', 'reported as it runs');
            manager.enqueueContacts(people(['919811110001', '919811110002']), 'Hi {name}', { campaignId: 'fixed' });
            manager.start();
            assert.ok(await until(() => transport.sent.length >= 1));
            assert.ok(await until(() => events.some((e) => e.type === 'pacing' && e.seconds > 0)), 'the level\'s gap applies');
            await sleep(300);
            assert.equal(transport.sent.length, 1, 'the second waits its gap');
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('keeps the rest count across back-to-back campaigns (M3)', async () => {
        const db = freshDb();
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr({ pacingMode: 'adaptive', humanTiming: false }));
        // No gap at all, a rest every 2 sends (±30%: 1-3), a rest of about 2s: longer than the moment between two
        // campaigns, so a due rest is still owed (and announced) when the next one starts.
        awake(manager, LEVELS.map((r) => ({ ...r, minSeconds: 0, maxSeconds: 0, restEvery: 2, restMinMinutes: 0.03, restMaxMinutes: 0.035 })));
        const rests = [];
        manager.on('event', (e) => { if (e.type === 'pacing' && e.resting) rests.push(e); });
        try {
            // Six, so a rest falls inside the run whatever the jitter draws.
            for (let i = 0; i < 6; i += 1) {
                manager.enqueueContacts(people([`91981111100${i}`]), 'Hi {name}', { campaignId: `small${i}` });
                manager.start();
                assert.ok(await until(() => transport.sent.length === i + 1, 8000), `campaign ${i} sent`);
            }
            assert.ok(rests.length >= 1, 'one-message campaigns in a row still take a rest');
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('a pause pressed during the gap holds the message that was waiting it out', async () => {
        const db = freshDb();
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr({ pacingMode: 'adaptive', humanTiming: false }));
        // A gap of about 1.5s between messages, no rests.
        awake(manager, LEVELS.map((r) => ({ ...r, minSeconds: 1.5, maxSeconds: 1.5, restEvery: 1000 })));
        try {
            manager.enqueueContacts(people(['919811111201', '919811111202']), 'Hi {name}', { campaignId: 'gap' });
            manager.start();
            assert.ok(await until(() => transport.sent.length === 1, 6000), 'the first one goes');
            manager.pause(); // now, inside the gap before the second
            await sleep(3500);
            assert.equal(transport.sent.length, 1, 'nothing more went out after the pause');
            assert.equal(manager.queue.pending, 1, 'the second is back in the queue, first in line');
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('reports quiet windows only while they hold bulk (M4)', async () => {
        const db = freshDb();
        const manager = new CampaignManager(db, new FakeLive(), qr({ humanTiming: true }));
        try {
            assert.ok(manager.safetyStatus().quiet, 'on safety, the windows apply');
            manager.applyConfig({ ...manager.config, humanTiming: false });
            assert.equal(manager.safetyStatus().quiet, null, 'no human timing: no windows');
            manager.applyConfig({ ...manager.config, humanTiming: true, safetyEnabled: false });
            assert.equal(manager.safetyStatus().quiet, null, 'left sending safety: no windows');
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('takes the plan\'s speed in the status, as the run does (M2)', async () => {
        const db = freshDb();
        const manager = new CampaignManager(db, new FakeLive(), qr({ humanTiming: false }));
        manager.bulkPolicy = () => ({ maxSpeed: 'safe' });
        try {
            const status = manager.safetyStatus(20, 'balanced');
            assert.equal(status.pacing, 'safe');
            const row = manager.quota.tier();
            assert.deepEqual([status.minSeconds, status.maxSeconds], [row.minSeconds * 1.5, row.maxSeconds * 1.5]);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });
});

describe('quiet hours and level history', () => {
    it('never overlaps or crosses midnight, even at the policy\'s longest quiet time (L3)', () => {
        for (let day = 0; day < 200; day += 1) {
            const at = new Date(Date.UTC(2026, 0, 1) + day * 86_400_000);
            for (const hours of [[MAX_QUIET_HOURS, MAX_QUIET_HOURS], [20, 20]]) {
                const plan = dayPlan(`seed${day}`, { quietHours: hours }, at, 'UTC');
                assert.ok(plan.quietMinutes <= MAX_QUIET_HOURS * 60);
                let end = 0;
                for (const w of plan.windows) {
                    assert.ok(w.start >= end, `day ${day}: windows overlap`);
                    end = w.start + w.minutes;
                }
                assert.ok(end <= 1440, `day ${day}: past midnight`);
            }
        }
    });

    it('logs the questions\' start as a start, not a promotion with health figures', () => {
        const now = new Date();
        const state = { level: 1, demotedAt: null, cleanChecks: 0, checkedAt: null };
        const asked = levelFor({}, { now, start: 5, startedAt: now.toISOString(), state, brakes: BRAKES });
        const change = asked.changes.find((c) => c.kind === 'level');
        assert.equal(change.reason, 'start');
        assert.match(change.text, /Started at level 5 from the two questions/);
        const skipped = levelFor({}, { now, start: 8, startedAt: now.toISOString(), state, startSkipped: true });
        assert.match(skipped.changes.find((c) => c.kind === 'level').text, /Skipped the questions: started at level 8/);
        assert.equal(DEFAULT_SENDING.levels, LEVELS);
    });
});
