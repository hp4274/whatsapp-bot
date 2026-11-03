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
import { Tenancy } from '../src/tenancy.js';
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
        store.set('global', { 'channels.dailyCap': 100, 'bulk.maxRecipients': 5, 'bulk.dailyCap': 100 });
        store.set('plan:starter', { 'bulk.maxRecipients': 1 });
        store.set('tenant:1', { 'bulk.dailyCap': 400 });
        const { planKey, values, sources } = store.resolve(1);
        assert.equal(planKey, 'starter');
        assert.equal(values['bulk.maxRecipients'], 1);
        assert.equal(sources['bulk.maxRecipients'], 'plan');
        assert.equal(values['bulk.dailyCap'], 400);
        assert.equal(sources['bulk.dailyCap'], 'tenant');
        // A tenant on no plan sees the global layer.
        assert.equal(store.resolve(2).values['bulk.maxRecipients'], 5);
    });

    it('refuses a rule at a scope it has no place at, and never reads one stored there', () => {
        const notHere = /is not set here/;
        assert.throws(() => store.set('tenant:1', { 'channels.dailyCap': 400 }), notHere, 'a business’s day is its own safety');
        assert.throws(() => store.set('global', { 'channels.maxNumbers': 5 }), notHere, 'a business’s own limit');
        assert.throws(() => store.set('plan:starter', { 'channels.maxNumbers': 1 }), notHere, 'the plan’s tenantLimits');
        assert.throws(() => store.set('plan:starter', { 'billing.messagesPerMonth': 3000 }), notHere, 'the plan’s own limits');
        assert.throws(() => store.set('plan:starter', { 'billing.storageMb': 10 }), notHere);
        assert.throws(() => store.set('tenant:1', { 'templates.blockedWords': ['x'] }), notHere);
        assert.equal(store.set('tenant:1', { 'billing.storageMb': 10 })['billing.storageMb'], 10, 'a business override is allowed');
        store.set('tenant:1', { 'billing.storageMb': null });
        // A row left at a hidden scope (from before the move) is skipped, not read.
        db.db.prepare('INSERT INTO platform_policy (scope, key, value, updated_at) VALUES (?, ?, ?, ?)')
            .run('tenant:1', 'channels.dailyCap', '400', new Date().toISOString());
        assert.equal(store.values('tenant:1')['channels.dailyCap'], undefined);
        assert.equal(store.resolve(1).sources['channels.dailyCap'], 'plan');
        db.db.prepare("DELETE FROM platform_policy WHERE scope = 'tenant:1' AND key = 'channels.dailyCap'").run();
    });

    it('starts each built-in plan at its own speed, keeping an admin value', () => {
        assert.equal(store.values('plan:starter')['bulk.maxSpeed'], 'safe');
        assert.equal(store.values('plan:business')['bulk.maxSpeed'], 'balanced');
        assert.equal(store.values('plan:enterprise')['bulk.maxSpeed'], 'fast');
        assert.equal(store.resolve(1).values['bulk.maxSpeed'], 'safe', 'tenant 1 is on starter');
        store.set('plan:business', { 'bulk.maxSpeed': 'fast' });
        new PolicyStore(db);
        assert.equal(store.values('plan:business')['bulk.maxSpeed'], 'fast');
        // The plan's per-number day, the same way.
        assert.deepEqual(['starter', 'business', 'enterprise'].map((p) => store.values(`plan:${p}`)['channels.dailyCap']), [250, 500, 1000]);
        store.set('plan:enterprise', { 'channels.dailyCap': 800 });
        new PolicyStore(db);
        assert.equal(store.values('plan:enterprise')['channels.dailyCap'], 800);
    });

    it('null removes an override; bad values and keys are refused', () => {
        store.set('tenant:1', { 'bulk.dailyCap': null });
        assert.equal(store.resolve(1).values['bulk.dailyCap'], 100, 'the global layer shows through');
        assert.equal(store.resolve(1).values['channels.dailyCap'], 250, 'the starter plan’s seeded day');
        assert.equal(store.resolve(2).values['channels.dailyCap'], 100, 'no plan: the global layer');
        assert.throws(() => store.set('global', { 'channels.dailyCap': 0 }), /between/);
        assert.throws(() => store.set('global', { nope: 1 }), /unknown policy field/);
        assert.throws(() => store.set('weird', {}), /unknown policy scope/);
        assert.deepEqual(store.set('global', { 'templates.blockedDomains': 'bit.ly\n bit.ly, x.io' })['templates.blockedDomains'], ['bit.ly', 'x.io']);
    });

    it('a field with a null default resolves to null until set, and null resets it', () => {
        const field = POLICY_FIELDS.find((f) => f.key === 'sending.maxLevel');
        assert.equal(field.default, null);
        assert.ok(field.nullLabel);
        assert.equal(store.resolve(1).values['sending.maxLevel'], null);
        store.set('tenant:1', { 'sending.maxLevel': 3 });
        assert.equal(store.resolve(1).values['sending.maxLevel'], 3);
        store.set('tenant:1', { 'sending.maxLevel': null });
        assert.equal(store.resolve(1).values['sending.maxLevel'], null);
        assert.equal(store.resolve(1).sources['sending.maxLevel'], 'default');
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
        const elsewhere = await as(sup, '/api/admin/policy/tenant:1', { method: 'PUT', body: JSON.stringify({ values: { 'channels.dailyCap': 100 } }) });
        assert.equal(elsewhere.status, 400, 'a business’s day is its safety, not a rule');
        assert.match((await elsewhere.json()).errors[0], /is not set here/);
    });

    it('a tenant owner reads its effective policy but cannot write', async () => {
        const owner = sessionFor(app);
        const mine = await (await as(owner, '/api/policy')).json();
        assert.equal(typeof mine.values['channels.maxNumbers'], 'number');
        const denied = await as(owner, '/api/admin/policy/global', { method: 'PUT', body: '{"values":{}}' });
        assert.equal(denied.status, 403);
    });
});

