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

import { numberCap } from '../policy/channelOps.js';
import { stricterCap } from '../templates/policy.js';
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

    /**
     * The business's own quota, for every plan: /billing/* needs the analytics
     * service, which the smallest plan does not sell, and that is the plan most
     * likely to hit its limits.  Adds the tenant limits a business also runs
     * into (templates, team seats), counted the way their routes enforce them.
     */
    router.get('/plan-usage', (req, res) => {
        const limits = state?.limits?.() ?? {};
        const row = (metric, used, cap) => {
            const limit = cap ? Number(cap) : null;
            return { metric, used, limit, remaining: limit === null ? null : Math.max(0, limit - used) };
        };
        const usage = billing.usage();
        const extra = [];
        if (state?.templates) {
            const cap = stricterCap(limits.maxTemplates, state.platformPolicy?.()?.['templates.maxTemplates']);
            extra.push(row('templates', state.templates.list().length, cap));
        }
        // Team seats: a disabled user holds none (app.js team routes), which is what agents counts.
        extra.push(row('users', billing.used('agents'), limits.maxUsers));
        // The admin's Limits and Plans editors set maxChannels, never the plan's billing `channels` / `contacts`
        // (which nothing enforces): show the cap adding a number really meets, and contacts uncapped.
        const subscription = billing.subscription();
        const enforced = { channels: numberCap(limits, state?.platformPolicy?.() ?? {}), contacts: null };
        const metrics = subscription?.state === 'expired' ? usage.metrics
            : usage.metrics.map((m) => (m.metric in enforced ? row(m.metric, m.used, enforced[m.metric]) : m));
        return res.json({ usage: { ...usage, metrics: [...metrics, ...extra] }, subscription });
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
