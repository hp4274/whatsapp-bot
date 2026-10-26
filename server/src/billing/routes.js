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
 * Billing is view-only for a business: plan and subscription writes are
 * *platform* configuration (ARCHITECTURE.md §8) and live only on the
 * super-admin router in app.js (`/admin/billing/*`, `/admin/tenants/:id/subscription`).
 */

import express from 'express';

import { BillingStore, periodOf } from './store.js';

export function createBillingRouter({ db, state }) {
    const router = express.Router();
    // The runtime's store carries the admin's quota overrides, so usage shows the effective limits.
    const billing = state?.billing ?? new BillingStore(db);

    // ---------------------------------------------------------------- plans --
    router.get('/billing/plans', (req, res) => {
        res.json({ plans: billing.plans() });
    });

    // --------------------------------------------------------- subscription --
    router.get('/billing/subscription', (req, res) => {
        res.json({ subscription: billing.subscription() });
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