describe('rules stored where they no longer belong', () => {
    it('are moved into their one place at start (tighter cap wins) and deleted', async () => {
        const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-fold-')), 'f.db'));
        const shop = new Tenancy(db).createTenant('Fold Shop', 'fold-shop');
        new Tenancy(db).setLimits(shop.id, { maxChannels: 5 });
        const put = db.db.prepare('INSERT INTO platform_policy (scope, key, value, updated_at) VALUES (?, ?, ?, ?)');
        for (const [scope, key, value] of [
            [`tenant:${shop.id}`, 'channels.maxNumbers', 2],
            [`tenant:${shop.id}`, 'channels.dailyCap', 100],
            ['plan:starter', 'billing.messagesPerMonth', 3000],
            ['plan:starter', 'channels.dailyCap', 300], // allowed at a plan: stays
            ['global', 'templates.maxTemplates', 7],
        ]) put.run(scope, key, JSON.stringify(value), '2026-01-01T00:00:00Z');

        const app = createTestApp({ db });
        try {
            const tenant = app.locals.tenancy.getTenant(shop.id);
            assert.equal(tenant.limits.maxChannels, 2, 'the tighter of 5 and 2');
            assert.equal(tenant.safety.dailyLimit, 100, 'a business’s day is its own safety');
            assert.equal(tenant.limits.maxTemplates, 7, 'a platform-wide cap reaches every business');
            const starter = new BillingStore(db.forTenant(1)).getPlan('starter');
            assert.equal(starter.limits.messagesPerMonth, 3000);
            assert.equal(starter.tenantLimits.maxTemplates, 7, 'and every plan');
            const left = db.db.prepare('SELECT scope, key, value FROM platform_policy WHERE key IN (?, ?, ?, ?) ORDER BY scope')
                .all('channels.maxNumbers', 'channels.dailyCap', 'billing.messagesPerMonth', 'templates.maxTemplates')
                .filter((r) => r.scope === 'global' || r.scope === 'plan:starter' || r.scope === `tenant:${shop.id}`);
            assert.deepEqual(left.map((r) => [r.scope, r.key, JSON.parse(r.value)]), [['plan:starter', 'channels.dailyCap', 300]]);
        } finally {
            await closeApp(app);
            db.close();
        }
    });
});
