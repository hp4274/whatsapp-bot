/** channels.* platform policy: caps, providers, new-number safety, ban guard, admin actions, health, sender rule. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { newNumberSafety, numberCap } from '../src/policy/channelOps.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-pchan-'));
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
let db;
let app;
let server;
let base;
let sup;
let tenant;
let owner;
let other;

const call = async (token, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const policy = (scope, values) => app.locals.policy.set(scope, values);
const sandbox = { transport: TRANSPORT_SANDBOX };
let n = 0;
const record = (tenantId, channelId, status, count) => {
    for (let i = 0; i < count; i += 1) {
        db.forTenant(tenantId).forChannel(channelId).insert({
            messageId: `pc${n++}`, recipient: '15550001111', message: 'hi', status,
            createdAt: stamp(Date.now()), updatedAt: stamp(Date.now()),
        });
    }
};
const rowOf = (id) => db.db.prepare('SELECT * FROM whatsapp_channels WHERE id = ?').get(id);

before(async () => {
    db = new Database(path.join(tmp, 'p.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
    const { tenancy } = app.locals;
    tenant = tenancy.createTenant('Policy Shop', 'policy-shop');
    other = tenancy.createTenant('Other Shop', 'other-shop');
    owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
    await call(owner, 'GET', '/api/channels'); // seeds channel #1
    new Channels(db.forTenant(other.id)).seed({ ...DEFAULTS, ...sandbox });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('number cap and providers', () => {
    it('takes the stricter of the tenant limit and the policy', () => {
        assert.equal(numberCap({}, { 'channels.maxNumbers': 0 }), null);
        assert.equal(numberCap({ maxChannels: 5 }, { 'channels.maxNumbers': 2 }), 2);
        assert.equal(numberCap({ maxChannels: 1 }, { 'channels.maxNumbers': 4 }), 1);
    });

    it('refuses a number past channels.maxNumbers', async () => {
        policy(`tenant:${tenant.id}`, { 'channels.maxNumbers': 2 });
        const second = await call(owner, 'POST', '/api/channels', { displayName: 'Second', settings: sandbox });
        assert.equal(second.status, 201);
        const third = await call(owner, 'POST', '/api/channels', { displayName: 'Third', settings: sandbox });
        assert.equal(third.status, 403);
        assert.match(third.body.errors[0], /allows 2 WhatsApp numbers/);
    });

    it('refuses connecting a number that a lowered cap left over the limit', async () => {
        policy(`tenant:${tenant.id}`, { 'channels.maxNumbers': 1 });
        const list = (await call(owner, 'GET', '/api/channels')).body.channels;
        const newest = list.at(-1);
        const res = await call(owner, 'POST', '/api/connection/connect', null, { 'x-channel-id': String(newest.id) });
        assert.equal(res.status, 403);
        assert.match(res.body.errors[0], /over the limit/);
        policy(`tenant:${tenant.id}`, { 'channels.maxNumbers': null });
    });

    it('refuses a provider the policy disallows, on create and on config', async () => {
        policy(`tenant:${tenant.id}`, { 'channels.allowBaileys': false });
        const qr = await call(owner, 'POST', '/api/channels', { displayName: 'QR', settings: { transport: 'baileys' } });
        assert.equal(qr.status, 403);
        assert.match(qr.body.errors[0], /Baileys/);
        const cfg = await call(owner, 'PUT', '/api/config', { transport: 'baileys' });
        assert.equal(cfg.status, 403);
        assert.match(cfg.body.errors[0], /Baileys/);
        policy(`tenant:${tenant.id}`, { 'channels.allowBaileys': null });
    });
});

describe('safety defaults for new numbers', () => {
    it('lets a tenant start stricter, never looser', () => {
        const s = newNumberSafety({ 'channels.retryLimit': 2 }, { maxRetries: 0, minDelaySeconds: 9 });
        assert.equal(s.maxRetries, 0);
        assert.equal(s.minDelaySeconds, 9);
        assert.equal('warmupDays' in s, false);
    });

    it('never copies the plan day into a number: QR keeps only an asked day, the sandbox the default', () => {
        const plan = { 'channels.dailyCap': 100 };
        assert.equal(newNumberSafety(plan, { transport: 'baileys' }).dailyLimit, 0);
        assert.equal(newNumberSafety(plan, { transport: 'baileys', dailyLimit: 30 }).dailyLimit, 30);
        assert.equal(newNumberSafety(plan, sandbox).dailyLimit, DEFAULTS.dailyLimit);
        assert.equal(newNumberSafety(plan, { ...sandbox, dailyLimit: 3 }).dailyLimit, 3);
    });

    it('a new number starts with the policy values; existing numbers keep theirs', async () => {
        const before = rowOf(1).settings;
        policy(`tenant:${tenant.id}`, {
            'channels.dailyCap': 100, 'channels.minGapSeconds': 6,
            'channels.maxGapSeconds': 20, 'channels.retryLimit': 1,
        });
        const made = await call(owner, 'POST', '/api/channels', { displayName: 'Fresh', settings: sandbox });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        const { settings } = made.body.channel;
        assert.deepEqual(
            [settings.dailyLimit, settings.minDelaySeconds, settings.maxDelaySeconds, settings.maxRetries],
            [DEFAULTS.dailyLimit, 6, 20, 1]);
        const health = (await call(owner, 'GET', `/api/channels/${made.body.channel.id}`)).body.health;
        assert.equal(health.usage.todayLimit, DEFAULTS.dailyLimit, 'the plan day is a QR limit; the sandbox keeps its own');
        assert.equal(rowOf(1).settings, before, 'tenant 1 channel untouched');
        // Back under the cap of 2 for later tests.
        await call(owner, 'DELETE', `/api/channels/${made.body.channel.id}`);
    });
});

describe('ban-risk guard', () => {
    it('pauses a number above the failure rate, records why, and resume resets the window', async () => {
        const id = (await call(owner, 'GET', '/api/channels')).body.channels[1].id;
        policy(`tenant:${tenant.id}`, { 'channels.banGuardFailurePct': 20, 'channels.banGuardMinSample': 10 });
        record(tenant.id, id, 'FAILED', 2);
        record(tenant.id, id, 'SENT', 3);
        assert.deepEqual(await app.locals.channelOps.guard({ force: true }), [], 'under the minimum sample');
        record(tenant.id, id, 'FAILED', 5);
        const paused = await app.locals.channelOps.guard({ force: true });
        assert.equal(paused.length, 1);
        assert.equal(rowOf(id).status, 'disabled');
        const health = (await call(sup, 'GET', '/api/admin/health-detail')).body.channels.find((c) => c.id === id);
        assert.match(health.pausedReason, /70% of 10 messages failed/);
        assert.equal(health.pausedBy, 'ban_guard');
        assert.ok(db.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'channel.ban_guard.pause' AND target = ?").get(String(id)));

        assert.equal((await call(sup, 'POST', `/api/admin/numbers/${id}/resume`)).status, 200);
        assert.equal(rowOf(id).status, 'active');
        assert.deepEqual(await app.locals.channelOps.guard({ force: true }), [], 'old failures do not count after resume');
    });

    it('pauses at the report limit, shows the business why, and lets it resume only a guard pause', async () => {
        const id = (await call(owner, 'GET', '/api/channels')).body.channels[1].id;
        const own = { 'x-channel-id': String(id) };
        const guard = () => app.locals.channelOps.guard({ force: true });
        // Future-dated, so they are newer than any resume made earlier in this second.
        const report = (i, msg = i) => db.db.prepare(`INSERT INTO safety_events (tenant_id, channel_id, kind, phone, message_id, at)
            VALUES (?, ?, 'report', ?, ?, ?)`).run(tenant.id, id, `1555000${i}`, `r${msg}`, stamp(Date.now() + 5000));
        const ops = () => db.db.prepare('SELECT * FROM channel_ops WHERE channel_id = ?').get(id);
        for (let i = 0; i < 9; i += 1) report(i);
        report(0, "again"); // the same person twice is still one reporter
        assert.deepEqual(await guard(), [], '9 people is under the default limit of 10');

        policy(`tenant:${tenant.id}`, { 'channels.banGuardReports': 0 });
        report(9);
        assert.deepEqual(await guard(), [], '0 turns the report limit off');
        policy(`tenant:${tenant.id}`, { 'channels.banGuardReports': null });

        const paused = await guard();
        assert.equal(paused.length, 1);
        assert.match(paused[0].reason, /10 people reported this number as spam in 7 days \(limit 10\)/);
        assert.equal(rowOf(id).status, 'disabled');
        assert.ok(db.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'channel.ban_guard.pause' AND target = ?").get(String(id)));

        // The paused number's page still loads, with the reason; sending stays shut.
        const conn = await call(owner, 'GET', '/api/connection', null, own);
        assert.equal(conn.status, 200);
        assert.deepEqual([conn.body.paused.by, conn.body.paused.reason], ['ban_guard', paused[0].reason]);
        const stream = new AbortController(); // the live stream must open too, or the page never hears the ban
        const events = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${owner}`, ...own }, signal: stream.signal });
        assert.equal(events.status, 200);
        stream.abort();
        assert.equal((await call(owner, 'POST', '/api/connection/connect', null, own)).status, 409);

        const back = await call(owner, 'POST', '/api/connection/resume', null, own);
        assert.equal(back.status, 200, JSON.stringify(back.body));
        assert.equal(rowOf(id).status, 'active');
        assert.equal(ops().paused_by, null);
        assert.equal((await call(owner, 'GET', '/api/connection', null, own)).body.paused, null);

        const causes = (await call(owner, 'GET', '/api/safety/health', null, own)).body.causes;
        assert.deepEqual(causes.map((c) => c.key), ['reports', 'blocks', 'optouts', 'failed', 'volume', 'optin']);
        for (const c of causes) {
            assert.deepEqual(Object.keys(c).sort(), ['hint', 'key', 'label', 'level', 'value']);
            assert.ok(['ok', 'warn', 'bad'].includes(c.level));
        }
        assert.deepEqual([causes[0].value, causes[0].level], ['10 of 10 this week', 'bad']);

        db.db.prepare('UPDATE channel_ops SET resumed_at = ? WHERE channel_id = ?').run(stamp(Date.now() + 10_000), id);
        assert.deepEqual(await guard(), [], 'reports at or before resumed_at are ignored');
        db.db.prepare('DELETE FROM safety_events WHERE channel_id = ?').run(id); // later resumes must not meet them again
    });

    it('does not let the business resume a number the platform admin paused', async () => {
        const id = (await call(owner, 'GET', '/api/channels')).body.channels[1].id;
        const own = { 'x-channel-id': String(id) };
        await call(sup, 'POST', `/api/admin/numbers/${id}/pause`, { reason: 'Review' });
        const conn = await call(owner, 'GET', '/api/connection', null, own);
        assert.equal(conn.body.paused.by, 'admin');
        assert.equal((await call(owner, 'POST', '/api/connection/resume', null, own)).status, 403);
        assert.equal(rowOf(id).status, 'disabled');
        await call(sup, 'POST', `/api/admin/numbers/${id}/resume`);
    });
});

describe('super admin number actions', () => {
    // A second, guard-paused number on the other tenant: the move and the health view count it.
    before(() => {
        const extra = new Channels(db.forTenant(other.id)).create({ displayName: 'Paused', settings: { transport: TRANSPORT_SANDBOX } });
        db.db.prepare("UPDATE whatsapp_channels SET status = 'disabled' WHERE id = ?").run(extra.id);
        db.db.prepare("INSERT INTO channel_ops (channel_id, paused_reason, paused_by, paused_at) VALUES (?, 'Auto-paused: too many failures.', 'ban_guard', ?)")
            .run(extra.id, stamp(Date.now()));
    });

    it('pauses, resumes and force-disconnects, audited on the owning tenant', async () => {
        const id = (await call(owner, 'GET', '/api/channels')).body.channels[1].id;
        assert.equal((await call(owner, 'POST', `/api/admin/numbers/${id}/pause`)).status, 403, 'super admin only');
        assert.equal((await call(sup, 'POST', `/api/admin/numbers/${id}/pause`, { reason: 'Spam complaints' })).status, 200);
        assert.equal(rowOf(id).status, 'disabled');
        assert.equal((await call(sup, 'POST', `/api/admin/numbers/${id}/resume`)).status, 200);
        await call(owner, 'POST', '/api/connection/connect', null, { 'x-channel-id': String(id) });
        assert.equal((await call(sup, 'POST', `/api/admin/numbers/${id}/disconnect`)).status, 200);
        assert.equal(JSON.parse(rowOf(id).settings).autoConnect, false);
        assert.equal(app.locals.runtimes.get(tenant.id).runtimes.has(id), false, 'runtime closed');
        const actions = db.db.prepare('SELECT action FROM audit_logs WHERE tenant_id = ? AND target = ?').all(tenant.id, String(id)).map((r) => r.action);
        for (const a of ['channel.admin.pause', 'channel.admin.resume', 'channel.admin.disconnect']) assert.ok(actions.includes(a), a);
        assert.equal((await call(sup, 'POST', '/api/admin/numbers/99999/pause')).status, 404);
    });

    it('moves a number within the target tenant limits', async () => {
        const id = (await call(owner, 'GET', '/api/channels')).body.channels[1].id;
        app.locals.tenancy.setLimits(other.id, { maxChannels: 2 });
        const full = await call(sup, 'POST', `/api/admin/numbers/${id}/move`, { tenantId: other.id });
        assert.equal(full.status, 409);
        assert.match(full.body.errors[0], /2 of 2/);
        app.locals.tenancy.setLimits(other.id, { maxChannels: 0 });
        const moved = await call(sup, 'POST', `/api/admin/numbers/${id}/move`, { tenantId: other.id });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal(rowOf(id).tenant_id, other.id);
        assert.equal(rowOf(id).is_default, 0);
        const only = (await call(owner, 'GET', '/api/channels')).body.channels;
        assert.equal(only.length, 1);
        const last = await call(sup, 'POST', `/api/admin/numbers/${only[0].id}/move`, { tenantId: other.id });
        assert.equal(last.status, 409, 'cannot strip a tenant of its only number');
    });
});

describe('health view', () => {
    it('shows owner, online/offline with last seen and pause reason per number', async () => {
        const { channels } = (await call(sup, 'GET', '/api/admin/health-detail')).body;
        const paused = channels.find((c) => c.displayName === 'Paused');
        assert.equal(paused.tenantId, other.id);
        assert.equal(paused.online, false);
        assert.equal(paused.lastSeenAt, null);
        assert.match(paused.pausedReason, /failures/);
        const seen = channels.find((c) => c.tenantId === tenant.id);
        db.db.prepare(`INSERT INTO channel_ops (channel_id, last_seen_at) VALUES (?, ?)
            ON CONFLICT (channel_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(seen.id, stamp(Date.now() - 5 * 60_000));
        const again = (await call(sup, 'GET', '/api/admin/health-detail')).body.channels.find((c) => c.id === seen.id);
        assert.equal(again.online, true, 'seen 5 minutes ago, under 30');
        policy(`tenant:${tenant.id}`, { 'channels.offlineAfterMinutes': 2 });
        const late = (await call(sup, 'GET', '/api/admin/health-detail')).body.channels.find((c) => c.id === seen.id);
        assert.equal(late.online, false);
    });
});

describe('sender rule', () => {
    it('round-robin and most-quota pick among active numbers when a send names none', async () => {
        const chans = new Channels(db.forTenant(other.id));
        const pool = chans.list().filter((c) => c.status === 'active');
        assert.ok(pool.length >= 2);
        const picks = Array.from({ length: pool.length + 1 }, () => chans.route({ rule: 'round_robin' }).id);
        assert.equal(new Set(picks).size, pool.length, 'every active number gets a turn');
        assert.equal(picks.at(-1), picks[0], 'then it wraps');
        const left = new Map(pool.map((c, i) => [c.id, i * 10]));
        assert.equal(chans.route({ rule: 'quota', remaining: (c) => left.get(c.id) }).id, pool.at(-1).id);
        assert.equal(chans.route({ rule: 'default' }).id, chans.getDefault().id);
    });

    it('applies the policy rule to unnamed sends over HTTP', async () => {
        const otherOwner = sessionFor(app, { tenantId: other.id, role: 'owner' });
        const ids = (await call(otherOwner, 'GET', '/api/channels')).body.channels.filter((c) => c.status === 'active').map((c) => c.id);
        for (const id of ids) await call(otherOwner, 'POST', '/api/connection/connect', null, { 'x-channel-id': String(id) });
        policy(`tenant:${other.id}`, { 'channels.routing': 'round_robin' });
        for (let i = 0; i < 2; i += 1) {
            const res = await call(otherOwner, 'POST', '/api/messages', { recipient: `+91900000010${i}`, message: 'rr' });
            assert.ok(res.status < 300, JSON.stringify(res.body));
        }
        const used = db.db.prepare("SELECT DISTINCT channel_id FROM messages WHERE tenant_id = ? AND message = 'rr'").all(other.id);
        assert.equal(used.length, 2, 'two sends went out on two numbers');
    });
});
