/**
 * WhatsApp OTP: a business makes an otp:send key on its page, its backend sends a code through /v1/otp and verifies
 * what the customer typed. The super admin's rules (policy/modules.js) cap it; it never touches the API quota.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { BillingStore } from '../src/billing/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { appOf, siteOf } from '../src/otp/store.js';
import { ApiKeyStore } from '../src/publicapi/keys.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-otp-'));
let app;
let server;
let base;
let db;
let owner;
let admin;
let key;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const rules = async (values) => {
    const res = await call(admin, 'PUT', '/api/admin/policy/tenant:1', { values });
    assert.equal(res.status, 200, JSON.stringify(res.body));
};
const last = (phone) => db.db.prepare('SELECT message FROM messages WHERE recipient LIKE ? ORDER BY rowid')
    .all(`%${phone.slice(-10)}%`).map((r) => r.message).at(-1) ?? '';
const codeIn = (text) => /^(\d{4,8}) is your/.exec(text)?.[1];
const send = (body, k = key) => call(k, 'POST', '/api/v1/otp/send', body);
const verify = (body, k = key) => call(k, 'POST', '/api/v1/otp/verify', body);

before(async () => {
    db = new Database(path.join(tmp, 'o.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connection/connect`, { method: 'POST' });
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
    admin = sessionFor(app, { role: 'super_admin' });
    await rules({ 'security.publicApiBurst': 1000 }); // one key makes every call here
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WhatsApp OTP', () => {
    it('the page makes keys scoped to otp:send only, and lists only those', async () => {
        new ApiKeyStore(db.forTenant(1)).createKey({ name: 'other', scopes: ['contacts:read'] });
        const made = await call(owner, 'POST', '/api/otp/keys', { name: 'Backend' });
        assert.equal(made.status, 201);
        assert.deepEqual(made.body.key.scopes, ['otp:send']);
        assert.match(made.body.key.key, /^wsk_/);
        key = made.body.key.key;
        const page = (await call(owner, 'GET', '/api/otp')).body;
        assert.deepEqual(page.keys.map((k) => k.name), ['Backend']);
        assert.equal(page.keys[0].key, undefined, 'the secret is shown once');
        assert.equal(page.connected, true);
        assert.deepEqual(page.rules, { maxPerPhoneHour: 5, maxPerMonth: null, allowCustomCode: true, maxTtlMinutes: 30 });
        assert.equal(page.settings.length, 6);
        const other = new ApiKeyStore(db.forTenant(1)).list().find((k) => k.name === 'other');
        assert.equal((await call(owner, 'DELETE', `/api/otp/keys/${other.id}`)).status, 404, 'not an OTP key');
    });

    it('settings are checked', async () => {
        assert.equal((await call(owner, 'PUT', '/api/otp/settings', { template: 'Your code' })).status, 400);
        assert.equal((await call(owner, 'PUT', '/api/otp/settings', { length: 9 })).status, 400);
        const ok = await call(owner, 'PUT', '/api/otp/settings', { brand: 'Asha Store', ttlMinutes: 5 });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.settings.brand, 'Asha Store');
    });

    it('sends a code and verifies it once', async () => {
        const sent = await send({ phone: '9800000301', purpose: 'login' });
        assert.equal(sent.status, 201, JSON.stringify(sent.body));
        assert.equal(sent.body.phone, '919800000301');
        assert.equal(sent.body.status, 'sent');
        assert.match(sent.body.id, /^otp_[0-9a-f]{16}$/);
        const text = last('9800000301');
        assert.match(text, /^\d{6} is your Asha Store verification code\. It expires in 5 minutes\./);
        const code = codeIn(text);
        assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM otp_codes WHERE code_hash = ?').get(code).n, 0, 'never the code itself');

        const wrong = await verify({ id: sent.body.id, code: code === '000000' ? '111111' : '000000' });
        assert.deepEqual(wrong.body, { valid: false, reason: 'wrong_code', attemptsLeft: 4 });
        assert.deepEqual((await verify({ phone: '9800000301', code })).body, { valid: true, id: sent.body.id });
        assert.deepEqual((await verify({ id: sent.body.id, code })).body, { valid: false, reason: 'already_used' });
        assert.deepEqual((await verify({ phone: '9800000301', code })).body, { valid: false, reason: 'already_used' }, 'by phone too');
        const read = await call(key, 'GET', `/api/v1/otp/${sent.body.id}`);
        assert.equal(read.body.status, 'verified');
        assert.equal(read.body.attempts, 1);
        assert.deepEqual((await verify({ id: 'otp_0000000000000000', code })).body, { valid: false, reason: 'not_found' });

        const page = (await call(owner, 'GET', '/api/otp')).body;
        assert.equal(page.recent[0].phone, '919800000301', 'the business sees its customer\'s full number');
        assert.equal(page.recent[0].client.keyId, page.keys.find((k) => !k.revokedAt).id, 'and which key sent it');
        assert.ok(page.recent[0].client.app, 'and from which app');
        assert.equal(page.connections[0].sent >= 1, true);
        assert.equal(page.connections[0].keyId, page.recent[0].client.keyId);
        assert.equal(page.stats.verifiedMonth, 1);
    });

    it('blocks after too many wrong codes, and expires', async () => {
        await call(owner, 'PUT', '/api/otp/settings', { maxAttempts: 2 });
        const sent = await send({ phone: '9800000302' });
        const code = codeIn(last('9800000302'));
        const bad = code === '000000' ? '111111' : '000000';
        assert.equal((await verify({ id: sent.body.id, code: bad })).body.reason, 'wrong_code');
        assert.deepEqual((await verify({ id: sent.body.id, code: bad })).body, { valid: false, reason: 'too_many_attempts', attemptsLeft: 0 });
        assert.equal((await verify({ id: sent.body.id, code })).body.reason, 'too_many_attempts', 'even the right code');

        const late = await send({ phone: '9800000303' });
        const lateCode = codeIn(last('9800000303'));
        db.db.prepare('UPDATE otp_codes SET expires_at = ? WHERE id = ?').run('2020-01-01T00:00:00.000Z', late.body.id);
        assert.equal((await verify({ id: late.body.id, code: lateCode })).body.reason, 'expired');
        assert.equal((await call(key, 'GET', `/api/v1/otp/${late.body.id}`)).body.status, 'expired');
        await call(owner, 'PUT', '/api/otp/settings', { maxAttempts: 5 });
    });

    it('waits before a resend, and the new code replaces the old one', async () => {
        const first = await send({ phone: '9800000304' });
        const again = await send({ phone: '9800000304' });
        assert.equal(again.status, 429);
        assert.equal(again.body.error, 'resend_too_soon');
        assert.ok(again.body.retryAfter > 0 && again.body.retryAfter <= 30);
        await call(owner, 'PUT', '/api/otp/settings', { resendSeconds: 0 });
        const second = await send({ phone: '9800000304' });
        assert.equal(second.status, 201);
        assert.equal((await call(key, 'GET', `/api/v1/otp/${first.body.id}`)).body.status, 'expired');
    });

    it('a custom code, when the plan allows it', async () => {
        const mine = await send({ phone: '9800000305', code: '4242' });
        assert.equal(mine.status, 201);
        assert.match(last('9800000305'), /^4242 is your/);
        assert.equal((await verify({ id: mine.body.id, code: '4242' })).body.valid, true);
        assert.equal((await send({ phone: '9800000306', code: '12' })).body.error, 'invalid_code');
        await rules({ 'otp.allowCustomCode': false });
        const refused = await send({ phone: '9800000306', code: '4242' });
        assert.equal(refused.status, 403, JSON.stringify(refused.body));
        assert.equal(refused.body.error, 'custom_code_not_allowed');
        await rules({ 'otp.allowCustomCode': null });
    });

    it('per-phone hourly and monthly caps, and bad phones', async () => {
        await rules({ 'otp.maxPerPhoneHour': 1 });
        assert.equal((await send({ phone: '9800000307' })).status, 201);
        const capped = await send({ phone: '9800000307' });
        assert.equal(capped.status, 429);
        assert.equal(capped.body.error, 'phone_rate_limited');
        await rules({ 'otp.maxPerPhoneHour': null, 'otp.maxPerMonth': 1 });
        assert.equal((await send({ phone: '9800000308' })).body.error, 'monthly_limit');
        await rules({ 'otp.maxPerMonth': null });
        const bad = await send({ phone: 'abc' });
        assert.equal(bad.status, 400);
        assert.equal(bad.body.error, 'invalid_phone');
    });

    it('the test button sends with the saved settings', async () => {
        const res = await call(owner, 'POST', '/api/otp/test', { phone: '9800000309' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.otp.source, 'test');
        assert.equal(res.body.otp.status, 'pending');
        assert.match(last('9800000309'), /Asha Store/);
        assert.equal((await call(owner, 'POST', '/api/otp/test', { phone: 'x' })).status, 400);

        // The page then checks the code it got, the way the customer's app would.
        const id = res.body.otp.id;
        const wrong = await call(owner, 'POST', '/api/otp/test/verify', { id, code: '00000000' });
        assert.equal(wrong.body.result.reason, 'wrong_code');
        assert.equal(wrong.body.otp.attempts, 1);
        const right = await call(owner, 'POST', '/api/otp/test/verify', { id, code: codeIn(last('9800000309')) });
        assert.equal(right.body.result.valid, true);
        assert.equal(right.body.otp.status, 'verified');
        assert.equal((await call(owner, 'POST', '/api/otp/test/verify', { id, code: '' })).status, 400);
    });

    it('a key without otp:send is refused', async () => {
        const other = new ApiKeyStore(db.forTenant(1)).createKey({ scopes: ['contacts:read'] }).key;
        const res = await send({ phone: '9800000310' }, other);
        assert.equal(res.status, 403);
        assert.equal(res.body.error, 'insufficient_scope');
    });

    it('works on a plan with no API requests, and is not counted', async () => {
        new BillingStore(db.forTenant(1)).subscribe(1, 'starter');
        const contacts = new ApiKeyStore(db.forTenant(1)).createKey({ scopes: ['contacts:read'] }).key;
        assert.equal((await call(contacts, 'GET', '/api/v1/contacts/9800000311')).status, 429, 'the plan has no API');
        const res = await send({ phone: '9800000311' });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(new BillingStore(db.forTenant(1)).usage().metrics.find((m) => m.metric === 'api_requests').used, 0);
    });

    it('needs the otp service', async () => {
        const services = app.locals.tenancy.getTenant(1).services;
        app.locals.tenancy.updateTenant(1, { services: services.filter((s) => s !== 'otp') });
        const res = await send({ phone: '9800000312' });
        assert.equal(res.status, 403);
        assert.equal(res.body.error, 'otp_not_enabled');
        assert.equal((await call(owner, 'GET', '/api/otp')).status, 403);
        app.locals.tenancy.updateTenant(1, { services });
    });

    it('the service page shows sent and verified', async () => {
        const usage = (await call(admin, 'GET', '/api/admin/services/otp/usage')).body.usage;
        assert.match(usage[1], /^\d+ sent this month · \d+% verified$/);
        const { fields } = (await call(admin, 'GET', '/api/admin/policy')).body;
        assert.deepEqual(fields.filter((f) => f.service === 'otp').map((f) => f.key).sort(),
            ['otp.allowCustomCode', 'otp.maxPerMonth', 'otp.maxPerPhoneHour', 'otp.maxTtlMinutes']);
    });
});

describe('where an OTP call came from', () => {
    it('names the app from its user agent, and the site from Origin or Referer', () => {
        assert.equal(appOf('python-requests/2.31.0'), 'python-requests/2.31.0');
        assert.equal(appOf('curl/8.4.0'), 'curl/8.4.0');
        assert.equal(appOf('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'), 'Chrome (from a web page)');
        assert.equal(appOf(''), null);
        assert.equal(siteOf('https://shop.example.com', null), 'shop.example.com');
        assert.equal(siteOf(undefined, 'http://localhost:8000/login'), 'localhost:8000');
        assert.equal(siteOf('null', 'not a url'), null);
    });
});
