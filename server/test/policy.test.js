/** Platform policy: layer resolution (tenant > plan > global > default) and the admin API. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { BillingStore } from '../src/billing/store.js';
import { Database } from '../src/db.js';
import { PolicyStore, POLICY_FIELDS } from '../src/policy/index.js';
import { createTestApp, sessionFor } from './helpers.js';

describe('PolicyStore', () => {
    const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-policy-')), 'p.db'));
    const store = new PolicyStore(db);

    it('falls back to the field default with an empty table', () => {
        const { values, sources } = store.resolve(1);
        assert.equal(values['channels.dailyCap'], 250);
        assert.equal(sources['channels.dailyCap'], 'default');
        assert.equal(Object.keys(values).length, POLICY_FIELDS.length);
    });

    it('layers global, plan and tenant in that order', () => {
        new BillingStore(db.forTenant(1)).subscribe(1, 'starter');
        store.set('global', { 'channels.dailyCap': 100, 'channels.maxNumbers': 5 });
        store.set('plan:starter', { 'channels.maxNumbers': 1 });
        store.set('tenant:1', { 'channels.dailyCap': 400 });
        const { planKey, values, sources } = store.resolve(1);
        assert.equal(planKey, 'starter');
        assert.equal(values['channels.maxNumbers'], 1);
        assert.equal(sources['channels.maxNumbers'], 'plan');
        assert.equal(values['channels.dailyCap'], 400);
        assert.equal(sources['channels.dailyCap'], 'tenant');
        // A tenant on no plan sees the global layer.
        assert.equal(store.resolve(2).values['channels.maxNumbers'], 5);
    });

    it('null removes an override; bad values and keys are refused', () => {
        store.set('tenant:1', { 'channels.dailyCap': null });
        assert.equal(store.resolve(1).values['channels.dailyCap'], 100);
        assert.throws(() => store.set('global', { 'channels.dailyCap': 0 }), /between/);
        assert.throws(() => store.set('global', { nope: 1 }), /unknown policy field/);
        assert.throws(() => store.set('weird', {}), /unknown policy scope/);
        assert.deepEqual(store.set('global', { 'templates.blockedDomains': 'bit.ly\n bit.ly, x.io' })['templates.blockedDomains'], ['bit.ly', 'x.io']);
    });
});

describe('policy API', () => {
    let app;
    let server;
    let base;
    let sup;
    before(async () => {
        app = createTestApp();
        server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        base = `http://127.0.0.1:${server.address().port}`;
        sup = sessionFor(app, { role: 'super_admin' });
    });
    after(async () => {
        server.close();
        await closeApp(app);
    });

    const as = (token, url, init = {}) => fetch(base + url, {
        ...init,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    });

    it('super admin reads fields and writes a plan scope', async () => {
        const read = await (await as(sup, '/api/admin/policy')).json();
        assert.ok(read.fields.length > 10);
        assert.ok(read.planList.some((p) => p.key === 'starter'));
        const put = await as(sup, '/api/admin/policy/plan:starter', { method: 'PUT', body: JSON.stringify({ values: { 'bulk.maxRecipients': 500 } }) });
        assert.equal(put.status, 200);
        assert.equal((await put.json()).values['bulk.maxRecipients'], 500);
        const bad = await as(sup, '/api/admin/policy/global', { method: 'PUT', body: JSON.stringify({ values: { 'bulk.maxSpeed': 'warp' } }) });
        assert.equal(bad.status, 400);
    });

    it('a tenant owner reads its effective policy but cannot write', async () => {
        const owner = sessionFor(app);
        const mine = await (await as(owner, '/api/policy')).json();
        assert.equal(typeof mine.values['channels.maxNumbers'], 'number');
        const denied = await as(owner, '/api/admin/policy/global', { method: 'PUT', body: '{"values":{}}' });
        assert.equal(denied.status, 403);
    });
});
