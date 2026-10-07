/**
 * Phase 15 routes. Mounted per channel like every other module router, so
 * `db` is already tenant- (and channel-) scoped and the store filters by
 * tenant underneath.
 *
 * Nothing here talks to a payment provider, and that is a product decision
 * rather than a gap: this phase sells plans, entitlements and meters. Taking
 * money is a later phase and will hang off `subscribe`/`changePlan` without
 * changing a line of the limit logic.
 *
 * `/billing/plans` write access is *platform* configuration (ARCHITECTURE.md
 * §8) - the catalogue belongs to the operator, not to a tenant. The router
 * exposes it; the app is expected to gate POST/DELETE on `/billing/plans` to
 * `super_admin`, the way it gates the rest of the control plane.
 */

import express from 'express';

import { BillingError, BillingStore, periodOf } from './store.js';

export function createBillingRouter({ db, state }) {
    const router = express.Router();
    const billing = new BillingStore(db);

    const fail = (res, err) => {
        if (!(err instanceof BillingError)) throw err;
        return res.status(err.status).json({ errors: [err.message] });
    };
    const announce = (subscription) => state?.broadcast?.({ type: 'subscription', subscription });

    // ---------------------------------------------------------------- plans --
    router.get('/billing/plans', (req, res) => {
        res.json({ plans: billing.plans() });
    });

    /** Operator override of a catalogue entry. Gate to super_admin. */
    router.post('/billing/plans', (req, res) => {
        try {
            return res.status(201).json({ plan: billing.savePlan(req.body ?? {}) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.delete('/billing/plans/:key', (req, res) => {
        try {
            // A catalogue key reverts to its constant, so this is a 200 with
            // the plan that is now in force rather than a 204.
            return res.json({ plan: billing.removePlan(req.params.key) });
        } catch (err) {
            return fail(res, err);
        }
    });

    // --------------------------------------------------------- subscription --
    router.get('/billing/subscription', (req, res) => {
        res.json({ subscription: billing.subscription() });
    });

    /**
     * Subscribe or change plan. One route, because the caller is pressing the
     * same button either way and the store already knows whether a row exists.
     */
    router.post('/billing/subscription', (req, res) => {
        const body = req.body ?? {};
        const planKey = body.planKey ?? body.plan_key ?? body.plan;
        try {
            const existing = billing.subscription();
            const subscription = existing
                ? billing.changePlan(planKey)
                : billing.subscribe(db.tenantId, planKey, {
                    startsAt: body.startsAt ?? body.starts_at ?? null,
                    trialEndsAt: body.trialEndsAt ?? body.trial_ends_at ?? null,
                });
            announce(subscription);
            return res.status(existing ? 200 : 201).json({ subscription });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.delete('/billing/subscription', (req, res) => {
        // Immediate cancellation has to be asked for explicitly: the default
        // leaves the tenant the period they already paid for.
        const immediate = req.query.immediate === 'true' || req.query.atPeriodEnd === 'false';
        try {
            const subscription = billing.cancel({ atPeriodEnd: !immediate });
            announce(subscription);
            return res.json({ subscription });
        } catch (err) {
            return fail(res, err);
        }
    });

    // ---------------------------------------------------------------- usage --
    router.get('/billing/usage', (req, res) => {
        const period = String(req.query.period ?? periodOf(new Date()));
        if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ errors: ['period must be YYYY-MM'] });
        return res.json({ usage: billing.usage({ period }) });
    });

    router.get('/billing/usage/history', (req, res) => {
        res.json({ history: billing.history({ months: Number(req.query.months) || 6 }) });
    });

    /** Repair a drifted counter from the messages table. */
    router.post('/billing/recount', (req, res) => {
        const period = String(req.body?.period ?? req.query.period ?? periodOf(new Date()));
        if (!/^\d{4}-\d{2}$/.test(period)) return res.status(400).json({ errors: ['period must be YYYY-MM'] });
        return res.json({ recount: billing.recount({ period }) });
    });

    return router;
}
