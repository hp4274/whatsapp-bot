/** Per-tenant security policy (policy/security.js): rate limits, IP allow-list, idle timeout, revoke buttons. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { BillingStore } from '../src/billing/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { ApiKeyStore } from '../src/publicapi/keys.js';
import { ipAllowed, ipEntryError } from '../src/security/ip.js';
import { rateLimit } from '../src/security/signature.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-policy-security-'));

describe('ipAllowed', () => {
    it('matches exact addresses and IPv4 CIDR blocks, and an empty list allows all', () => {
        assert.equal(ipAllowed([], '1.2.3.4'), true);
        assert.equal(ipAllowed(undefined, '1.2.3.4'), true);
        assert.equal(ipAllowed(['1.2.3.4'], '1.2.3.4'), true);
        assert.equal(ipAllowed(['1.2.3.4'], '::ffff:1.2.3.4'), true, 'dual-stack prefix is stripped');
        assert.equal(ipAllowed(['1.2.3.4'], '1.2.3.5'), false);
        assert.equal(ipAllowed(['10.0.0.0/24'], '10.0.0.255'), true);
        assert.equal(ipAllowed(['10.0.0.0/24'], '10.0.1.0'), false);
        assert.equal(ipAllowed(['200.0.0.0/1'], '255.255.255.255'), true, 'no signed 32-bit overflow');
        assert.equal(ipAllowed(['0.0.0.0/0'], '8.8.8.8'), true);
        assert.equal(ipAllowed(['::1'], '::1'), true);
        assert.equal(ipAllowed(['2001:0DB8:0:0::1'], '2001:db8::1'), true, 'IPv6 compared canonically');
        assert.equal(ipAllowed(['2001:db8::1'], '2001:db8:0:0:0:0:0:1'), true);
        assert.equal(ipAllowed(['2001:db8::1'], '2001:db8::2'), false);
        assert.equal(ipAllowed(['10.0.0.0/24'], '::1'), false);
    });

    it('names an entry it cannot use', () => {
        assert.equal(ipEntryError('10.0.0.0/24'), null);
        assert.equal(ipEntryError('2001:db8::1'), null);
        assert.match(ipEntryError('example.com'), /not an IP/);
        assert.match(ipEntryError('10.0.0.0/33'), /CIDR/);
    });
});

describe('rateLimit limitsFor', () => {
    it('uses the per-request limits and retunes a live bucket', () => {
        let t = 0;
        let limits = { ratePerSecond: 1, burst: 1 };
        const mw = rateLimit({ keyFor: () => 'k', limitsFor: () => limits, now: () => t });
        const hit = () => {
            let status = 200;
            mw({}, { setHeader() {}, status(s) { status = s; return { json() {} }; } }, () => {});
            return status;
        };
        assert.equal(hit(), 200);
        assert.equal(hit(), 429, 'burst of 1');
        limits = { ratePerSecond: 100, burst: 5 };
        assert.equal(hit(), 429, 'the bucket is not refilled retroactively at the new rate');
        t += 0.05; // 5 tokens at the new rate
        assert.equal(hit(), 200);
        assert.equal(hit(), 200);
    });
});

describe('security policy over HTTP', () => {
    let app;
    let server;
    let base;
    let db;
    let sup;
    const call = async (token, method, url, body) => {
        const res = await fetch(base + url, {
            method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    const setPolicy = (tenantId, values) => call(sup, 'PUT', `/api/admin/policy/tenant:${tenantId}`, { values });
    let seq = 0;
    /** A fresh tenant on a plan with API requests, so no test shares another's buckets. */
    const tenant = () => {
        const id = app.locals.tenancy.createTenant(`Sec ${seq}`, `sec-${seq++}`).id;
        new BillingStore(db.forTenant(id)).subscribe(id, 'business');
        return id;
    };
    const keyFor = (tenantId, scopes = ['contacts:read']) => new ApiKeyStore(db.forTenant(tenantId)).createKey({ scopes }).key;
    const v1 = (key, method = 'GET', url = '/api/v1/contacts/9876500001', body) => fetch(base + url, {
        method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
    });

    before(async () => {
        db = new Database(path.join(tmp, 'app.db'));
        app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        sup = sessionFor(app, { role: 'super_admin' });
    });
    after(async () => {
        await closeApp(app);
        server.close();
    });

    it('rate-limits /v1 per key with 429, and does not count the refused call', async () => {
        const id = tenant();
        assert.equal((await setPolicy(id, { 'security.publicApiRatePerSecond': 1, 'security.publicApiBurst': 2 })).status, 200);
        const key = keyFor(id);
        assert.equal((await v1(key)).status, 404);
        assert.equal((await v1(key)).status, 404);
        const over = await v1(key);
        assert.equal(over.status, 429);
        assert.ok(over.headers.get('retry-after'));
        assert.equal((await v1(keyFor(id))).status, 404, 'another key has its own bucket');
        assert.equal(new BillingStore(db.forTenant(id)).usage().metrics.find((m) => m.metric === 'api_requests').used, 3);
    });

    it('refuses /v1 from an address outside the allow-list with 403', async () => {
        const id = tenant();
        const key = keyFor(id);
        assert.equal((await setPolicy(id, { 'security.ipAllowList': ['bad entry'] })).status, 400);
        await setPolicy(id, { 'security.ipAllowList': ['10.9.9.9'] });
        const refused = await v1(key);
        assert.equal(refused.status, 403);
        assert.equal((await refused.json()).error, 'ip_not_allowed');
        await setPolicy(id, { 'security.ipAllowList': ['10.9.9.9', '127.0.0.0/8', '::1'] });
        assert.equal((await v1(key)).status, 404);
        await setPolicy(id, { 'security.ipAllowList': null });
        assert.equal((await v1(key)).status, 404);
    });

    it('refuses /v1 with a key older than the max age, even one from before the policy', async () => {
        const id = tenant();
        const key = keyFor(id);
        db.db.prepare("UPDATE api_keys SET created_at = '2000-01-01T00:00:00Z' WHERE tenant_id = ?").run(id);
        assert.equal((await v1(key)).status, 404, 'no max age: still works');
        await setPolicy(id, { 'security.apiKeyMaxAgeDays': 30 });
        const refused = await v1(key);
        assert.equal(refused.status, 401);
        assert.equal((await refused.json()).error, 'invalid_api_key');
        await setPolicy(id, { 'security.apiKeyMaxAgeDays': 0 });
        assert.equal((await v1(key)).status, 404);
    });

    it('applies the controls (403) and the expired plan (402) to /v1', async () => {
        const id = tenant();
        const key = keyFor(id, ['events:write', 'contacts:read']);
        app.locals.tenancy.updateTenant(id, { controls: { automationsEnabled: false } });
        const blocked = await v1(key, 'POST', '/api/v1/events', { event: 'x', phone: '9876500001' });
        assert.equal(blocked.status, 403);
        assert.equal((await blocked.json()).error, 'tenant_blocked');
        const owner = sessionFor(app, { tenantId: id });
        assert.equal((await call(owner, 'POST', '/api/events', { event: 'x' })).status, 403, 'the session API too');
        assert.equal((await call(owner, 'POST', '/api/objects/order', {})).status, 403);
        db.db.prepare("UPDATE subscriptions SET status = 'cancelled', cancelled_at = '2000-01-01T00:00:00Z' WHERE tenant_id = ?").run(id);
        const expired = await v1(key);
        assert.equal(expired.status, 402);
        assert.equal((await expired.json()).error, 'subscription_expired');
    });

    it('applies the dashboard API rate limit per tenant', async () => {
        const id = tenant();
        await setPolicy(id, { 'security.apiRatePerSecond': 1, 'security.apiBurst': 1 });
        const owner = sessionFor(app, { tenantId: id });
        assert.equal((await call(owner, 'GET', '/api/auth/me')).status, 200);
        assert.equal((await call(owner, 'GET', '/api/auth/me')).status, 429);
    });

    it('hides security.* from the tenant policy view', async () => {
        const id = tenant();
        const { status, body } = await call(sessionFor(app, { tenantId: id }), 'GET', '/api/policy');
        assert.equal(status, 200);
        assert.ok('templates.maxButtons' in body.values);
        assert.ok(!Object.keys(body.values).some((k) => k.startsWith('security.')));
        assert.ok(!Object.keys(body.sources).some((k) => k.startsWith('security.')));
    });

    it('expires a session after the tenant idle override, but not a super admin\'s', async () => {
        const id = tenant();
        const tenancy = app.locals.tenancy;
        const owner = sessionFor(app, { tenantId: id });
        const admin = sessionFor(app, { role: 'super_admin' });
        const idle = (token, minutes) => db.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
            .run(new Date(Date.now() - minutes * 60000).toISOString(), crypto.createHash('sha256').update(token).digest('hex'));
        idle(owner, 10);
        idle(admin, 10);
        assert.ok(tenancy.resolveSession(owner), 'default 12h');
        await setPolicy(id, { 'security.sessionIdleMinutes': 5 });
        idle(owner, 10);
        assert.equal(tenancy.resolveSession(owner), null);
        assert.ok(tenancy.resolveSession(admin));
    });

    it('signs everyone out and revokes every API key, audited', async () => {
        const id = tenant();
        const owner = sessionFor(app, { tenantId: id });
        sessionFor(app, { tenantId: id, role: 'agent' });
        const key = keyFor(id);
        keyFor(id);
        const other = sessionFor(app, { tenantId: tenant() });

        const sessions = await call(sup, 'POST', `/api/admin/tenants/${id}/sessions/revoke`);
        assert.deepEqual(sessions, { status: 200, body: { count: 2 } });
        assert.equal((await call(owner, 'GET', '/api/auth/me')).status, 401);
        assert.equal((await call(other, 'GET', '/api/auth/me')).status, 200, 'other tenants untouched');

        const keys = await call(sup, 'POST', `/api/admin/tenants/${id}/api-keys/revoke`);
        assert.deepEqual(keys, { status: 200, body: { count: 2 } });
        assert.equal((await v1(key)).status, 401);
        assert.equal((await call(sup, 'POST', '/api/admin/tenants/99999/api-keys/revoke')).status, 404);

        const actions = app.locals.tenancy.listAudit({ tenantId: id }).map((row) => row.action);
        assert.ok(actions.includes('tenant.sessions.revoke'));
        assert.ok(actions.includes('tenant.api_keys.revoke'));
    });
});

describe('TRUST_PROXY', () => {
    it('reads a hop count as a number and "true" as true', async () => {
        const saved = process.env.TRUST_PROXY;
        try {
            for (const [value, want] of [['1', 1], ['true', true]]) {
                process.env.TRUST_PROXY = value;
                const app = createTestApp({ config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
                assert.equal(app.get('trust proxy'), want);
                assert.equal(app.get('trust proxy fn')('127.0.0.1', 0), true, `${value} trusts the nearest hop`);
                await closeApp(app);
            }
        } finally {
            if (saved === undefined) delete process.env.TRUST_PROXY;
            else process.env.TRUST_PROXY = saved;
        }
    });
});
