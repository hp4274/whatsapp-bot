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
        const res = await createTenant({ planKey: 'starter' });
        assert.equal(res.status, 201);
        const { tenant } = res.body;
        assert.ok(tenant.services.includes('contacts') && !tenant.services.includes('ai'), 'plan services by default');
        const picked = await createTenant({ planKey: 'starter', services: ['ai', 'contacts', 'bogus'] });
        assert.deepEqual(picked.body.tenant.services, ['contacts', 'ai'], 'hand-picked services win, unknown dropped');
        assert.equal(picked.body.tenant.limits.maxChannels, 1, 'limits still come from the plan');
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
        assert.equal(plans.body.plans.find((p) => p.key === 'starter').subscribers, 2);

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

    it('keeps a limit the admin overrode across a plan change; the rest follow the new plan', async () => {
        const { body: { tenant } } = await createTenant({ planKey: 'business' });
        assert.equal((await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/limits`, { maxUsers: 99 })).status, 200);
        const res = await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'starter' });
        assert.equal(res.status, 200);
        assert.equal(res.body.tenant.limits.maxUsers, 99, 'the override stays');
        assert.equal(res.body.tenant.limits.maxChannels, 1, 'an untouched limit moves to the new plan');
    });

    it('pushes an edited plan limit to its subscribers, except where the admin overrode it', async () => {
        const { body: { tenant: plain } } = await createTenant({ planKey: 'starter' });
        const { body: { tenant: custom } } = await createTenant({ planKey: 'starter' });
        assert.equal((await call(sup, 'PUT', `/api/admin/tenants/${custom.id}/limits`, { maxUsers: 99 })).status, 200);
        const before = (await call(sup, 'GET', '/api/admin/billing/plans')).body.plans.find((p) => p.key === 'starter');
        const edited = await call(sup, 'PUT', '/api/admin/billing/plans/starter',
            { tenantLimits: { ...before.tenantLimits, maxUsers: 42 } });
        assert.equal(edited.status, 200);
        const reapplied = await call(sup, 'PUT', `/api/admin/tenants/${plain.id}/subscription`, { planKey: 'starter' });
        assert.equal(reapplied.body.tenant.limits.maxUsers, 42, 'the edit reaches an existing subscriber');
        const kept = await call(sup, 'PUT', `/api/admin/tenants/${custom.id}/subscription`, { planKey: 'starter' });
        assert.equal(kept.body.tenant.limits.maxUsers, 99, 'the override stays');
        await call(sup, 'PUT', '/api/admin/billing/plans/starter', { tenantLimits: before.tenantLimits });
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
        // Writes stop; the business can still read its own data (docs/bulk.md §16).
        assert.equal((await call(token, 'GET', '/api/contacts')).status, 200, 'reads are not gated');
        const blocked = await call(token, 'POST', '/api/contacts', { phone: '919811100001', name: 'X' });
        assert.equal(blocked.status, 402);
        assert.match(blocked.body.errors[0], /subscription has ended/);
        const me = await call(token, 'GET', '/api/auth/me');
        assert.equal(me.status, 200, '/me is never gated');
        assert.equal(me.body.tenant.subscription.state, 'expired', '/me says so, for the banner on load');
        // Nothing sends: every plan limit is 0 and the quota view says it.
        const usage = await call(token, 'GET', '/api/plan-usage');
        assert.equal(usage.status, 200);
        assert.equal(usage.body.usage.metrics.find((m) => m.metric === 'messages').limit, 0);
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

    it('moves subscribers back when a built-in plan is reset to default', async () => {
        const { body: { tenant } } = await createTenant({ planKey: 'starter' });
        const before = (await call(sup, 'GET', '/api/admin/billing/plans')).body.plans.find((p) => p.key === 'starter');
        await call(sup, 'PUT', '/api/admin/billing/plans/starter', { tenantLimits: { maxUsers: 42 } });
        assert.equal((await call(sup, 'GET', `/api/admin/tenants`)).body.tenants.find((t) => t.id === tenant.id).limits.maxUsers, 42);

        const reset = await call(sup, 'DELETE', '/api/admin/billing/plans/starter');
        assert.equal(reset.status, 200);
        assert.equal(reset.body.plan.tenantLimits.maxUsers, before.tenantLimits.maxUsers);
        const after = (await call(sup, 'GET', `/api/admin/tenants`)).body.tenants.find((t) => t.id === tenant.id);
        assert.equal(after.limits.maxUsers, before.tenantLimits.maxUsers, 'the business follows the reset');
    });

    it('merges a partial plan edit instead of wiping the other limits', async () => {
        const { body: { tenant } } = await createTenant({ planKey: 'starter' });
        const before = (await call(sup, 'GET', '/api/admin/billing/plans')).body.plans.find((p) => p.key === 'starter');
        const edited = await call(sup, 'PUT', '/api/admin/billing/plans/starter',
            { limits: { messagesPerMonth: 777 }, tenantLimits: { maxTemplates: 7 }, features: { workflows: true } });
        assert.equal(edited.status, 200);
        const plan = edited.body.plan;
        assert.equal(plan.limits.messagesPerMonth, 777);
        assert.deepEqual({ ...plan.limits, messagesPerMonth: before.limits.messagesPerMonth }, before.limits, 'other limits kept');
        assert.deepEqual({ ...plan.tenantLimits, maxTemplates: before.tenantLimits.maxTemplates }, before.tenantLimits);
        assert.deepEqual({ ...plan.features, workflows: before.features.workflows }, before.features);
        // Only the edited tenant limit reached the subscriber.
        const limits = (await call(sup, 'GET', `/api/admin/tenants`)).body.tenants.find((t) => t.id === tenant.id).limits;
        assert.equal(limits.maxTemplates, 7);
        assert.equal(limits.maxUsers, before.tenantLimits.maxUsers);
        assert.equal(limits.maxChannels, before.tenantLimits.maxChannels);
        await call(sup, 'DELETE', '/api/admin/billing/plans/starter');
    });
});
