/** Super admin ops pages: plans, usage summary, channel health detail, audit search. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { auditCsv } from '../src/adminOps.js';
import { closeApp } from '../src/app.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-adminops-'));
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
let db;
let app;
let server;
let base;
let sup;
let owner;
let tenantB;
const ch = {};

const call = async (token, url) => {
    const res = await fetch(base + url, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* csv */ }
    return { status: res.status, body, type: res.headers.get('content-type') ?? '' };
};

before(async () => {
    db = new Database(path.join(tmp, 'ops.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });

    const { tenancy } = app.locals;
    tenantB = tenancy.createTenant('Beta Shop', 'beta-shop');
    tenancy.setLimits(tenantB.id, { maxChannels: 3, maxUsers: 5 });
    const settings = { transport: TRANSPORT_SANDBOX };
    const chA = new Channels(db.forTenant(1));
    ch.a1 = chA.list()[0] ?? chA.create({ displayName: 'Alpha main', settings });
    const chB = new Channels(db.forTenant(tenantB.id));
    ch.b1 = chB.create({ displayName: 'Beta one', settings });
    ch.b2 = chB.create({ displayName: 'Beta two', settings });
    chB.update(ch.b2.id, { status: 'disabled' });

    const now = Date.now();
    let n = 0;
    const put = (tenantId, channelId, status, extra = {}) => db.forTenant(tenantId).forChannel(channelId).insert({
        messageId: `m${n++}`, recipient: '15550001111', message: 'hi', status,
        createdAt: stamp(now), updatedAt: stamp(now), ...extra,
    });
    for (let i = 0; i < 3; i++) put(1, ch.a1.id, 'SENT', { campaignId: 'camp-1' });
    put(1, ch.a1.id, 'READ', { campaignId: 'camp-1' });
    put(1, ch.a1.id, 'FAILED', { campaignId: 'camp-1' });
    put(1, ch.a1.id, 'FAILED', { campaignId: 'camp-1' });
    put(1, ch.a1.id, 'SENT', { messageType: 'auto_reply' });
    put(1, ch.a1.id, 'DELIVERED', { createdAt: stamp(now - 10 * 86_400_000), updatedAt: stamp(now - 10 * 86_400_000) });
    put(tenantB.id, ch.b1.id, 'QUEUED');

    tenancy.audit({ tenantId: 1, userId: null, action: 'channel.create', target: '1', detail: '=SUM(A1)' });
    tenancy.audit({ tenantId: tenantB.id, userId: null, action: 'tenant.limits', target: String(tenantB.id), detail: '{"maxChannels":3}' });
    tenancy.audit({ tenantId: tenantB.id, userId: null, action: 'tenant.delete', target: 'x' });
    tenancy.audit({ tenantId: null, userId: null, action: 'auth.login' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('admin ops endpoints', () => {
    it('are super admin only', async () => {
        for (const url of ['/api/admin/plans', '/api/admin/usage-summary', '/api/admin/health-detail', '/api/admin/audit-logs']) {
            assert.equal((await call(owner, url)).status, 403, url);
            assert.equal((await call(sup, url)).status, 200, url);
        }
    });

    it('plans: limits next to what each tenant uses', async () => {
        const { body } = await call(sup, '/api/admin/plans');
        assert.ok(Array.isArray(body.services) && body.services.length);
        const b = body.tenants.find((t) => t.tenantId === tenantB.id);
        assert.equal(b.limits.maxChannels, 3);
        assert.equal(b.limits.maxUsers, 5);
        assert.deepEqual(b.usage, { channels: 2, users: 0, templates: 0 });
        assert.equal(typeof b.safety.dailyLimit, 'number');
        const a = body.tenants.find((t) => t.tenantId === 1);
        assert.equal(a.usage.channels, new Channels(db.forTenant(1)).list().length);
    });

    it('usage-summary: per tenant buckets, series and isolation', async () => {
        const { body } = await call(sup, '/api/admin/usage-summary?days=14');
        assert.equal(body.days.length, 14);
        const a = body.tenants.find((t) => t.tenantId === 1);
        const b = body.tenants.find((t) => t.tenantId === tenantB.id);
        assert.deepEqual(a.today, { sent: 5, delivered: 1, read: 1, failed: 2, queued: 0, sandbox: 0, total: 7 });
        assert.equal(a.d7.total, 7);
        assert.equal(a.d30.total, 8, 'the 10-day-old message is in 30d only');
        assert.equal(a.daily.at(-1), 7);
        assert.equal(a.daily.at(-11), 1);
        assert.equal(a.dailyFailed.at(-1), 2);
        assert.equal(a.campaigns, 1);
        assert.equal(a.autoReplies, 1);
        assert.deepEqual(b.today, { sent: 0, delivered: 0, read: 0, failed: 0, queued: 1, sandbox: 0, total: 1 });
        assert.equal(body.totals.today.total, 8);
        assert.equal(body.tenants[0].tenantId, 1, 'busiest first');
    });

    it('health-detail: every number with its own tenant, problems first', async () => {
        const { body } = await call(sup, '/api/admin/health-detail');
        const byId = new Map(body.channels.map((c) => [c.id, c]));
        const a1 = byId.get(ch.a1.id);
        const b1 = byId.get(ch.b1.id);
        const b2 = byId.get(ch.b2.id);
        assert.equal(a1.tenantId, 1);
        assert.equal(b1.tenantId, tenantB.id);
        assert.equal(b2.tenantId, tenantB.id);
        assert.deepEqual(a1.lastHour, { total: 7, failed: 2, failureRate: 28.6 });
        assert.equal(a1.severity, 'bad');
        assert.ok(a1.lastSentAt);
        assert.equal(b1.waiting, 1);
        assert.deepEqual(b1.lastHour, { total: 0, failed: 0, failureRate: 0 }, "A's failures do not leak into B");
        assert.equal(b2.state, 'disabled');
        assert.equal(b2.severity, 'off');
        assert.equal(body.channels[0].severity, 'bad');
        assert.equal(body.channels.at(-1).severity, 'off');
        assert.equal(typeof a1.quota.limit, 'number');
        for (const c of body.channels) assert.ok(['bad', 'warn', 'ok', 'off'].includes(c.severity));
    });

    it('audit-logs: filters, keyset pages and CSV', async () => {
        const all = (await call(sup, '/api/admin/audit-logs')).body;
        assert.ok(all.logs.length >= 4);
        assert.ok(Array.isArray(all.users));

        const creates = (await call(sup, '/api/admin/audit-logs?verb=create')).body.logs;
        assert.ok(creates.length && creates.every((l) => l.verb === 'create'));
        const removes = (await call(sup, '/api/admin/audit-logs?verb=remove')).body.logs;
        assert.ok(removes.some((l) => l.action === 'tenant.delete'));
        assert.ok(removes.every((l) => l.verb === 'remove'));

        const onlyB = (await call(sup, `/api/admin/audit-logs?tenant=${tenantB.id}`)).body.logs;
        assert.ok(onlyB.length >= 2 && onlyB.every((l) => l.tenantId === tenantB.id));
        const platform = (await call(sup, '/api/admin/audit-logs?tenant=platform')).body.logs;
        assert.ok(platform.every((l) => l.tenantId === null));

        const p1 = (await call(sup, '/api/admin/audit-logs?limit=2')).body;
        assert.equal(p1.logs.length, 2);
        assert.ok(p1.nextBefore);
        const p2 = (await call(sup, `/api/admin/audit-logs?limit=2&before=${p1.nextBefore}`)).body;
        assert.ok(p2.logs.every((l) => l.id < p1.nextBefore));

        const today = new Date().toISOString().slice(0, 10);
        assert.ok((await call(sup, `/api/admin/audit-logs?from=${today}&to=${today}`)).body.logs.length >= 4);
        assert.equal((await call(sup, '/api/admin/audit-logs?to=2000-01-01')).body.logs.length, 0);
        assert.equal((await call(sup, '/api/admin/audit-logs?q=maxChannels')).body.logs.length, 1);
        assert.equal((await call(sup, '/api/admin/audit-logs?q=%25')).body.logs.length, 0, 'LIKE wildcards are literal');

        const csv = await call(sup, '/api/admin/audit-logs?format=csv');
        assert.match(csv.type, /text\/csv/);
        assert.match(csv.body, /^id,createdAt,tenantId,userEmail,verb,action,target,detail/);
        assert.match(csv.body, /"'=SUM\(A1\)"/, 'formula cells are defused');
        assert.equal(auditCsv([{ id: 1, detail: 'say "hi"' }]).split('\r\n')[1], '"1","","","","","","","say ""hi"""');
    });
});
