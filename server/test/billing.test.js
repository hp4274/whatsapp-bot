/**
 * Phase 15: plans, entitlements and metered usage.
 *
 * The claims under test: the plan catalogue is configuration and a stored row
 * beats the constant; an upgrade applies now and a downgrade waits for the
 * period to end; a cancelled subscription keeps working through its grace
 * window and stops after it; a tenant with no subscription is not gated at
 * all; stock metrics are set and flow metrics accumulate; `recount` repairs a
 * drifted message counter from the `messages` table; and one tenant can
 * neither read nor write another's billing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import express from 'express';

import { Database } from '../src/db.js';
import { createBillingRouter } from '../src/billing/routes.js';
import { BILLING_SCHEMA } from '../src/billing/schema.js';
import { DEFAULT_PLANS, METRICS, normalizePlan } from '../src/billing/plans.js';
import { BillingError, BillingStore, GRACE_DAYS, periodEnd, periodOf } from '../src/billing/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-billing-'));
let db;
let clock = new Date('2026-10-08T10:00:00Z');
const now = () => clock;
const at = (iso) => { clock = new Date(iso); };

let A; // tenant 1, subscribed
let B; // tenant 2, subscribed
let C; // tenant 3, never subscribed

before(() => {
    db = new Database(path.join(tmp, 'b.db'));
    db.db.exec(BILLING_SCHEMA);
    for (const id of [2, 3]) {
        db.db.prepare('INSERT INTO tenants (id, name, slug, status, created_at) VALUES (?, ?, ?, \'active\', ?)')
            .run(id, `T${id}`, `t${id}`, '2026-01-01T00:00:00+00:00');
    }
    A = new BillingStore(db.forTenant(1), { now });
    B = new BillingStore(db.forTenant(2), { now });
    C = new BillingStore(db.forTenant(3), { now });
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the plan catalogue', () => {
    it('serves the constants, ordered by tier', () => {
        const plans = A.plans();
        assert.deepEqual(plans.map((p) => p.key), ['starter', 'business', 'enterprise']);
        assert.equal(plans[0].name, 'Starter');
        // null is unlimited, and it survives the round trip as null.
        assert.equal(A.getPlan('enterprise').limits.messagesPerMonth, null);
        assert.equal(A.getPlan('starter').limits.messagesPerMonth, 1000);
        assert.equal(A.getPlan('nope'), null);
    });

    it('lets a stored row override the constant, and reverts when dropped', () => {
        const starter = DEFAULT_PLANS.starter;
        A.savePlan({ ...starter, limits: { ...starter.limits, messagesPerMonth: 5 }, features: { ...starter.features, api: true } });
        assert.equal(A.getPlan('starter').limits.messagesPerMonth, 5);
        assert.equal(A.getPlan('starter').features.api, true);
        // Overrides are platform-level, so every tenant sees the same one.
        assert.equal(B.getPlan('starter').limits.messagesPerMonth, 5);

        A.removePlan('starter');
        assert.equal(A.getPlan('starter').limits.messagesPerMonth, 1000);
    });

    it('accepts an operator-only plan and rejects a bad key', () => {
        A.savePlan({ key: 'pilot', name: 'Pilot', tier: 0, limits: { messagesPerMonth: 10 }, features: { faq: true } });
        assert.deepEqual(A.plans().map((p) => p.key), ['pilot', 'starter', 'business', 'enterprise']);
        // Unset limits are unlimited, unset features are off.
        assert.equal(A.getPlan('pilot').limits.contacts, null);
        assert.equal(A.getPlan('pilot').features.campaigns, false);

        assert.throws(() => A.savePlan({ key: 'Bad Key', name: 'x' }), BillingError);
        assert.throws(() => A.savePlan({ key: 'ok', name: '' }), BillingError);
        assert.throws(() => A.removePlan('ghost'), /not found/);
        A.removePlan('pilot');
    });

    it('normalizes every plan to the same shape', () => {
        const plan = normalizePlan({ key: 'x', limits: { contacts: '42' } });
        assert.equal(plan.name, 'x');
        assert.equal(plan.limits.contacts, 42);
        assert.equal(plan.limits.channels, null);
        assert.equal(Object.values(plan.features).every((v) => v === false), true);
    });
});

describe('a tenant with no subscription', () => {
    it('is not gated, so billing can be wired in without a migration', () => {
        assert.equal(C.subscription(), null);
        assert.equal(C.limitFor('messages'), null);
        assert.equal(C.entitled('ai'), true);
        const check = C.check('messages', 5000);
        assert.equal(check.allowed, true);
        assert.equal(check.limit, null);
        assert.equal(check.reason, null);
        assert.throws(() => C.changePlan('business'), /no subscription/);
    });
});

describe('subscribing', () => {
    it('puts the tenant on a plan for the calendar month', () => {
        at('2026-10-08T10:00:00Z');
        const sub = A.subscribe(1, 'starter');
        assert.equal(sub.planKey, 'starter');
        assert.equal(sub.status, 'active');
        assert.equal(sub.state, 'active');
        assert.equal(sub.period, '2026-10');
        assert.equal(sub.currentPeriodEnd, periodEnd('2026-10'));
        assert.equal(sub.pendingPlanKey, null);
        assert.equal(sub.graceEndsAt, null);
        assert.equal(sub.plan.limits.messagesPerMonth, 1000);
    });

    it('marks a trial and refuses an unknown plan', () => {
        const sub = B.subscribe(2, 'business', { trialEndsAt: '2026-10-20T00:00:00Z' });
        assert.equal(sub.status, 'trialing');
        assert.equal(sub.state, 'trialing');
        assert.equal(sub.entitled, undefined);
        assert.equal(B.entitled('tickets'), true);
        assert.throws(() => B.subscribe(2, 'ghost'), /unknown plan/);
    });

    it('refuses to subscribe another tenant through this handle', () => {
        assert.throws(() => A.subscribe(2, 'enterprise'), /another tenant/);
    });
});

describe('entitlements and limits', () => {
    it('answers per feature from the plan, not from a hard-coded name', () => {
        assert.equal(A.entitled('campaigns'), true);   // starter sells it
        assert.equal(A.entitled('workflows'), false);  // starter does not
        assert.equal(A.entitled('not_a_feature'), false);
    });

    it('allows up to the limit and refuses past it', () => {
        at('2026-10-08T10:00:00Z');
        A.record('messages', 995);
        const ok = A.check('messages', 5);
        assert.equal(ok.allowed, true);
        assert.equal(ok.used, 995);
        assert.equal(ok.remaining, 5);

        const over = A.check('messages', 6);
        assert.equal(over.allowed, false);
        assert.equal(over.reason, 'limit_reached');
        assert.equal(over.limit, 1000);

        // A zero limit refuses everything without a special case.
        assert.equal(A.check('api_requests', 1).allowed, false);
        // An unlimited plan has no ceiling to hit.
        assert.equal(B.check('messages', 10 ** 9).allowed, false); // business is capped
        A.changePlan('enterprise');
        assert.equal(A.check('messages', 10 ** 9).allowed, true);
        assert.equal(A.limitFor('messages'), null);
        A.subscribe(1, 'starter'); // back to the starter fixture
    });

    it('treats an unmetered metric as unlimited', () => {
        assert.equal(A.limitFor('something_else'), null);
    });
});

describe('usage counters', () => {
    it('accumulates a flow metric and overwrites a stock one', () => {
        at('2026-11-02T09:00:00Z');
        assert.equal(A.record('workflow_runs', 3), 3);
        assert.equal(A.record('workflow_runs'), 4);
        assert.equal(A.set('contacts', 120), 120);
        assert.equal(A.set('contacts', 90), 90); // a stock can go down
        assert.throws(() => A.record('contacts'), /stock metric/);
        assert.throws(() => A.record('nonsense'), /unknown metric/);
    });

    it('buckets by calendar month', () => {
        at('2026-11-02T09:00:00Z');
        const november = A.usage();
        assert.equal(november.period, '2026-11');
        const runs = november.metrics.find((m) => m.metric === 'workflow_runs');
        assert.equal(runs.used, 4);
        assert.equal(runs.limit, 500);
        assert.equal(runs.remaining, 496);
        // October's 995 messages did not follow the tenant into November.
        assert.equal(november.metrics.find((m) => m.metric === 'messages').used, 0);
        assert.equal(A.usage({ period: '2026-10' }).metrics.find((m) => m.metric === 'messages').used, 995);
        assert.equal(november.metrics.length, METRICS.length);
    });

    it('reports history newest first', () => {
        at('2026-11-02T09:00:00Z');
        const history = A.history({ months: 3 });
        assert.deepEqual(history.map((h) => h.period), ['2026-11', '2026-10', '2026-09']);
        assert.equal(history[0].metrics.workflow_runs, 4);
        assert.equal(history[1].metrics.messages, 995);
        assert.deepEqual(history[2].metrics, {});
    });
});

describe('recount', () => {
    it('rebuilds the message counter from the messages table', () => {
        at('2026-12-05T12:00:00Z');
        const scoped = db.forTenant(1);
        for (const i of [1, 2, 3]) {
            scoped.insert({
                messageId: `rc${i}`, recipient: '911', message: 'hi',
                status: 'SENT', createdAt: '2026-12-02T08:00:00+00:00',
            });
        }
        // Not a real send, so it must not count towards the plan.
        scoped.insert({
            messageId: 'rc-sandbox', recipient: '911', message: 'hi',
            status: 'SANDBOX', createdAt: '2026-12-02T08:00:00+00:00',
        });
        // A counter that drifted high, which is the case that costs money.
        A.record('messages', 99);

        const result = A.recount({ period: '2026-12' });
        assert.equal(result.period, '2026-12');
        assert.deepEqual(result.repaired.messages, { was: 99, now: 3 });
        assert.equal(A.check('messages').used, 3);
        // A period with no messages recounts to zero rather than being left alone.
        A.record('messages', 7);
        at('2027-01-04T12:00:00Z');
        assert.equal(A.recount().repaired.messages.now, 0);
    });
});

describe('changing plan', () => {
    it('applies an upgrade immediately', () => {
        at('2027-02-03T10:00:00Z');
        A.subscribe(1, 'starter');
        const sub = A.changePlan('business');
        assert.equal(sub.planKey, 'business');
        assert.equal(sub.pendingPlanKey, null);
        assert.equal(A.entitled('workflows'), true);
        assert.equal(A.limitFor('messages'), 25000);
    });

    it('holds a downgrade until the period ends', () => {
        at('2027-02-03T10:00:00Z');
        const sub = A.changePlan('starter');
        // Still on business: they paid for this month's ceiling.
        assert.equal(sub.planKey, 'business');
        assert.equal(sub.pendingPlanKey, 'starter');
        assert.equal(A.entitled('workflows'), true);
        assert.equal(A.limitFor('messages'), 25000);

        at('2027-03-01T00:00:01Z');
        const rolled = A.subscription();
        assert.equal(rolled.planKey, 'starter');
        assert.equal(rolled.pendingPlanKey, null);
        assert.equal(rolled.currentPeriodEnd, periodEnd('2027-03'));
        assert.equal(A.entitled('workflows'), false);
    });

    it('cancels a scheduled downgrade when the current plan is re-selected', () => {
        at('2027-03-02T10:00:00Z');
        A.subscribe(1, 'business');
        assert.equal(A.changePlan('starter').pendingPlanKey, 'starter');
        assert.equal(A.changePlan('business').pendingPlanKey, null);
        assert.equal(A.subscription().planKey, 'business');
    });
});

describe('cancellation and grace', () => {
    it('runs to the end of the paid period, then grace, then stops', () => {
        at('2027-04-02T10:00:00Z');
        A.subscribe(1, 'business');
        const cancelled = A.cancel();
        assert.equal(cancelled.cancelAtPeriodEnd, true);
        assert.equal(cancelled.state, 'active');
        assert.equal(A.entitled('workflows'), true);

        // Period over: cancelled, but inside the grace window.
        at('2027-05-01T00:00:01Z');
        const grace = A.subscription();
        assert.equal(grace.status, 'cancelled');
        assert.equal(grace.state, 'grace');
        assert.equal(grace.cancelledAt, periodEnd('2027-04'));
        assert.equal(grace.graceEndsAt, new Date(Date.parse(periodEnd('2027-04')) + GRACE_DAYS * 86400000).toISOString());
        // Grace is the whole point: features keep working, so a failed renewal
        // is a conversation rather than an outage.
        assert.equal(A.entitled('workflows'), true);
        assert.equal(A.check('messages', 10).allowed, true);

        at('2027-05-20T00:00:00Z');
        const dead = A.subscription();
        assert.equal(dead.state, 'expired');
        assert.equal(A.entitled('workflows'), false);
        const check = A.check('messages', 1);
        assert.equal(check.allowed, false);
        assert.equal(check.reason, 'subscription_expired');
        // Reading their own data is not gated by any of this - usage and the
        // subscription itself still answer.
        assert.equal(A.usage().period, '2027-05');
    });

    it('cancels on the spot when asked, and grace runs from then', () => {
        at('2027-06-02T10:00:00Z');
        A.subscribe(1, 'business');
        const sub = A.cancel({ atPeriodEnd: false });
        assert.equal(sub.status, 'cancelled');
        assert.equal(sub.state, 'grace');
        assert.equal(sub.cancelledAt, '2027-06-02T10:00:00.000Z');
        at('2027-06-12T10:00:00Z');
        assert.equal(A.subscription().state, 'expired');
    });

    it('expires a trial that nobody converted, after grace', () => {
        at('2027-07-01T10:00:00Z');
        B.subscribe(2, 'business', { trialEndsAt: '2027-07-10T00:00:00Z' });
        assert.equal(B.subscription().state, 'trialing');
        at('2027-07-12T10:00:00Z');
        assert.equal(B.subscription().state, 'grace');
        assert.equal(B.entitled('tickets'), true);
        at('2027-07-20T10:00:00Z');
        assert.equal(B.subscription().state, 'expired');
        assert.equal(B.entitled('tickets'), false);
        // Upgrading out of a dead trial revives it immediately.
        assert.equal(B.changePlan('enterprise').state, 'active');
    });
});

describe('tenant isolation', () => {
    it('keeps subscriptions and counters apart', () => {
        at('2027-08-02T10:00:00Z');
        A.subscribe(1, 'starter');
        B.subscribe(2, 'enterprise');
        A.record('campaigns', 2);
        B.record('campaigns', 9);

        assert.equal(A.subscription().planKey, 'starter');
        assert.equal(B.subscription().planKey, 'enterprise');
        assert.equal(A.check('campaigns').used, 2);
        assert.equal(B.check('campaigns').used, 9);
        assert.equal(A.limitFor('campaigns'), 2);
        assert.equal(B.limitFor('campaigns'), null);
        assert.equal(C.subscription(), null);

        const rows = db.db.prepare('SELECT tenant_id, value FROM usage_counters WHERE period = ? AND metric = ? ORDER BY tenant_id')
            .all('2027-08', 'campaigns')
            .map((r) => [r.tenant_id, r.value]);
        assert.deepEqual(rows, [[1, 2], [2, 9]]);
    });
});

describe('the HTTP surface', () => {
    let server;
    let base;
    const events = [];

    before(async () => {
        at('2027-09-02T10:00:00Z');
        const app = express();
        app.use(express.json());
        app.use('/api', createBillingRouter({
            db: db.forTenant(3).forChannel(1),
            state: { channel: { id: 1 }, broadcast: (event) => events.push(event) },
        }));
        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${server.address().port}/api`;
    });

    after(() => server?.close());

    const call = async (method, url, body) => {
        const res = await fetch(`${base}${url}`, {
            method,
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: res.status === 204 ? null : await res.json() };
    };

    it('lists plans and takes an operator override', async () => {
        assert.equal((await call('GET', '/billing/plans')).body.plans.length, 3);
        const made = await call('POST', '/billing/plans', {
            key: 'trial', name: 'Trial', tier: 0, limits: { messagesPerMonth: 10 }, features: { faq: true },
        });
        assert.equal(made.status, 201);
        assert.equal(made.body.plan.limits.messagesPerMonth, 10);
        assert.equal((await call('GET', '/billing/plans')).body.plans.length, 4);
        assert.equal((await call('POST', '/billing/plans', { key: 'X X', name: 'x' })).status, 400);
        assert.equal((await call('DELETE', '/billing/plans/trial')).status, 200);
        assert.equal((await call('DELETE', '/billing/plans/trial')).status, 404);
    });

    it('subscribes, changes plan and cancels', async () => {
        assert.equal((await call('GET', '/billing/subscription')).body.subscription, null);

        const created = await call('POST', '/billing/subscription', { planKey: 'starter' });
        assert.equal(created.status, 201);
        assert.equal(created.body.subscription.planKey, 'starter');
        assert.equal(events.at(-1).type, 'subscription');

        const upgraded = await call('POST', '/billing/subscription', { planKey: 'enterprise' });
        assert.equal(upgraded.status, 200);
        assert.equal(upgraded.body.subscription.planKey, 'enterprise');
        assert.equal((await call('POST', '/billing/subscription', { planKey: 'ghost' })).status, 404);

        const cancelled = await call('DELETE', '/billing/subscription');
        assert.equal(cancelled.body.subscription.cancelAtPeriodEnd, true);
        const immediate = await call('DELETE', '/billing/subscription?immediate=true');
        assert.equal(immediate.body.subscription.status, 'cancelled');
    });

    it('reports usage, history and a recount', async () => {
        const usage = await call('GET', '/billing/usage');
        assert.equal(usage.body.usage.metrics.length, METRICS.length);
        assert.equal((await call('GET', '/billing/usage?period=october')).status, 400);
        assert.equal((await call('GET', '/billing/usage/history?months=2')).body.history.length, 2);

        const recount = await call('POST', '/billing/recount', { period: periodOf(new Date()) });
        assert.equal(recount.body.recount.repaired.messages.now, 0);
        assert.equal((await call('POST', '/billing/recount', { period: 'nope' })).status, 400);
    });
});
