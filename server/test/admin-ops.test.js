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
        for (const url of ['/api/admin/plans', '/api/admin/usage-summary', '/api/admin/health-detail', '/api/admin/audit-logs', '/api/admin/shadow-review']) {
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

        // A quick send is stored as campaign_id 'transactional': it is not a campaign.
        db.forTenant(tenantB.id).forChannel(ch.b2.id).insert({
            messageId: 'quick-1', recipient: '15550002222', message: 'hi', status: 'SANDBOX', campaignId: 'transactional',
            createdAt: stamp(Date.now()), updatedAt: stamp(Date.now()),
        });
        const again = (await call(sup, '/api/admin/usage-summary?days=14')).body.tenants;
        assert.equal(again.find((t) => t.tenantId === tenantB.id).campaigns, 0, 'quick sends are not counted as campaigns');
        assert.equal(again.find((t) => t.tenantId === 1).campaigns, 1);
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
        assert.match(csv.body, /^id,createdAt,tenantId,tenantName,userEmail,Summary,severity,verb,action,target,ip,requestId,detail/);
        assert.match(csv.body, /"'=SUM\(A1\)"/, 'formula cells are defused');
        assert.match(csv.body, /"Deleted business Beta Shop"/, 'the sentence is in the sheet');
        assert.equal(auditCsv([{ id: 1, detail: 'say "hi"' }]).split('\r\n')[1], '"1","","","","","","","","","","","","say ""hi"""');
    });

    it('audit-logs: every row reads as a sentence with severity, category and actor', async () => {
        const { logs } = (await call(sup, '/api/admin/audit-logs')).body;
        const del = logs.find((l) => l.action === 'tenant.delete');
        assert.equal(del.summary, 'Deleted business Beta Shop');
        assert.equal(del.severity, 'danger');
        assert.equal(del.category, 'business');
        assert.equal(del.actor, 'System');
        assert.equal(del.tenantName, 'Beta Shop');
        const created = logs.find((l) => l.action === 'channel.create');
        assert.equal(created.summary, 'Added number "=SUM(A1)"', 'the raw detail is used as the number name');
        assert.equal(logs.find((l) => l.action === 'auth.login').verb, 'other');
    });
});

