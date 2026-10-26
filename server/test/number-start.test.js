/**
 * The number questions (policy/levels.js startLevelFor): the start level they
 * give, how levelFor and DailyQuota apply and void it, the tenant routes
 * (POST/GET /api/channels/:id/start), bulk held until answered, and the
 * business's health payload that shows numbers instead of levels.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { LEVELS, levelFor } from '../src/campaign/humanize.js';
import { DailyQuota } from '../src/campaign/safety.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createChannelOps } from '../src/policy/channelOps.js';
import { applySendingPolicy, skipStartLevel, startLevelFor } from '../src/policy/levels.js';
import { NUMBER_SKIP_VERSION } from '../src/tenancy.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-number-start-'));
const DAY = 86_400_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

describe('startLevelFor', () => {
    it('maps age + usage to levels 2-7', () => {
        // score = age + usage: 0-1 -> 2, 2 -> 3, ... 6 -> 7.
        const want = [2, 2, 3, 4, 5, 6, 7];
        for (let age = 0; age <= 3; age += 1) {
            for (let usage = 0; usage <= 3; usage += 1) {
                assert.equal(startLevelFor({ age, usage }), want[age + usage], `age ${age}, usage ${usage}`);
            }
        }
        assert.deepEqual([2, 3, 4, 5, 6, 7].map((l) => LEVELS[l].dailyLimit), [20, 40, 60, 100, 150, 200]);
    });

    it('refuses an answer outside 0-3', () => {
        for (const bad of [{}, { age: 1 }, { age: 4, usage: 0 }, { age: -1, usage: 0 }, { age: 1.5, usage: 1 }, { age: '1', usage: 1 }]) {
            assert.equal(startLevelFor(bad), null, JSON.stringify(bad));
        }
    });

    it('skipping starts at the level that sends the plan day', () => {
        assert.equal(skipStartLevel(LEVELS, 250), 8);
        assert.equal(skipStartLevel(LEVELS, 500), 10);
        assert.equal(skipStartLevel(LEVELS, 1000), 11);
        assert.equal(skipStartLevel(LEVELS, null), 11, 'no plan day: the top');
    });
});

describe('levelFor with a start level', () => {
    const now = new Date();
    it('the start counts as earned and the number keeps climbing from it', () => {
        assert.equal(levelFor({}, { now, start: 4, startedAt: now.toISOString() }).earned, 4);
        // Level 5 needs 12 days / 220 delivered / 90 bulk: level 4's 9 / 100 / 40 plus real sends.
        const climbed = levelFor({ activeDays: 3, delivered: 120, bulkDelivered: 50, lastDeliveredBefore: ago(DAY) },
            { now, start: 4, startedAt: ago(5 * DAY) });
        assert.equal(climbed.earned, 5);
        assert.equal(climbed.level, 5);
    });

    it('rests after linking only from level 2', () => {
        const linkedAt = ago(3600_000);
        assert.equal(levelFor({}, { now, linkedAt, start: 2, startedAt: now.toISOString() }).resting.active, true);
        const used = levelFor({}, { now, linkedAt, start: 3, startedAt: now.toISOString() });
        assert.deepEqual([used.resting.active, used.level], [false, 3]);
    });

    it("a ban's rest holds whatever is answered after it", () => {
        // Answered 3/3 (level 7) or skipped (level 11) an hour after a ban: still level 0 until the rest ends.
        const banned = { lastBanAt: ago(3600_000), anchor: ago(3600_000), bans30d: 1 };
        for (const start of [7, 11]) {
            const lv = levelFor(banned, { now, linkedAt: ago(30 * DAY), start, startedAt: ago(60_000) });
            assert.deepEqual([lv.resting.active, lv.level], [true, 0], `start ${start}`);
        }
        const over = levelFor({ ...banned, lastBanAt: ago(25 * 3600_000), anchor: ago(25 * 3600_000) },
            { now, start: 7, startedAt: ago(60_000) });
        assert.deepEqual([over.resting.active, over.level], [false, 7], 'the rest ends on time');
    });

    it('idles from the answer when nothing was delivered yet', () => {
        const fresh = levelFor({}, { now, start: 6, startedAt: ago(DAY) });
        assert.equal(fresh.brakes.some((b) => b.code === 'idle'), false);
        assert.equal(fresh.level, 6);
        const stale = levelFor({}, { now, start: 6, startedAt: ago(10 * DAY) });
        assert.equal(stale.brakes.some((b) => b.code === 'idle'), true);
        assert.equal(stale.level, 5);
    });
});

describe('DailyQuota with the questions wired', () => {
    const qr = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, dailyLimit: 0 };
    const quotaFor = (ledger, start) => applySendingPolicy(
        new DailyQuota({ sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0, ...ledger }) }, qr), {}, null, () => start);

    it('holds bulk until answered', () => {
        const quota = quotaFor({}, null);
        assert.equal(quota.allowance().asked, false);
        assert.equal(quota.remaining(), 0);
        assert.equal(quota.limitOn(), 0);
        const answered = quotaFor({}, { level: 4, answers: { age: 1, usage: 2 }, at: ago(3600_000) });
        assert.equal(answered.allowance().asked, true);
        assert.equal(answered.remaining(), LEVELS[4].dailyLimit);
        assert.deepEqual(answered.allowance().level.start.answers, { age: 1, usage: 2 });
    });

    it('nothing is held where the questions are not wired', () => {
        const quota = new DailyQuota({ sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0 }) }, qr);
        assert.equal(quota.allowance().asked, null);
        assert.equal(quota.remaining(), LEVELS[1].dailyLimit);
    });

    it('a different number or a ban after the answer voids it, and asks again', () => {
        const start = { level: 6, answers: { age: 3, usage: 2 }, at: ago(2 * DAY) };
        for (const ledger of [{ anchor: ago(DAY) }, { lastBanAt: ago(DAY), anchor: ago(DAY) }]) {
            const a = quotaFor(ledger, start).allowance();
            assert.deepEqual([a.asked, a.level.start, a.budgets.bulk.limit], [false, null, 0], JSON.stringify(ledger));
            assert.ok(a.level.earned < 6, 'back to its own history');
        }
        const older = quotaFor({ anchor: ago(3 * DAY) }, start).allowance();
        assert.deepEqual([older.asked, older.level.earned], [true, 6], 'a number that took over before the answer keeps it');
    });

    it('answering again after a ban does not lift its rest', () => {
        const ledger = { lastBanAt: ago(3600_000), anchor: ago(3600_000), bans30d: 1 };
        const quota = quotaFor(ledger, { level: 7, answers: { age: 3, usage: 3 }, at: ago(60_000) });
        assert.deepEqual([quota.allowance().asked, quota.limitOn(), quota.remaining()], [true, 0, 0]);
    });

    it('a plan day caps a skipped start', () => {
        const quota = applySendingPolicy(
            new DailyQuota({ sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0 }) }, qr),
            { 'channels.dailyCap': 250 }, null, () => ({ level: 11, answers: { skipped: true }, at: ago(60_000) }));
        assert.deepEqual([quota.remaining(), quota.allowance().ceiling], [250, 250]);
    });
});

describe('POST/GET /api/channels/:id/start', () => {
    let app;
    let server;
    let base;
    let db;
    let tenant;
    let owner;
    let qrId;
    let skipId;
    let plainId;
    let freshId;

    const call = async (token, method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const consents = () => db.db.prepare("SELECT * FROM safety_consents WHERE kind = 'number_skip_questions'").all();
    const audits = (action) => db.db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY id').all(action);
    const card = async (id) => (await call(owner, 'GET', `/api/channels/${id}`)).body.health;

    before(async () => {
        db = new Database(path.join(tmp, 'start.db'));
        app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        tenant = app.locals.tenancy.createTenant('Start Shop', 'start-shop');
        app.locals.policy.set(`tenant:${tenant.id}`, { 'channels.dailyCap': 250 });
        owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
        const channels = new Channels(db.forTenant(tenant.id));
        plainId = channels.create({ displayName: 'Sandbox', settings: { transport: TRANSPORT_SANDBOX, autoConnect: false } }).id;
        qrId = channels.create({ displayName: 'QR', settings: { transport: TRANSPORT_BAILEYS, autoConnect: false } }).id;
        skipId = channels.create({ displayName: 'QR skip', settings: { transport: TRANSPORT_BAILEYS, autoConnect: false } }).id;
        freshId = channels.create({ displayName: 'QR fresh', settings: { transport: TRANSPORT_BAILEYS, autoConnect: false, linkedAt: new Date().toISOString() } }).id;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('an unanswered QR number holds bulk and says so', async () => {
        const got = await call(owner, 'GET', `/api/channels/${qrId}/start`);
        assert.equal(got.status, 200);
        assert.deepEqual([got.body.asked, got.body.todayLimit, got.body.planLimit], [false, 0, 250]);
        assert.equal(got.body.skipWarning.version, NUMBER_SKIP_VERSION);
        assert.ok(got.body.skipWarning.text.some((line) => /banned/.test(line)));
        assert.deepEqual((await card(qrId)).usage, { todayLimit: 0, sentToday: 0, planLimit: 250, growing: true, asked: false });
    });

    it('the health payload carries no level, ladder, rest or warm-up keys', async () => {
        const health = await card(qrId);
        for (const key of ['level', 'warmup']) assert.equal(key in health, false, key);
        const text = JSON.stringify(health.usage);
        for (const word of ['level', 'resting', 'brakes', 'newChats', 'warmup', 'steps']) assert.equal(text.includes(word), false, word);
        assert.deepEqual(Object.keys((await card(plainId)).usage), ['todayLimit', 'sentToday', 'planLimit', 'growing']);
    });

    it('refuses bad answers, a sandbox number and an agent', async () => {
        for (const body of [{}, { age: 4, usage: 1 }, { age: 1 }]) {
            assert.equal((await call(owner, 'POST', `/api/channels/${qrId}/start`, body)).status, 400, JSON.stringify(body));
        }
        assert.equal((await call(owner, 'POST', `/api/channels/${plainId}/start`, { age: 1, usage: 1 })).status, 400);
        const agent = sessionFor(app, { tenantId: tenant.id, role: 'agent' });
        assert.equal((await call(agent, 'POST', `/api/channels/${qrId}/start`, { age: 3, usage: 3 })).status, 403);
        assert.equal(app.locals.channelOps.startOf(qrId), null);
    });

    it('answers start the number at their level, once', async () => {
        const res = await call(owner, 'POST', `/api/channels/${qrId}/start`, { age: 1, usage: 2 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, { todayLimit: LEVELS[4].dailyLimit, planLimit: 250 });
        assert.deepEqual((await card(qrId)).usage, { todayLimit: 60, sentToday: 0, planLimit: 250, growing: true, asked: true });
        assert.equal((await call(owner, 'GET', `/api/channels/${qrId}/start`)).body.asked, true);
        assert.equal(audits('channel.start').length, 1);
        assert.equal((await call(owner, 'POST', `/api/channels/${qrId}/start`, { age: 3, usage: 3 })).status, 409, 'no re-answering upward');
        assert.equal(consents().length, 0, 'answering is not a consent');
    });

    it('skipping needs accept:true, then records the consent and starts at the plan day', async () => {
        for (const body of [{ skip: true }, { skip: true, accept: 'true' }, { skip: true, accept: false }]) {
            assert.equal((await call(owner, 'POST', `/api/channels/${skipId}/start`, body)).status, 400, JSON.stringify(body));
        }
        assert.equal(consents().length, 0);
        assert.equal(app.locals.channelOps.startOf(skipId), null);

        const res = await call(owner, 'POST', `/api/channels/${skipId}/start`, { skip: true, accept: true });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, { todayLimit: 250, planLimit: 250 });
        const [row] = consents();
        assert.deepEqual([row.tenant_id, row.channel_id, row.text_version], [tenant.id, skipId, NUMBER_SKIP_VERSION]);
        assert.throws(() => db.db.prepare('UPDATE safety_consents SET kind = ? WHERE id = ?').run('x', row.id), /immutable/);
        assert.equal(audits('channel.start_skip').length, 1);
        assert.deepEqual(app.locals.channelOps.startOf(skipId).answers, { skipped: true });
        assert.equal(app.locals.tenancy.currentConsent(tenant.id), null, 'a skip is not the custom-safety consent');
        assert.deepEqual((await card(skipId)).usage, { todayLimit: 250, sentToday: 0, planLimit: 250, growing: false, asked: true });
    });

    it('a just-linked new number shows the day it starts at, and when', async () => {
        const res = await call(owner, 'POST', `/api/channels/${freshId}/start`, { age: 0, usage: 0 });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, { todayLimit: 20, planLimit: 250 });
        const { usage, quality } = await card(freshId);
        assert.deepEqual([usage.todayLimit, usage.planLimit, usage.growing], [20, 250, true]);
        assert.match(usage.blocked, /newly linked number waits before bulk sending\. It starts \w{3} \d\d:\d\d/);
        assert.equal(quality.hints.some((h) => h.code === 'cap_reached'), false, 'waiting is not a used-up cap');
        // The sender still holds bulk until then.
        assert.equal(app.locals.channelOps.startOf(freshId).level, 2);
    });

    it('a typed phone number does not restart a scanned QR number', async () => {
        const channels = new Channels(db.forTenant(tenant.id));
        channels.update(qrId, { providerAccountId: '919876543210' });
        const res = await call(owner, 'PATCH', `/api/channels/${qrId}`, { phoneNumber: '+1 555 000 1111', providerAccountId: '15550001111', displayName: 'QR main' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const row = channels.get(qrId);
        assert.deepEqual([row.numberSince, row.providerAccountId, row.displayName], [null, '919876543210', 'QR main']);
    });

    it('the admin health view keeps the level detail with the answers', async () => {
        const sup = sessionFor(app, { role: 'super_admin' });
        const { channels } = (await call(sup, 'GET', '/api/admin/health-detail')).body;
        const answered = channels.find((c) => c.id === qrId).level;
        assert.deepEqual([answered.level, answered.asked, answered.start.level, answered.start.answers], [4, true, 4, { age: 1, usage: 2 }]);
        assert.deepEqual(channels.find((c) => c.id === skipId).level.start.answers, { skipped: true });
    });

    it('with safety off nothing is held: no cap (null) for the business, not asked for the admin either', async () => {
        const channels = new Channels(db.forTenant(tenant.id));
        const offId = channels.create({ displayName: 'QR off', settings: { transport: TRANSPORT_BAILEYS, autoConnect: false, safetyEnabled: false } }).id;
        assert.deepEqual((await card(offId)).usage, { todayLimit: null, sentToday: 0, planLimit: null, growing: false });
        assert.equal((await call(owner, 'GET', `/api/channels/${offId}/start`)).body.asked, true);
        const sup = sessionFor(app, { role: 'super_admin' });
        const { channels: rows } = (await call(sup, 'GET', '/api/admin/health-detail')).body;
        assert.equal(rows.find((c) => c.id === offId).level.asked, true);
        assert.equal(rows.find((c) => c.id === freshId).level.asked, true);
    });
});

describe('numbers that sent before the questions shipped', () => {
    it('are not held for them: a level-1 start, once, so their history alone sets the level', () => {
        const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-legacy-')), 'legacy.db'));
        db.db.exec(`CREATE TABLE channel_ops (channel_id INTEGER PRIMARY KEY, paused_reason TEXT, paused_by TEXT, paused_at TEXT,
            resumed_at TEXT, quality_rating TEXT, last_seen_at TEXT, level_pin INTEGER, level_pinned_by TEXT, level_pinned_at TEXT)`);
        const channels = new Channels(db.forTenant(1));
        const make = (displayName, transport) => channels.create({ displayName, settings: { transport, autoConnect: false } }).id;
        const [sent, silent, sandbox, later] = [make('Sent', TRANSPORT_BAILEYS), make('Silent', TRANSPORT_BAILEYS), make('Sandbox', TRANSPORT_SANDBOX), make('Later', TRANSPORT_BAILEYS)];
        const deliver = (id) => db.forTenant(1).forChannel(id).insert({ messageId: `m${id}`, recipient: '15550001', message: 'hi', status: 'DELIVERED', createdAt: ago(5 * DAY) });
        deliver(sent);
        deliver(sandbox);
        const ops = createChannelOps({ db, tenancy: null, runtimes: new Map() });
        assert.deepEqual([ops.startOf(sent).level, ops.startOf(sent).answers], [1, { legacy: true }]);
        assert.deepEqual([ops.startOf(silent), ops.startOf(sandbox)], [null, null], 'a QR number that never sent is asked');
        // A number that sends later (replies only, bulk held) is not let through on the next start.
        deliver(later);
        assert.equal(createChannelOps({ db, tenancy: null, runtimes: new Map() }).startOf(later), null);
        db.close();
    });
});
