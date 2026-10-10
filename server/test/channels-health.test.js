/**
 * The channel card's numbers: today's budget, warm-up, delivery quality, and
 * the input checks that keep a bad timezone from breaking the listing.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { channelInputProblems } from '../src/channelUsage.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-chealth-'));
let app;
let server;
let base;
let db;
const tokens = {};
let tenantB;
let tenantC;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            authorization: `Bearer ${token}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};

const stamp = (date) => date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
const hoursAgo = (h) => stamp(new Date(Date.now() - h * 3600 * 1000));

/** Write a message row straight into a channel's history. */
const record = (tenantId, channelId, status, { at = hoursAgo(0), recipient } = {}) =>
    db.forTenant(tenantId).forChannel(channelId).insert({
        messageId: crypto.randomUUID().replace(/-/g, ''),
        recipient: recipient ?? `9190000${String(Math.floor(Math.random() * 1e5)).padStart(5, '0')}`,
        message: 'hello',
        status,
        createdAt: at,
        updatedAt: at,
    });

const listFor = async (token) => (await call(token, 'GET', '/api/channels')).body.channels;

before(async () => {
    db = new Database(path.join(tmp, 'h.db'));
    app = createTestApp({
        db,
        dataDir: tmp,
        config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const tenancy = app.locals.tenancy;
    tenantB = tenancy.createTenant('Warmup Co', 'chealth-b');
    tenantC = tenancy.createTenant('Quality Co', 'chealth-c');
    tokens.a = sessionFor(app, { tenantId: 1, role: 'owner' });
    tokens.b = sessionFor(app, { tenantId: tenantB.id, role: 'owner' });
    tokens.c = sessionFor(app, { tenantId: tenantC.id, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('channel usage', () => {
    it('reports transport, an untouched budget and clean quality for a fresh number', async () => {
        const [channel] = await listFor(tokens.a);
        const { health } = channel;
        assert.equal(health.transport, TRANSPORT_SANDBOX);
        assert.equal(health.usage.sentToday, 0);
        assert.equal(health.usage.dailyLimit, DEFAULTS.dailyLimit);
        assert.equal(health.usage.remaining, DEFAULTS.dailyLimit);
        assert.ok(Date.parse(health.usage.resetsAt) > Date.now(), 'resets in the future');
        assert.equal(health.warmup, null, 'no warm-up block when warmupDays is 0');
        assert.equal(health.quality.level, 'ok');
        assert.deepEqual(health.quality.hints, []);
    });

    it("counts only today's real sends against the cap", async () => {
        const [channel] = await listFor(tokens.a);
        for (let i = 0; i < 5; i += 1) record(1, channel.id, 'SENT');
        record(1, channel.id, 'FAILED');
        record(1, channel.id, 'SANDBOX');
        record(1, channel.id, 'SENT', { at: hoursAgo(72) });

        const [after2] = await listFor(tokens.a);
        assert.equal(after2.health.usage.sentToday, 5, 'failed, sandbox and old sends do not count');
        assert.equal(after2.health.usage.remaining, DEFAULTS.dailyLimit - 5);
        assert.equal(after2.health.quality.sent24h, 5);
        assert.equal(after2.health.quality.failed24h, 1);
    });

    it('scopes counts to the channel, not the whole tenant', async () => {
        const made = await call(tokens.a, 'POST', '/api/channels', {
            displayName: 'Second', settings: { transport: TRANSPORT_SANDBOX },
        });
        assert.equal(made.status, 201);
        const list = await listFor(tokens.a);
        const second = list.find((c) => c.id === made.body.channel.id);
        assert.equal(second.health.usage.sentToday, 0);
    });

    it('also answers on GET /channels/:id', async () => {
        const [channel] = await listFor(tokens.a);
        const one = await call(tokens.a, 'GET', `/api/channels/${channel.id}`);
        assert.equal(one.status, 200);
        assert.equal(one.body.health.usage.sentToday, 5);
        assert.ok(one.body.health.quality);
    });

    it('says when the cap is used up', async () => {
        const made = await call(tokens.a, 'POST', '/api/channels', {
            displayName: 'Tiny cap', settings: { transport: TRANSPORT_SANDBOX, dailyLimit: 3 },
        });
        const id = made.body.channel.id;
        for (let i = 0; i < 3; i += 1) record(1, id, 'SENT');
        const channel = (await listFor(tokens.a)).find((c) => c.id === id);
        assert.equal(channel.health.usage.remaining, 0);
        assert.ok(channel.health.quality.hints.some((h) => h.code === 'cap_reached'));
        assert.equal(channel.health.quality.level, 'warn');
    });
});

describe('platform policy and warm-up', () => {
    it('applies the platform limit over the channel setting and shows warm-up day 1', async () => {
        app.locals.tenancy.setSafety(tenantB.id, { dailyLimit: 40, warmupDays: 5 });
        const [channel] = await listFor(tokens.b);
        const { usage, warmup } = channel.health;
        assert.equal(usage.setByPlatform, true);
        assert.equal(usage.baseLimit, 40, 'the platform value, not the channel default of 250');
        assert.equal(usage.dailyLimit, 30, 'warm-up starts at 30');
        assert.deepEqual(
            { active: warmup.active, day: warmup.day, totalDays: warmup.totalDays, todayCap: warmup.todayCap },
            { active: true, day: 1, totalDays: 5, todayCap: 30 },
        );
    });

    it('ramps with the age of the first real send, capped by the base limit', async () => {
        const [channel] = await listFor(tokens.b);
        record(tenantB.id, channel.id, 'SENT', { at: hoursAgo(48) });
        const [after2] = await listFor(tokens.b);
        assert.equal(after2.health.warmup.day, 3);
        assert.equal(after2.health.warmup.todayCap, 40, '30 * 2^2 = 120, held to the 40 base');
        assert.equal(after2.health.usage.dailyLimit, 40);
    });

    it('marks warm-up finished once the number is old enough', async () => {
        const [channel] = await listFor(tokens.b);
        record(tenantB.id, channel.id, 'SENT', { at: hoursAgo(24 * 10) });
        const [after2] = await listFor(tokens.b);
        assert.equal(after2.health.warmup.active, false);
        assert.equal(after2.health.warmup.day, 5);
        assert.equal(after2.health.usage.dailyLimit, 40);
    });

    it('reports the same budget once the channel runtime is running', async () => {
        const [channel] = await listFor(tokens.b);
        // Any channel-scoped request starts the runtime.
        await call(tokens.b, 'GET', '/api/config');
        const [after2] = await listFor(tokens.b);
        assert.equal(after2.health.running, true);
        assert.equal(after2.health.usage.baseLimit, channel.health.usage.baseLimit);
        assert.equal(after2.health.usage.dailyLimit, channel.health.usage.dailyLimit);
    });
});

describe('quality hints', () => {
    it('flags a high failure rate in the last 24h', async () => {
        const [channel] = await listFor(tokens.c);
        for (let i = 0; i < 8; i += 1) record(tenantC.id, channel.id, 'FAILED');
        for (let i = 0; i < 4; i += 1) record(tenantC.id, channel.id, 'DELIVERED');
        const [after2] = await listFor(tokens.c);
        const { quality } = after2.health;
        assert.equal(quality.level, 'bad');
        const hint = quality.hints.find((h) => h.code === 'failures_24h');
        assert.ok(hint, 'failure hint present');
        assert.match(hint.message, /High failure rate in last 24h \(67%\)/);
        assert.ok(Math.abs(quality.failureRate24h - 8 / 12) < 1e-9);
    });

    it('counts opt-outs only from people this channel messaged', async () => {
        const [channel] = await listFor(tokens.c);
        const scoped = db.forTenant(tenantC.id);
        for (const phone of ['919811100001', '919811100002', '919811100003']) {
            record(tenantC.id, channel.id, 'SENT', { recipient: phone });
            scoped.addOptOut(phone);
        }
        scoped.addOptOut('919899999999'); // never messaged by this channel

        const [after2] = await listFor(tokens.c);
        const { quality } = after2.health;
        assert.equal(quality.optOuts7d, 3);
        assert.ok(quality.hints.some((h) => h.code === 'optouts_7d' && h.level === 'bad'),
            '3 opt-outs over 7 real sends is well past 5%');
    });

    it('ignores sandbox sends and older history for the 24h window', async () => {
        const made = await call(tokens.c, 'POST', '/api/channels', {
            displayName: 'Old failures', settings: { transport: TRANSPORT_SANDBOX },
        });
        const id = made.body.channel.id;
        for (let i = 0; i < 20; i += 1) record(tenantC.id, id, 'SANDBOX');
        for (let i = 0; i < 12; i += 1) record(tenantC.id, id, 'FAILED', { at: hoursAgo(24 * 30) });
        const channel = (await listFor(tokens.c)).find((c) => c.id === id);
        assert.equal(channel.health.quality.level, 'ok');
        assert.equal(channel.health.quality.failed7d, 0);
    });
});

describe('channel input checks', () => {
    it('rejects an unknown timezone instead of storing it', async () => {
        const [channel] = await listFor(tokens.a);
        const bad = await call(tokens.a, 'PATCH', `/api/channels/${channel.id}`, { timezone: 'Mars/Olympus' });
        assert.equal(bad.status, 400);
        assert.match(bad.body.errors[0], /unknown timezone/);
        assert.equal((await call(tokens.a, 'GET', '/api/channels')).status, 200, 'the listing still works');
    });

    it('rejects malformed or inverted sending windows', async () => {
        const [channel] = await listFor(tokens.a);
        const url = `/api/channels/${channel.id}`;
        assert.equal((await call(tokens.a, 'PATCH', url, { businessHours: { start: '9am', end: '17:00' } })).status, 400);
        assert.equal((await call(tokens.a, 'PATCH', url, { businessHours: { start: '18:00', end: '09:00' } })).status, 400);
        assert.equal((await call(tokens.a, 'PATCH', url,
            { businessHours: { start: '09:00', end: '17:00', days: ['funday'] } })).status, 400);
    });

    it('accepts a weekday window with a real timezone and reports whether it is open', async () => {
        const [channel] = await listFor(tokens.a);
        const ok = await call(tokens.a, 'PATCH', `/api/channels/${channel.id}`, {
            timezone: 'Asia/Kolkata',
            businessHours: { start: '00:00', end: '23:59', days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
        });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.channel.timezone, 'Asia/Kolkata');
        const [after2] = await listFor(tokens.a);
        assert.equal(typeof after2.health.withinSendingWindow, 'boolean');
        await call(tokens.a, 'PATCH', `/api/channels/${channel.id}`, { businessHours: null, timezone: 'UTC' });
    });

    it('rejects an empty name on rename and on create', async () => {
        const [channel] = await listFor(tokens.a);
        assert.equal((await call(tokens.a, 'PATCH', `/api/channels/${channel.id}`, { displayName: '   ' })).status, 400);
        assert.equal((await call(tokens.a, 'POST', '/api/channels', { displayName: '' })).status, 400);
    });

    it('has a pure checker usable without HTTP', () => {
        assert.deepEqual(channelInputProblems({ displayName: 'Sales', phoneNumber: '+91 98765 43210', timezone: 'UTC' }), []);
        assert.equal(channelInputProblems({ phoneNumber: 'call me' }).length, 1);
        assert.deepEqual(channelInputProblems({ businessHours: null }), []);
    });
});
