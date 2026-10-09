/**
 * Security hardening and number protection: response headers, body/upload
 * limits, file sniffing, session idle expiry, login throttles, tenant/channel
 * isolation through headers, and the anti-ban policy keys.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { processOptOut } from '../src/autoreply/optout.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { DailyQuota, SafetyError, bulkWindowOpen, variationError } from '../src/campaign/safety.js';
import { DEFAULTS, POLICY_KEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { fileTypeError } from '../src/security/filetype.js';
import { inlineScriptHashes } from '../src/security/headers.js';
import { safeEqual } from '../src/security/signature.js';
import { SESSION_IDLE_MS } from '../src/tenancy.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-hardening-'));
let app;
let server;
let base;
let db;
let tenancy;
let tenantB;
const tokens = {};

const call = async (token, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            authorization: token ? `Bearer ${token}` : '',
            ...headers,
        },
        body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, headers: res.headers, body: text && json ? JSON.parse(text) : text };
};

const upload = (token, url, bytes, type, name) => {
    const form = new FormData();
    form.set('file', new Blob([bytes], { type }), name);
    return fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
};

before(async () => {
    db = new Database(path.join(tmp, 'h.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    tenancy = app.locals.tenancy;
    tenantB = tenancy.createTenant('Business B', 'biz-b-hard');
    tokens.superAdmin = sessionFor(app, { role: 'super_admin' });
    tokens.ownerA = sessionFor(app, { tenantId: 1, role: 'owner' });
    tokens.ownerB = sessionFor(app, { tenantId: tenantB.id, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('security headers', () => {
    it('sets them on every response and hides the framework', async () => {
        for (const url of ['/api/health', '/api/nope']) {
            const { headers } = await call(null, 'GET', url);
            assert.equal(headers.get('x-content-type-options'), 'nosniff', url);
            assert.equal(headers.get('x-frame-options'), 'DENY');
            assert.ok(headers.get('referrer-policy'));
            assert.equal(headers.get('x-powered-by'), null);
            const csp = headers.get('content-security-policy');
            assert.match(csp, /frame-ancestors 'none'/);
            assert.match(csp, /style-src [^;]*https:\/\/fonts\.googleapis\.com/);
            assert.match(csp, /font-src [^;]*https:\/\/fonts\.gstatic\.com/);
            assert.equal(headers.get('strict-transport-security'), null, 'no HSTS over plain http');
        }
    });

    it('sends HSTS only for https and allows the build inline script by hash', async () => {
        const secure = await call(null, 'GET', '/api/health', undefined, { 'x-forwarded-proto': 'https' });
        assert.match(secure.headers.get('strict-transport-security'), /max-age=\d+/);

        const html = '<script src="main.js" type="module"></script><script>document.title="x"</script>';
        const hashes = inlineScriptHashes(html);
        const expected = crypto.createHash('sha256').update('document.title="x"').digest('base64');
        assert.deepEqual(hashes, [`'sha256-${expected}'`]);
        app.locals.cspScriptHashes = hashes;
        try {
            const { headers } = await call(null, 'GET', '/api/health');
            assert.ok(headers.get('content-security-policy').includes(`script-src 'self' ${hashes[0]}`));
        } finally {
            app.locals.cspScriptHashes = undefined;
        }
    });

    it('compares shared secrets in constant time and still gets the answer right', () => {
        assert.equal(safeEqual('verify-me', 'verify-me'), true);
        assert.equal(safeEqual('verify-me', 'verify-mf'), false);
        assert.equal(safeEqual('', undefined), true);
        assert.equal(safeEqual('a', 'ab'), false);
    });
});

describe('body and upload limits', () => {
    it('refuses an oversized JSON body with 413 JSON', async () => {
        const { status, body } = await call(tokens.ownerA, 'POST', '/api/auto-replies',
            JSON.stringify({ keyword: 'x', replyBody: 'y'.repeat(1.2 * 1024 * 1024) }));
        assert.equal(status, 413);
        assert.ok(Array.isArray(body.errors));
    });

    it('refuses an oversized upload with 413 JSON', async () => {
        const res = await upload(tokens.ownerA, '/api/contacts/import', Buffer.alloc(13 * 1024 * 1024, 'a'), 'text/csv', 'big.csv');
        assert.equal(res.status, 413);
        assert.ok((await res.json()).errors.length);
    });

    it('sniffs file content against the claimed type', () => {
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
        assert.equal(fileTypeError(png, { mimetype: 'image/png', filename: 'a.png' }), null);
        assert.equal(fileTypeError(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { mimetype: 'image/jpeg' }), null);
        assert.equal(fileTypeError(Buffer.from('%PDF-1.7'), { mimetype: 'application/pdf' }), null);
        assert.equal(fileTypeError(Buffer.from('PK\u0003\u0004rest'), { filename: 'a.xlsx' }), null);
        assert.equal(fileTypeError(Buffer.from('name,phone\nA,1\n'), { filename: 'a.csv' }), null);
        assert.match(fileTypeError(Buffer.from('<html>'), { mimetype: 'image/png' }), /does not match/);
        assert.match(fileTypeError(Buffer.from('name,phone'), { filename: 'a.xlsx' }), /does not match/);
        assert.match(fileTypeError(png, { filename: 'a.csv' }), /does not match/, 'binary is not CSV');
        assert.match(fileTypeError(Buffer.from('x'), { filename: 'a.exe' }), /unsupported/);
        assert.equal(fileTypeError(Buffer.from('a,b'), { filename: 'noext', otherwise: 'text' }), null);
    });

    it('rejects a media upload whose bytes are not what it claims', async () => {
        const res = await upload(tokens.ownerA, '/api/media/upload', '<script>alert(1)</script>', 'image/png', 'evil.png');
        assert.equal(res.status, 400);
        assert.match((await res.json()).errors[0], /does not match/);
    });

    it('rejects an import that pretends to be Excel', async () => {
        const res = await upload(tokens.ownerA, '/api/contacts/import', 'name,phone\nA,9198\n',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'fake.xlsx');
        assert.equal(res.status, 400);
        assert.match((await res.json()).errors[0], /does not match/);
    });
});

describe('sessions', () => {
    const lastSeen = (token) => db.db.prepare('SELECT last_seen_at FROM sessions WHERE token_hash = ?')
        .get(crypto.createHash('sha256').update(token).digest('hex'))?.last_seen_at;
    const setSeen = (token, ms) => db.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
        .run(new Date(ms).toISOString(), crypto.createHash('sha256').update(token).digest('hex'));

    it('expires a session left idle, and deletes it', () => {
        const token = sessionFor(app, { tenantId: 1, role: 'agent' });
        assert.ok(tenancy.resolveSession(token));
        setSeen(token, Date.now() - SESSION_IDLE_MS - 60_000);
        assert.equal(tenancy.resolveSession(token), null);
        assert.equal(lastSeen(token), undefined, 'the row is gone');
    });

    it('touches last_seen at most once a minute', () => {
        const token = sessionFor(app, { tenantId: 1, role: 'agent' });
        const recent = Date.now() - 30_000;
        setSeen(token, recent);
        tenancy.resolveSession(token);
        assert.equal(lastSeen(token), new Date(recent).toISOString(), 'not rewritten within a minute');
        setSeen(token, Date.now() - 5 * 60_000);
        tenancy.resolveSession(token);
        assert.ok(Date.now() - Date.parse(lastSeen(token)) < 5000, 'refreshed after a minute');
    });

    it('revokes every session of a user', () => {
        const info = db.db.prepare(`INSERT INTO users (tenant_id, email, name, password_hash, role, created_at)
            VALUES (1, 'revoke@test.dev', '', 'x', 'agent', '2026-01-01T00:00:00Z')`).run();
        const id = Number(info.lastInsertRowid);
        const a = tenancy.createSession(id);
        const b = tenancy.createSession(id);
        assert.equal(tenancy.revokeSessions(id), 2);
        assert.equal(tenancy.resolveSession(a), null);
        assert.equal(tenancy.resolveSession(b), null);
    });
});

describe('isolation through headers', () => {
    it('ignores X-Tenant-Id from anyone but a super admin', async () => {
        const made = await call(tokens.ownerB, 'POST', '/api/auto-replies',
            { keyword: 'only-b', matchType: 'EXACT', replyBody: 'B' });
        assert.equal(made.status, 201);
        const asA = await call(tokens.ownerA, 'GET', '/api/auto-replies', undefined, { 'x-tenant-id': String(tenantB.id) });
        assert.equal(asA.status, 200);
        assert.ok(!asA.body.rules.some((r) => r.keyword === 'only-b'), 'tenant A still sees only A');
        assert.equal((await call(tokens.ownerA, 'PUT', `/api/auto-replies/${made.body.rule.id}`,
            { replyBody: 'hijack' }, { 'x-tenant-id': String(tenantB.id) })).status, 404);
        assert.equal((await call(tokens.ownerA, 'GET', '/api/admin/tenants')).status, 403);
    });

    it('will not route to another tenant\'s channel via X-Channel-Id', async () => {
        const channelB = (await call(tokens.ownerB, 'GET', '/api/channels')).body.channels[0].id;
        const channelA = (await call(tokens.ownerA, 'GET', '/api/channels')).body.channels[0].id;
        assert.notEqual(channelA, channelB);
        for (const url of ['/api/config', '/api/history', '/api/campaign/stats']) {
            const { status } = await call(tokens.ownerA, 'GET', url, undefined, { 'x-channel-id': String(channelB) });
            assert.equal(status, 404, url);
        }
        assert.equal((await call(tokens.ownerA, 'GET', `/api/config?channel=${channelB}`)).status, 404);
        assert.equal((await call(tokens.ownerA, 'GET', `/api/channels/${channelB}`)).status, 404);
    });
});

describe('admin audit trail', () => {
    it('records safety, limits and delete', async () => {
        const doomed = tenancy.createTenant('Doomed', 'doomed-hard');
        assert.equal((await call(tokens.superAdmin, 'PUT', `/api/admin/tenants/${doomed.id}/safety`, { dailyLimit: 100 })).status, 200);
        assert.equal((await call(tokens.superAdmin, 'PUT', `/api/admin/tenants/${doomed.id}/limits`, { maxUsers: 3 })).status, 200);
        assert.equal((await call(tokens.superAdmin, 'DELETE', `/api/admin/tenants/${doomed.id}`)).status, 200);
        const logs = (await call(tokens.superAdmin, 'GET', `/api/admin/audit-logs?tenant=${doomed.id}`)).body.logs;
        const actions = logs.map((l) => l.action);
        for (const action of ['tenant.safety', 'tenant.limits', 'tenant.delete']) assert.ok(actions.includes(action), action);
    });
});

describe('number protection policy', () => {
    it('exposes the new keys to the platform admin with range checks', async () => {
        for (const key of ['warmupDays', 'recipientDailyCap', 'requireVariationAbove', 'quietHoursStart', 'quietHoursEnd']) {
            assert.ok(POLICY_KEYS.includes(key), key);
            assert.equal(DEFAULTS[key], 0, `${key} is off by default`);
        }
        const view = await call(tokens.superAdmin, 'GET', `/api/admin/tenants/${tenantB.id}/safety`);
        assert.equal(view.body.safety.warmupDays, 0);
        assert.equal((await call(tokens.superAdmin, 'PUT', `/api/admin/tenants/${tenantB.id}/safety`, { quietHoursStart: 24 })).status, 400);
        const ok = await call(tokens.superAdmin, 'PUT', `/api/admin/tenants/${tenantB.id}/safety`, { warmupDays: 7, recipientDailyCap: 2 });
        assert.equal(ok.body.safety.warmupDays, 7);
        // Tenants cannot set platform policy through their own config.
        await call(tokens.ownerB, 'PUT', '/api/config', { warmupDays: 0 });
        assert.equal((await call(tokens.ownerB, 'GET', '/api/config')).body.config.warmupDays, 7);
    });

    it('warms a new number up: 30, 60, 120... capped by the daily limit, then the full limit', () => {
        const now = new Date(2026, 0, 10, 12);
        const quotaFor = (daysAgo, config) => new DailyQuota({
            firstSentAt: () => (daysAgo === null ? null : new Date(2026, 0, 10 - daysAgo, 8).toISOString()),
            countSentBetween: () => 0,
        }, { safetyEnabled: true, dailyLimit: 250, warmupDays: 5, ...config });
        assert.equal(quotaFor(null).limitOn(now), 30, 'never sent: day one');
        assert.equal(quotaFor(0).limitOn(now), 30);
        assert.equal(quotaFor(1).limitOn(now), 60);
        assert.equal(quotaFor(2).limitOn(now), 120);
        assert.equal(quotaFor(3).limitOn(now), 240);
        assert.equal(quotaFor(4).limitOn(now), 250, 'never above the daily limit');
        assert.equal(quotaFor(5).limitOn(now), 250, 'warm-up over');
        assert.equal(quotaFor(0, { warmupDays: 0 }).limitOn(now), 250, 'off');
        assert.equal(quotaFor(1, { dailyLimit: 0 }).limitOn(now), 60, 'ramps even with no daily limit');
        assert.equal(quotaFor(0).status(now).limit, 30);
    });

    it('caps bulk messages per recipient per 24h, and counts only bulk', () => {
        const store = new Database(path.join(tmp, 'freq.db'));
        try {
            const at = (status, type, recipient = '911') => store.insert({
                messageId: crypto.randomUUID(), recipient, message: 'm', status, name: '', campaignId: 'c', messageType: type,
            });
            at('SENT', 'campaign');
            at('QUEUED', 'campaign');
            at('FAILED', 'campaign');
            at('SENT', 'auto_reply');
            at('SENT', 'transactional');
            assert.equal(store.bulkCountsSince('2000-01-01T00:00:00+00:00').get('911'), 2);
            assert.ok(store.firstSentAt());

            const manager = new CampaignManager(store, { realDelivery: false }, { ...DEFAULTS, recipientDailyCap: 2 });
            const result = manager.enqueueContacts([{ name: 'A', phone: '911' }, { name: 'B', phone: '912' }], 'Hi {name}');
            assert.equal(result.queued, 1);
            assert.equal(result.skippedFrequency, 1);
            manager.queue.stop();
        } finally {
            store.close();
        }
    });

    it('requires variation on big campaigns when the policy says so', () => {
        const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `9100${i}` }));
        const config = { requireVariationAbove: 2 };
        assert.equal(variationError('Same text', people(2), config), null, 'at the threshold is fine');
        assert.match(variationError('Same text', people(3), config), /spintax|placeholder/);
        assert.equal(variationError('{Hi|Hello} there', people(3), config), null);
        assert.equal(variationError('Hi {name}', people(3), config), null);
        assert.equal(variationError('', people(3).map((p, i) => ({ ...p, extra: { message: `own ${i}` } })), config), null);
        assert.equal(variationError('Same text', people(300), {}), null, 'off by default');

        const manager = new CampaignManager({ sentRecipients: () => new Set() }, null, { ...DEFAULTS, ...config });
        assert.throws(() => manager.enqueueContacts(people(3), 'Same text'), (err) => err instanceof SafetyError && err.status === 400);
    });

    it('refuses an unvaried campaign over HTTP with a clear 400', async () => {
        await call(tokens.superAdmin, 'PUT', '/api/admin/tenants/1/safety', { requireVariationAbove: 1 });
        try {
            assert.equal((await call(tokens.ownerA, 'POST', '/api/connection/connect')).status, 200);
            const contacts = [{ name: 'A', phone: '919811100001' }, { name: 'B', phone: '919811100002' }];
            const refused = await call(tokens.ownerA, 'POST', '/api/campaign/start', { contacts, template: 'Buy now' });
            assert.equal(refused.status, 400);
            assert.match(refused.body.errors[0], /vary the message/);
            const ok = await call(tokens.ownerA, 'POST', '/api/campaign/start', { contacts, template: '{Hi|Hello} {name}' });
            assert.equal(ok.status, 200);
        } finally {
            await call(tokens.superAdmin, 'PUT', '/api/admin/tenants/1/safety', { requireVariationAbove: 0 });
        }
    });

    it('knows quiet hours in the channel timezone, wrapping midnight, reusing the sending window', () => {
        const utc = { timezone: 'UTC', businessHours: null };
        const night = { quietHoursStart: 21, quietHoursEnd: 9 };
        assert.equal(bulkWindowOpen(utc, night, new Date('2026-01-05T22:30:00Z')), false);
        assert.equal(bulkWindowOpen(utc, night, new Date('2026-01-05T03:00:00Z')), false);
        assert.equal(bulkWindowOpen(utc, night, new Date('2026-01-05T12:00:00Z')), true);
        const midday = { quietHoursStart: 13, quietHoursEnd: 15 };
        assert.equal(bulkWindowOpen(utc, midday, new Date('2026-01-05T14:00:00Z')), false);
        assert.equal(bulkWindowOpen(utc, midday, new Date('2026-01-05T16:00:00Z')), true);
        // 16:00 UTC is 21:30 in Kolkata.
        assert.equal(bulkWindowOpen({ timezone: 'Asia/Kolkata' }, night, new Date('2026-01-05T16:00:00Z')), false);
        assert.equal(bulkWindowOpen(utc, {}, new Date('2026-01-05T03:00:00Z')), true, 'off by default');
        // The channel's own window still applies.
        const office = { timezone: 'UTC', businessHours: { start: '09:00', end: '17:00' } };
        assert.equal(bulkWindowOpen(office, {}, new Date('2026-01-05T18:00:00Z')), false);
    });

    it('holds bulk outside the window without failing it, while replies still go', async () => {
        const sent = [];
        const store = {
            insert: (r) => r, updateStatus: () => {}, countSentBetween: () => 0,
        };
        const transport = {
            realDelivery: true,
            isConnected: () => true,
            sendMessage: async (recipient) => { sent.push(recipient); return { status: 'SENT', providerId: `p${sent.length}` }; },
        };
        const manager = new CampaignManager(store, transport, {
            ...DEFAULTS, pacingMode: 'fixed', dailyLimit: 0, rateLimitPerSecond: 50, rateLimitBurst: 10,
        });
        let open = false;
        manager.bulkWindowOpen = () => open;
        manager.holdPollSeconds = 0.02;
        manager.enqueueJob({ recipient: 'bulk', text: 'promo', messageType: 'campaign', priority: 4 });
        manager.enqueueJob({ recipient: 'reply', text: 'hi back', messageType: 'auto_reply', priority: 1 });
        manager.start();
        try {
            await new Promise((r) => setTimeout(r, 250));
            assert.deepEqual(sent, ['reply']);
            assert.equal(manager.statsSnapshot().safety.heldForQuietHours, true);
            assert.equal(manager.stats.failed, 0, 'held, not failed');
            open = true;
            await new Promise((r) => setTimeout(r, 300));
            assert.deepEqual(sent, ['reply', 'bulk']);
        } finally {
            await manager.shutdown();
        }
    });
});

describe('opt-out keywords', () => {
    it('honours the common STOP / START variants', async () => {
        const store = new Database(path.join(tmp, 'optout.db'));
        try {
            for (const body of ['STOP', 'Stop all', 'stop!', 'UNSUBSCRIBE.', 'opt-out', 'Opt out', 'cancel', 'Quit', 'remove me', "don't message"]) {
                assert.equal((await processOptOut(store, null, { sender: '911', body })).action, 'opted_out', body);
                store.removeOptOut('911');
            }
            store.addOptOut('911');
            assert.equal((await processOptOut(store, null, { sender: '911', body: 'Opt-in' })).action, 'opted_in');
            assert.equal((await processOptOut(store, null, { sender: '911', body: 'please stop calling me later' })).handled, false,
                'a sentence that merely contains stop is not an opt-out');
        } finally {
            store.close();
        }
    });
});

describe('login throttles', () => {
    it('locks out one address that sprays many accounts', async () => {
        await tenancy.createUser({ tenantId: 1, email: 'spray-target@test.dev', password: 'correct-horse', role: 'agent' });
        for (let i = 0; i < 20; i += 1) {
            const { status } = await call(null, 'POST', '/api/auth/login', { email: `nobody${i}@test.dev`, password: 'guess' });
            assert.equal(status, 401);
        }
        const { status } = await call(null, 'POST', '/api/auth/login', { email: 'spray-target@test.dev', password: 'correct-horse' });
        assert.equal(status, 429);
    });
});
