/** Plan management from Tenant settings: limits (blank = none, 0 = zero), end date, top-ups, usage and history. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { BillingStore } from '../src/billing/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-planmgmt-'));
let db;
let app;
let server;
let base;
let sup;
let tenantId;
let owner;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};
const row = (rows, key) => rows.find((r) => r.key === key);

before(async () => {
    db = new Database(path.join(tmp, 'plan.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
    const made = await call(sup, 'POST', '/api/admin/tenants', {
        name: 'Plan Shop', slug: 'plan-shop', planKey: 'starter', trialDays: 0,
        owner: { email: 'owner@planshop.test', password: 'password123' },
    });
    tenantId = made.body.tenant.id;
    owner = sessionFor(app, { tenantId, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('plan management', () => {
    it('reads blank as no limit and 0 as none allowed', async () => {
        const url = `/api/admin/tenants/${tenantId}/limits`;
        assert.equal((await call(sup, 'PUT', url, { maxTemplates: null })).body.limits.maxTemplates, null);
        const first = await call(owner, 'POST', '/api/templates', { name: 'one', body: 'Hello' });
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal((await call(sup, 'PUT', url, { maxTemplates: 0 })).body.limits.maxTemplates, 0);
        assert.equal((await call(owner, 'POST', '/api/templates', { name: 'two', body: 'Hi' })).status, 403, '0 means none');
        assert.equal((await call(sup, 'PUT', url, { maxTemplates: '' })).body.limits.maxTemplates, null, 'a cleared box');
        assert.equal((await call(owner, 'POST', '/api/templates', { name: 'two', body: 'Hi' })).status, 201);
        // Seats: 0 refuses even the first extra member.
        await call(sup, 'PUT', url, { maxUsers: 0 });
        assert.equal((await call(owner, 'POST', '/api/users', { email: 'a@planshop.test', password: 'password123', role: 'agent' })).status, 403);
        await call(sup, 'PUT', url, { maxUsers: null });
    });

    it('shows usage against each limit', async () => {
        const { status, body } = await call(sup, 'GET', `/api/admin/tenants/${tenantId}/usage`);
        assert.equal(status, 200);
        assert.equal(body.uploadMb, 10);
        assert.equal(row(body.rows, 'templates').used, 2);
        assert.equal(row(body.rows, 'templates').limit, null);
        assert.equal(row(body.rows, 'messages').limit, 1000, "starter's monthly quota");
        assert.ok(row(body.rows, 'users'));
        assert.ok(row(body.rows, 'numbers'));
    });

    it('sets and clears an end date; past it the plan is in grace, then expired', async () => {
        const url = `/api/admin/tenants/${tenantId}/validity`;
        const set = await call(sup, 'PUT', url, { validUntil: '2099-12-31' });
        assert.equal(set.status, 200, JSON.stringify(set.body));
        assert.equal(set.body.subscription.validUntil, '2099-12-31T23:59:59.999Z');
        assert.equal(set.body.subscription.state, 'active');
        assert.equal(set.body.tenant.subscription.validUntil, '2099-12-31T23:59:59.999Z');
        assert.equal((await call(sup, 'PUT', url, { validUntil: 'soon' })).status, 400);
        // Read with clocks after the end date: grace for GRACE_DAYS, then expired.
        const scoped = db.forTenant(tenantId);
        const at = (iso) => new BillingStore(scoped, { now: () => new Date(iso) }).subscription().state;
        assert.equal(at('2100-01-02T00:00:00Z'), 'grace');
        assert.equal(at('2100-02-01T00:00:00Z'), 'expired');
        assert.equal((await call(sup, 'PUT', url, { validUntil: null })).body.subscription.validUntil, null);
    });

    it('tops up days and this month\'s messages', async () => {
        const url = `/api/admin/tenants/${tenantId}/topup`;
        assert.equal((await call(sup, 'POST', url, {})).status, 400, 'nothing to add');
        assert.equal((await call(sup, 'POST', url, { days: -1 })).status, 400);
        const before = Date.now();
        const up = await call(sup, 'POST', url, { days: 30, messages: 500 });
        assert.equal(up.status, 200, JSON.stringify(up.body));
        const until = Date.parse(up.body.subscription.validUntil);
        assert.ok(until >= before + 30 * 864e5 - 5000 && until <= Date.now() + 30 * 864e5 + 5000, 'from today when there was no end date');
        assert.equal(up.body.subscription.topupMessages, 500);
        const again = await call(sup, 'POST', url, { days: 10, messages: 250 });
        assert.equal(Date.parse(again.body.subscription.validUntil), until + 10 * 864e5, 'adds onto the end date');
        assert.equal(again.body.subscription.topupMessages, 750);
        const usage = (await call(sup, 'GET', `/api/admin/tenants/${tenantId}/usage`)).body;
        assert.equal(row(usage.rows, 'messages').limit, 1750, 'plan quota plus this month\'s top-ups');
    });

    it("sets this business's own monthly message quota, or goes back to the plan's", async () => {
        const url = `/api/admin/tenants/${tenantId}/limits`;
        const messages = async () => row((await call(sup, 'GET', `/api/admin/tenants/${tenantId}/usage`)).body.rows, 'messages').limit;
        // The previous test topped up 750 messages this month; they add to whichever quota applies.
        assert.equal((await call(sup, 'PUT', url, { messagesPerMonth: 300 })).body.limits.messagesPerMonth, 300);
        assert.equal(await messages(), 1050);
        await call(sup, 'PUT', url, { messagesPerMonth: null });
        assert.equal(await messages(), null, 'blank = no limit');
        const back = await call(sup, 'PUT', url, { messagesPerMonth: 'plan' });
        assert.ok(!('messagesPerMonth' in back.body.limits), "'plan' removes the business's own quota");
        assert.equal(await messages(), 1750, "the plan's 1,000 plus the top-up");
        assert.equal((await call(sup, 'PUT', url, { messagesPerMonth: -1 })).status, 400);
    });

    it('takes an agreed amount only on a plan without a list price', async () => {
        const url = `/api/admin/tenants/${tenantId}/price`;
        assert.equal((await call(sup, 'PUT', url, { amount: 5000 })).status, 400, 'starter has a list price');
        await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/subscription`, { planKey: 'enterprise' });
        const set = await call(sup, 'PUT', url, { amount: 49999.6 });
        assert.equal(set.status, 200, JSON.stringify(set.body));
        assert.equal(set.body.subscription.customPrice, 50000);
        assert.equal(set.body.tenant.subscription.customPrice, 50000);
        assert.equal((await call(sup, 'PUT', url, { amount: -1 })).status, 400);
        const log = (await call(sup, 'GET', `/api/admin/audit-logs?tenant=${tenantId}&actions=tenant.price`)).body.logs[0];
        assert.match(log.summary, /agreed amount .* INR 50,000\/month/);
        // Back on a priced plan, the plan's price is what is paid: the agreed amount does not show.
        const back = await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/subscription`, { planKey: 'starter' });
        assert.equal(back.body.tenant.subscription.customPrice, null);
        assert.equal((await call(sup, 'PUT', url, { amount: null })).status, 400, 'nothing to change on a priced plan');
    });

    it('bills monthly, quarterly or annually from the plan price, and counts the renewal from the start date', async () => {
        const { cycleAmount } = await import('../src/billing/store.js');
        assert.equal(cycleAmount(999, 'month', 'quarter'), 2997);
        assert.equal(cycleAmount(999, 'month', 'year'), 11988);
        assert.equal(cycleAmount(12000, 'year', 'month'), 1000);
        const url = `/api/admin/tenants/${tenantId}`;
        await call(sup, 'PUT', `${url}/subscription`, { planKey: 'starter' });
        const before = (await call(sup, 'GET', `${url}/payments`)).body.charged;
        assert.equal((await call(sup, 'PUT', `${url}/cycle`, { cycle: 'weekly' })).status, 400);
        const q = await call(sup, 'PUT', `${url}/cycle`, { cycle: 'quarter' });
        assert.equal(q.status, 200, JSON.stringify(q.body));
        assert.equal(q.body.subscription.billingCycle, 'quarter');
        assert.equal(q.body.tenant.balance.charged, before, 'this period was already charged: the new cycle starts at renewal');
        // Renewed quarterly: three months in one charge, noted as such.
        await call(sup, 'PUT', `${url}/subscription`, { planKey: 'starter' });
        const bill = (await call(sup, 'GET', `${url}/payments`)).body;
        assert.equal(bill.charged, before + 2997);
        assert.equal(bill.planPrice, 2997);
        assert.equal(bill.interval, 'quarter');
        assert.match(bill.entries[0].note, /Starter plan, quarterly, renewed/);
        // The start date moves the next renewal with it.
        const start = await call(sup, 'PUT', `${url}/start`, { startsAt: '2026-01-31' });
        assert.equal(start.body.subscription.startsAt, '2026-01-31T00:00:00.000Z');
        assert.equal(start.body.subscription.renewsAt, '2026-04-30T00:00:00.000Z');
        assert.equal((await call(sup, 'PUT', `${url}/start`, { startsAt: 'soon' })).status, 400);
        await call(sup, 'PUT', `${url}/cycle`, { cycle: 'month' });
        await new Promise((resolve) => setTimeout(resolve, 2100)); // the API's request burst refills for the next test
    });

    it('gives a business its own plan from what it has, without charging it twice', async () => {
        const url = `/api/admin/tenants/${tenantId}`;
        await call(sup, 'PUT', `${url}/subscription`, { planKey: 'business' });
        const before = (await call(sup, 'GET', `${url}/payments`)).body.charged;
        const made = await call(sup, 'POST', `${url}/own-plan`);
        assert.equal(made.status, 201, JSON.stringify(made.body));
        assert.equal(made.body.subscription.planKey, `own-${tenantId}`);
        assert.equal(made.body.plan.tenantId, tenantId);
        assert.equal(made.body.plan.active, false, 'never offered to anyone else');
        assert.equal(made.body.subscription.customPrice, 2999, "Business's price carried over as its own");
        assert.equal(made.body.plan.limits.messagesPerMonth, 25000);
        assert.equal(made.body.tenant.balance.charged, before, 'same period: not charged again');
        assert.equal((await call(sup, 'POST', `${url}/own-plan`)).status, 409);
        // Its services are its own: renewing does not put the plan's back.
        await call(sup, 'PATCH', url, { services: ['contacts', 'templates'] });
        await call(sup, 'PUT', `${url}/subscription`, { planKey: `own-${tenantId}` });
        const tenant = (await call(sup, 'GET', '/api/admin/tenants')).body.tenants.find((t) => t.id === tenantId);
        assert.deepEqual([...tenant.services].sort(), ['contacts', 'templates']);
        // Another business cannot be put on it.
        const other = await call(sup, 'POST', '/api/admin/tenants', {
            name: 'Other Biz', planKey: 'starter', trialDays: 0, owner: { email: 'o@other.test', password: 'password123' },
        });
        assert.equal((await call(sup, 'PUT', `/api/admin/tenants/${other.body.tenant.id}/subscription`, { planKey: `own-${tenantId}` })).status, 404);
        await new Promise((resolve) => setTimeout(resolve, 2100)); // the API's request burst refills for the next test
    });

    it('keeps a log of plan changes the Plan tab can read', async () => {
        await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/payment`, { payment: 'free' });
        const actions = 'tenant.subscription,tenant.payment,tenant.topup,tenant.validity';
        const { body } = await call(sup, 'GET', `/api/admin/audit-logs?tenant=${tenantId}&actions=${actions}&limit=50`);
        const seen = body.logs.map((l) => l.action);
        for (const a of ['tenant.payment', 'tenant.topup', 'tenant.validity']) assert.ok(seen.includes(a), a);
        assert.ok(!seen.includes('tenant.limits'), 'only the asked-for actions');
        const topup = body.logs.find((l) => l.action === 'tenant.topup');
        assert.match(topup.summary, /Topped up .*10 days and 250 messages/);
        assert.match(body.logs.find((l) => l.action === 'tenant.payment').summary, /as free/);
    });

    it('charges plans and top-ups as unpaid until payments are recorded', async () => {
        const url = `/api/admin/tenants/${tenantId}/payments`;
        const bill = async () => (await call(sup, 'GET', url)).body;
        await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/payment`, { payment: 'paid' });
        const start = await bill();
        // A plan without a list price takes the amount typed when it is chosen; a priced plan refuses one.
        const sub = `/api/admin/tenants/${tenantId}/subscription`;
        assert.equal((await call(sup, 'PUT', sub, { planKey: 'starter', amount: 5 })).status, 400);
        const ent = await call(sup, 'PUT', sub, { planKey: 'enterprise', amount: 40000 });
        assert.equal(ent.status, 200, JSON.stringify(ent.body));
        assert.equal(ent.body.subscription.customPrice, 40000);
        assert.equal(ent.body.tenant.balance.due, start.due + 40000);
        // A top-up with a price is charged too; one without is not.
        assert.equal((await call(sup, 'POST', `/api/admin/tenants/${tenantId}/topup`, { days: 5, amount: 1500 })).status, 200);
        assert.equal((await call(sup, 'POST', `/api/admin/tenants/${tenantId}/topup`, { days: 1 })).status, 200);
        let now = await bill();
        assert.equal(now.planPrice, 40000);
        assert.equal(now.charged, start.charged + 41500);
        assert.equal(now.topupCharged, start.topupCharged + 1500);
        assert.deepEqual(now.entries.slice(0, 2).map((e) => [e.kind, e.amount]), [['topup', 1500], ['plan', 40000]]);
        // "They paid": the balance drops; nothing or less than nothing is refused.
        assert.equal((await call(sup, 'POST', url, { amount: 0 })).status, 400);
        assert.equal((await call(sup, 'POST', url, { amount: -5 })).status, 400);
        assert.equal((await call(sup, 'POST', url, { amount: 30000 })).status, 400, 'how it was paid is required');
        const paid = await call(sup, 'POST', url, { amount: 30000, method: 'upi', note: 'ref 991', paidAt: '2026-11-01' });
        assert.equal(paid.status, 201, JSON.stringify(paid.body));
        assert.equal(paid.body.paid, start.paid + 30000);
        assert.equal(paid.body.due, now.charged - start.paid - 30000);
        assert.equal(paid.body.entry.note, 'ref 991');
        assert.equal(paid.body.entry.method, 'upi');
        const row = (await call(sup, 'GET', '/api/admin/payments')).body.rows.find((r) => r.tenantId === tenantId);
        assert.equal(row.due, paid.body.due);
        assert.equal(row.planName, 'Enterprise');
        assert.ok(row.lastPaidAt.startsWith('2026-11-01'));
        const log = (await call(sup, 'GET', `/api/admin/audit-logs?tenant=${tenantId}&actions=tenant.paid`)).body.logs[0];
        assert.match(log.summary, /Recorded a UPI payment of INR 30,000/);
        // A mistaken entry comes off (after the admin delete throttle's second).
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const off = await call(sup, 'DELETE', `${url}/${paid.body.entry.id}`);
        assert.equal(off.status, 200);
        assert.equal(off.body.paid, start.paid);
        // A business marked free is not charged when its plan renews.
        await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/payment`, { payment: 'free' });
        now = await bill();
        await call(sup, 'PUT', sub, { planKey: 'enterprise' });
        assert.equal((await bill()).charged, now.charged);
        assert.equal((await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/payment`, { payment: 'unpaid' })).status, 400);
        // Marked paid again: this period's price is owed at once, and only once however often it is switched.
        const marked = await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/payment`, { payment: 'paid' });
        assert.equal(marked.body.tenant.balance.charged, now.charged + 40000);
        await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/payment`, { payment: 'free' });
        await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/payment`, { payment: 'paid' });
        assert.equal((await bill()).charged, now.charged + 40000);
    });
});
