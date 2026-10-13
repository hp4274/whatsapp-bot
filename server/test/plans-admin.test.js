/** Super admin plans & subscriptions: catalogue, assignment, cancellation and the 402 gate. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { TENANT_SERVICES } from '../src/tenancy.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-plans-'));
let db;
let app;
let server;
let base;
let sup;

const call = async (token, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};

let slugN = 0;
const createTenant = (extra = {}) => {
    slugN += 1;
    return call(sup, 'POST', '/api/admin/tenants', {
        name: `Shop ${slugN}`,
        slug: `shop-${slugN}`,
        owner: { email: `owner${slugN}@plans.test`, password: 'password123' },
        ...extra,
    });
};

before(async () => {
    db = new Database(path.join(tmp, 'plans.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('admin plans & subscriptions', () => {
    it('lists the default catalogue with subscriber counts', async () => {
        const { status, body } = await call(sup, 'GET', '/api/admin/billing/plans');
        assert.equal(status, 200);
        assert.deepEqual(body.services, [...TENANT_SERVICES]);
        assert.deepEqual(body.plans.map((p) => p.key), ['starter', 'business', 'enterprise']);
        const starter = body.plans[0];
        assert.equal(starter.price, 999);
        assert.equal(starter.currency, 'INR');
        assert.equal(starter.interval, 'month');
        assert.equal(starter.trialDays, 14);
        assert.equal(starter.active, true);
        assert.equal(starter.subscribers, 0);
        assert.equal(starter.tenantLimits.maxChannels, 1);
        assert.ok(starter.services.includes('inbox') && !starter.services.includes('faq'));
        const enterprise = body.plans[2];
        assert.equal(enterprise.price, 0);
        assert.equal(enterprise.trialDays, 0);
        assert.deepEqual(enterprise.services, [...TENANT_SERVICES]);
        assert.equal(enterprise.tenantLimits.maxUsers, 0);
        const owner = sessionFor(app, { tenantId: 1, role: 'owner' });
        assert.equal((await call(owner, 'GET', '/api/admin/billing/plans')).status, 403);
    });

    it('upserts a custom plan and rejects bad input', async () => {
        const made = await call(sup, 'PUT', '/api/admin/billing/plans/pilot', {
            name: 'Pilot', tier: 0, price: 499, currency: 'usd', interval: 'year', trialDays: 7,
            services: ['contacts', 'inbox', 'nope'], tenantLimits: { maxChannels: 2 },
        });
        assert.equal(made.status, 200);
        assert.equal(made.body.plan.currency, 'USD');
        assert.equal(made.body.plan.interval, 'year');
        assert.deepEqual(made.body.plan.services, ['contacts', 'inbox']);
        assert.equal(made.body.plan.tenantLimits.maxChannels, 2);

        // A partial PUT keeps the rest.
        const archived = await call(sup, 'PUT', '/api/admin/billing/plans/pilot', { active: false });
        assert.equal(archived.body.plan.active, false);
        assert.equal(archived.body.plan.price, 499);

        for (const bad of [{ currency: 'rupees' }, { interval: 'week' }, { price: -1 }, { trialDays: 400 },
            { tenantLimits: { maxChannels: -3 } }]) {
            const res = await call(sup, 'PUT', '/api/admin/billing/plans/pilot', bad);
            assert.equal(res.status, 400, JSON.stringify(bad));
            assert.ok(res.body.errors[0]);
        }
        assert.equal((await call(sup, 'PUT', '/api/admin/billing/plans/Bad%20Key', { name: 'x' })).status, 400);
    });

    it('creates a tenant on a plan: services, limits and a trial', async () => {
        const res = await createTenant({ planKey: 'starter', services: ['ai'] });
        assert.equal(res.status, 201);
        const { tenant } = res.body;
        assert.ok(tenant.services.includes('contacts') && !tenant.services.includes('ai'), 'plan wins over body');
        assert.equal(tenant.limits.maxChannels, 1);
        assert.equal(tenant.limits.maxUsers, 2);
        assert.equal(tenant.subscription.planKey, 'starter');
        assert.equal(tenant.subscription.state, 'trialing');
        assert.equal(tenant.subscription.price, 999);
        assert.ok(tenant.subscription.trialEndsAt > new Date().toISOString());

        const list = await call(sup, 'GET', '/api/admin/tenants');
        assert.equal(list.body.tenants.find((t) => t.id === tenant.id).subscription.planName, 'Starter');
        assert.equal(list.body.tenants.find((t) => t.id === 1).subscription, null);
        const plans = await call(sup, 'GET', '/api/admin/billing/plans');
        assert.equal(plans.body.plans.find((p) => p.key === 'starter').subscribers, 1);

        assert.equal((await createTenant({ planKey: 'ghost' })).status, 404);
    });

    it('changes plan immediately and re-applies services and limits', async () => {
        const { body: { tenant } } = await createTenant({ planKey: 'business' });
        const res = await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'starter' });
        assert.equal(res.status, 200);
        assert.equal(res.body.subscription.planKey, 'starter', 'a downgrade by the admin is not deferred');
        assert.equal(res.body.subscription.state, 'active', 'a change does not restart the trial');
        assert.equal(res.body.subscription.pendingPlanKey, null);
        assert.equal(res.body.tenant.limits.maxChannels, 1);
        assert.ok(!res.body.tenant.services.includes('tickets'));
        assert.equal((await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'ghost' })).status, 404);
    });

    it('cancels immediately into grace, and an expired business gets 402 but the super admin does not', async () => {
        const { body: { tenant } } = await createTenant({ planKey: 'starter', trialDays: 0 });
        assert.equal(tenant.subscription.state, 'active');
        const ended = await call(sup, 'DELETE', `/api/admin/tenants/${tenant.id}/subscription?immediate=true`);
        assert.equal(ended.status, 200);
        assert.equal(ended.body.subscription.status, 'cancelled');
        assert.equal(ended.body.subscription.state, 'grace');

        const token = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
        assert.equal((await call(token, 'GET', '/api/contacts')).status, 200, 'grace still works');

        // Push the cancellation past the grace window.
        db.db.prepare('UPDATE subscriptions SET cancelled_at = ? WHERE tenant_id = ?')
            .run(new Date(Date.now() - 30 * 86_400_000).toISOString(), tenant.id);
        const blocked = await call(token, 'GET', '/api/contacts');
        assert.equal(blocked.status, 402);
        assert.match(blocked.body.errors[0], /subscription has ended/);
        assert.equal((await call(token, 'GET', '/api/auth/me')).status, 200, '/me is never gated');
        const asAdmin = await call(sup, 'GET', '/api/contacts', null, { 'x-tenant-id': String(tenant.id) });
        assert.equal(asAdmin.status, 200);

        // Renew = PUT again.
        const renewed = await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'starter' });
        assert.equal(renewed.body.subscription.state, 'active');
        assert.equal((await call(token, 'GET', '/api/contacts')).status, 200);

        const later = await call(sup, 'DELETE', `/api/admin/tenants/${tenant.id}/subscription`);
        assert.equal(later.body.subscription.cancelAtPeriodEnd, true);
    });

    it('refuses to delete a custom plan with subscribers, reverts a constant', async () => {
        await call(sup, 'PUT', '/api/admin/billing/plans/solo', { name: 'Solo', price: 100 });
        const { body: { tenant } } = await createTenant({ planKey: 'solo' });
        assert.equal((await call(sup, 'DELETE', '/api/admin/billing/plans/solo')).status, 409);

        await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'starter' });
        const removed = await call(sup, 'DELETE', '/api/admin/billing/plans/solo');
        assert.equal(removed.status, 200);
        assert.deepEqual(removed.body, { removed: true });

        await call(sup, 'PUT', '/api/admin/billing/plans/starter', { price: 1 });
        const reverted = await call(sup, 'DELETE', '/api/admin/billing/plans/starter');
        assert.equal(reverted.body.plan.price, 999);
    });
});