describe('audit records: ip, request id, named rows and tenant scope', () => {
    const send = async (token, method, url, body) => {
        const res = await fetch(base + url, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': `req-${method}-${url}` },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const rowsFor = (requestId) => app.locals.tenancy.db.prepare('SELECT * FROM audit_logs WHERE request_id = ?').all(requestId);

    it('a named row carries the ip and request id, and replaces the generic "METHOD /path" row', async () => {
        const res = await send(owner, 'POST', '/api/channels', { displayName: 'Gamma line', settings: { transport: TRANSPORT_SANDBOX } });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const rows = rowsFor('req-POST-/api/channels');
        assert.deepEqual(rows.map((r) => r.action), ['channel.create'], 'no second "POST /channels" row');
        assert.match(rows[0].ip, /127\.0\.0\.1/);
        const { logs } = (await call(sup, '/api/admin/audit-logs?requestId=req-POST-%2Fapi%2Fchannels')).body;
        assert.equal(logs.length, 1);
        assert.equal(logs[0].summary, 'Added number "Gamma line"');
        assert.equal(logs[0].requestId, 'req-POST-/api/channels');
        assert.equal(typeof logs[0].actor, 'object');
    });

    it('a write without a named row still gets a readable generic row', async () => {
        const res = await send(owner, 'POST', '/api/contacts', { phone: '+15550009999', name: 'Zed' });
        assert.ok(res.status < 400, JSON.stringify(res.body));
        const [row] = rowsFor('req-POST-/api/contacts');
        assert.equal(row.action, 'POST /contacts');
        const { logs } = (await call(sup, '/api/admin/audit-logs?requestId=req-POST-%2Fapi%2Fcontacts')).body;
        assert.equal(logs[0].summary, 'Created a contact');
        assert.equal(logs[0].verb, 'create');
    });

    it('policy.change stores from/to under the tenant it is about; tenant.create lands in the new tenant', async () => {
        const url = `/api/admin/policy/tenant:${tenantB.id}`;
        assert.equal((await send(sup, 'PUT', url, { values: { 'bulk.killSwitch': true } })).status, 200);
        const [on] = rowsFor(`req-PUT-${url}`);
        assert.equal(on.tenant_id, tenantB.id);
        assert.deepEqual(JSON.parse(on.detail), { 'bulk.killSwitch': { from: null, to: true } });
        let { logs } = (await call(sup, `/api/admin/audit-logs?requestId=${encodeURIComponent(`req-PUT-${url}`)}`)).body;
        assert.match(logs[0].summary, /kill switch ON for Beta Shop/);
        assert.equal(logs[0].severity, 'danger');
        app.locals.tenancy.db.prepare('DELETE FROM audit_logs WHERE request_id = ?').run(`req-PUT-${url}`);
        assert.equal((await send(sup, 'PUT', url, { values: { 'bulk.killSwitch': null } })).status, 200);
        ({ logs } = (await call(sup, `/api/admin/audit-logs?requestId=${encodeURIComponent(`req-PUT-${url}`)}`)).body);
        assert.deepEqual(JSON.parse(logs[0].detail), { 'bulk.killSwitch': { from: true, to: null } });
        assert.match(logs[0].summary, /kill switch off/);

        const made = await send(sup, 'POST', '/api/admin/tenants', {
            name: 'Delta Co', slug: 'delta-co', owner: { email: 'delta@example.test', name: 'Dee', password: 'Delta-Pass-2026!' },
        });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        const [row] = rowsFor('req-POST-/api/admin/tenants');
        assert.equal(row.tenant_id, made.body.tenant.id);
    });

    it('verbs follow the action name: disconnect and cancel are changes, not creates', async () => {
        const { auditVerb } = await import('../src/observability/auditText.js');
        assert.equal(auditVerb('POST /connection/disconnect'), 'change');
        assert.equal(auditVerb('POST /campaigns/2/cancel'), 'change');
        assert.equal(auditVerb('POST /campaigns'), 'create');
        assert.equal(auditVerb('DELETE /contacts/4'), 'remove');
        assert.equal(auditVerb('campaign.done'), 'other');
        assert.equal(auditVerb('tenant.sessions.revoke'), 'remove');
        const others = (await call(sup, '/api/admin/audit-logs?verb=other')).body.logs;
        assert.ok(others.length && others.every((l) => l.verb === 'other'));
    });
});

describe('backend logs', () => {
    it('are super admin only, filter by level and request id, and read as sentences', async () => {
        assert.equal((await call(owner, '/api/admin/logs')).status, 403);
        await fetch(`${base}/api/admin/does-not-exist?token=s3cret-value`, { headers: { authorization: `Bearer ${sup}`, 'x-request-id': 'log-probe-1' } });
        const { lines } = (await call(sup, '/api/admin/logs?requestId=log-probe-1')).body;
        assert.equal(lines.length, 1);
        assert.match(lines[0].summary, /^GET \/api\/admin\/does-not-exist\?token=\[redacted\] was refused with 4\d\d in /);
        assert.ok(!JSON.stringify(lines).includes('s3cret-value'), 'a token in the query never reaches the buffer');
        console.error('[sweep] tenant 7 failed for +91 98765 43210 token=abc123');
        const warn = (await call(sup, '/api/admin/logs?level=warn&q=sweep')).body.lines;
        assert.equal(warn[0].level, 'error');
        assert.equal(warn[0].severity, 'danger');
        assert.match(warn[0].summary, /…3210 token=\[redacted\]/);
        assert.ok((await call(sup, '/api/admin/logs?level=error')).body.lines.every((l) => l.level === 'error'));
    });
});

describe('live logs topic', () => {
    it('publishes `logs` after warn/error lines only, coalesced, and stops when told', async () => {
        const { publishWarnings } = await import('../src/observability/logBuffer.js');
        const { createLogger } = await import('../src/observability/logger.js');
        const published = [];
        const stop = publishWarnings({ publish: (topic) => published.push(topic) });
        const log = createLogger({ component: 'test' });
        log.info('quiet line');
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(published.length, 0, 'info lines are not pushed');
        log.warn('first');
        log.error('second');
        await new Promise((r) => setTimeout(r, 50));
        assert.deepEqual(published, ['logs'], 'two lines, one publish');
        stop();
        log.error('after stop');
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(published.length, 1);
    });
});

describe('audit text', () => {
    it('names campaigns, numbers and businesses, and falls back for unknown actions', async () => {
        const { describeAudit } = await import('../src/observability/auditText.js');
        const names = { tenant: () => 'Acme', channel: () => 'Sales' };
        assert.equal(describeAudit({ action: 'campaign.done', target: 5, detail: { name: 'Diwali offer', sent: 480, failed: 3, total: 483 } }).summary,
            'Campaign "Diwali offer" finished: 480 sent, 3 failed');
        assert.equal(describeAudit({ action: 'channel.admin.pause', target: 7, tenantId: 2, detail: 'spam' }, names).summary,
            'Super admin paused number "Sales" (Acme): spam');
        assert.equal(describeAudit({ action: 'auth.login_failed', detail: { email: 'a@b.com', ip: '1.2.3.4' } }).summary,
            'Login failed for a@b.com from 1.2.3.4');
        assert.equal(describeAudit({ action: 'POST /campaigns/2/pause' }).summary, 'Paused campaign #2');
        assert.equal(describeAudit({ action: 'PUT /contacts/9' }).summary, 'Updated contact #9');
        assert.equal(describeAudit({ action: 'widget.frobnicate' }).summary, 'Widget frobnicate');
        assert.equal(describeAudit({ action: 'ops.alert', tenantId: 2, target: 'ban:channel-7',
            detail: { kind: 'ban', channelId: 7, text: 'WhatsApp banned this number.' } }, names).severity, 'danger');
    });

    it('shadow-review: every number\'s shadow triggers per kind, with the pause they would have caused', async () => {
        const now = Date.now();
        const shadow = (channelId, code, at, until) => db.db.prepare(
            "INSERT INTO safety_events (tenant_id, channel_id, kind, phone, message_id, at) VALUES (?, ?, 'shadow', ?, ?, ?)",
        ).run(tenantB.id, channelId, code, until, stamp(at));
        shadow(ch.b1.id, 'delivery', now - 3 * 3_600_000, new Date(now + 5 * 3_600_000).toISOString());
        shadow(ch.b1.id, 'delivery', now - 30 * 3_600_000, new Date(now - 22 * 3_600_000).toISOString());
        shadow(ch.b1.id, 'level:demote_delivery', now - 3_600_000, 'key-1');
        shadow(ch.b1.id, 'stuck', now - 9 * 86_400_000, new Date(now).toISOString()); // older than 7 days

        const { body } = await call(sup, '/api/admin/shadow-review');
        const rows = body.rows.filter((r) => r.channelId === ch.b1.id);
        assert.deepEqual(rows.map((r) => [r.kind, r.count, r.pauseHours]), [['delivery', 2, 16], ['level:demote_delivery', 1, 0]]);
        assert.equal(rows[0].tenantName, 'Beta Shop');
    });
});
