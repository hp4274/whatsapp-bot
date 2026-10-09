/**
 * A business changing its own anti-ban limits: allowed by the platform admin,
 * gated on a recorded, versioned consent, and still bounded by POLICY_SPEC.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { CONSENT_VERSION } from '../src/tenancy.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-custom-safety-'));
let app;
let db;
let server;
let base;
let tenancy;
let tenant;
const tokens = {};

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const consent = (token, extra = {}) => call(token, 'POST', '/api/safety/custom/consent', {
    accept: true, version: CONSENT_VERSION, fullName: 'Asha Owner', confirmation: 'I ACCEPT', ...extra,
});
/** The live channel config the campaign engine actually uses. */
const liveConfig = async () => (await call(tokens.owner, 'GET', '/api/config')).body.config;

before(async () => {
    db = new Database(path.join(tmp, 't.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    tenancy = app.locals.tenancy;
    tenant = tenancy.createTenant('Shop Co', 'shop-co');
    tokens.superAdmin = sessionFor(app, { role: 'super_admin' });
    tokens.owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
    tokens.admin = sessionFor(app, { tenantId: tenant.id, role: 'admin' });
    tokens.agent = sessionFor(app, { tenantId: tenant.id, role: 'agent' });
    await call(tokens.superAdmin, 'PUT', `/api/admin/tenants/${tenant.id}/safety`, { dailyLimit: 200 });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const allow = (on) => call(tokens.superAdmin, 'PUT', `/api/admin/tenants/${tenant.id}/limits`, { allowCustomSafety: on });

describe('tenant-owned sending limits', () => {
    it('is off by default: 403 to consent and to change', async () => {
        const view = await call(tokens.owner, 'GET', '/api/safety/custom');
        assert.equal(view.status, 200);
        assert.equal(view.body.allowed, false);
        assert.equal(view.body.policy.dailyLimit, 200);
        assert.equal((await consent(tokens.owner)).status, 403);
        assert.equal((await call(tokens.owner, 'PUT', '/api/safety/custom', { dailyLimit: 900 })).status, 403);
    });

    it('keeps agents out entirely', async () => {
        await allow(true);
        assert.equal((await call(tokens.agent, 'GET', '/api/safety/custom')).status, 403);
        assert.equal((await consent(tokens.agent)).status, 403);
        assert.equal((await call(tokens.agent, 'PUT', '/api/safety/custom', { dailyLimit: 900 })).status, 403);
    });

    it('needs consent before a change, and a real one', async () => {
        assert.equal((await call(tokens.owner, 'PUT', '/api/safety/custom', { dailyLimit: 900 })).status, 403);
        assert.equal((await consent(tokens.owner, { accept: false })).status, 400);
        assert.equal((await consent(tokens.owner, { confirmation: 'yes' })).status, 400);
        assert.equal((await consent(tokens.owner, { version: 'old' })).status, 409);
        assert.equal((await consent(tokens.owner, { fullName: ' ' })).status, 400);
    });

    it('records consent with who, when and which version', async () => {
        const res = await consent(tokens.admin, { confirmation: 'shop co' }); // business name also works
        assert.equal(res.status, 201);
        assert.equal(res.body.consent.version, CONSENT_VERSION);
        assert.match(res.body.consent.email, /^admin-/);
        assert.equal(res.body.consent.fullName, 'Asha Owner');
        assert.ok(res.body.consent.acceptedAt);
        assert.ok(res.body.consent.textHash);
        assert.ok(tenancy.listAudit({ tenantId: tenant.id }).some((l) => l.action === 'safety.consent'));
        // Evidence: the database refuses to edit or delete it.
        assert.throws(() => tenancy.db.prepare('UPDATE safety_consents SET user_email = ?').run('x'), /immutable/);
        assert.throws(() => tenancy.db.prepare('DELETE FROM safety_consents').run(), /immutable/);
    });

    it('applies overrides to the live channel config', async () => {
        await liveConfig(); // start the channel runtime first: the change must reach a running engine
        const res = await call(tokens.owner, 'PUT', '/api/safety/custom', { dailyLimit: 900, minDelaySeconds: 2 });
        assert.equal(res.status, 200);
        assert.equal(res.body.active, true);
        assert.equal(res.body.policy.dailyLimit, 900);
        assert.equal(res.body.platform.dailyLimit, 200);
        const cfg = await liveConfig();
        assert.equal(cfg.dailyLimit, 900);
        assert.equal(cfg.minDelaySeconds, 2);
    });

    it('rejects values outside the platform ranges', async () => {
        assert.equal((await call(tokens.owner, 'PUT', '/api/safety/custom', { dailyLimit: -5 })).status, 400);
        assert.equal((await call(tokens.owner, 'PUT', '/api/safety/custom', { rateLimitPerSecond: 500 })).status, 400);
        assert.equal((await call(tokens.owner, 'PUT', '/api/safety/custom', { pacingMode: 'turbo' })).status, 400);
        assert.equal((await call(tokens.owner, 'PUT', '/api/safety/custom', { minDelaySeconds: 30, maxDelaySeconds: 10 })).status, 400);
    });

    it('cannot be changed through PUT /config', async () => {
        await call(tokens.owner, 'PUT', '/api/config', { dailyLimit: 99999 });
        assert.equal((await liveConfig()).dailyLimit, 900);
    });

    it('shows the super admin who accepted and what is active', async () => {
        const res = await call(tokens.superAdmin, 'GET', `/api/admin/tenants/${tenant.id}/safety`);
        assert.equal(res.body.safety.dailyLimit, 200, 'platform values are unchanged');
        assert.equal(res.body.custom.active, true);
        assert.equal(res.body.custom.overrides.dailyLimit, 900);
        assert.match(res.body.custom.consent.email, /^admin-/);
    });

    it('stops applying (but keeps) overrides when the platform admin disallows', async () => {
        await allow(false);
        assert.equal((await liveConfig()).dailyLimit, 200);
        assert.equal((await liveConfig()).minDelaySeconds, DEFAULTS.minDelaySeconds);
        const view = await call(tokens.owner, 'GET', '/api/safety/custom');
        assert.equal(view.body.active, false);
        assert.equal(view.body.overrides.dailyLimit, 900);
        assert.equal((await call(tokens.owner, 'PUT', '/api/safety/custom', { dailyLimit: 800 })).status, 403);
        await allow(true);
        assert.equal((await liveConfig()).dailyLimit, 900, 'back on with the old consent');
    });

    it('requires re-consent when the terms version changes', async () => {
        // Simulate a bump: only consents to an older text exist.
        const other = tenancy.createTenant('Bumped', 'bumped');
        tenancy.setLimits(other.id, { allowCustomSafety: true });
        tenancy.db.prepare(`INSERT INTO safety_consents (tenant_id, user_id, user_email, accepted_at, text_version, text_hash)
                            VALUES (?, 1, 'a@b.c', '2026-01-01T00:00:00Z', 'v0', 'x')`).run(other.id);
        const owner = sessionFor(app, { tenantId: other.id, role: 'owner' });
        assert.equal((await call(owner, 'GET', '/api/safety/custom')).body.consent, null);
        assert.equal((await call(owner, 'PUT', '/api/safety/custom', { dailyLimit: 900 })).status, 403);
    });

    it('resets to platform values, and the super admin can revoke', async () => {
        const reset = await call(tokens.owner, 'DELETE', '/api/safety/custom');
        assert.equal(reset.status, 200);
        assert.deepEqual(reset.body.overrides, {});
        assert.equal((await liveConfig()).dailyLimit, 200);

        await call(tokens.owner, 'PUT', '/api/safety/custom', { dailyLimit: 700 });
        assert.equal((await liveConfig()).dailyLimit, 700);
        const revoked = await call(tokens.superAdmin, 'DELETE', `/api/admin/tenants/${tenant.id}/custom-safety`);
        assert.equal(revoked.status, 200);
        assert.equal(revoked.body.custom.allowed, false);
        assert.equal((await liveConfig()).dailyLimit, 200);
    });
});
