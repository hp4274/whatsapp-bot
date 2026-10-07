/**
 * The plan catalogue, as configuration.
 *
 * Phase 15 is explicit that plans must not be hard-coded inside business
 * logic.  So this file holds *data* only: no plan name appears in a condition
 * anywhere in `store.js` or `routes.js`, and an operator can override any of
 * these rows in the `plans` table without a deploy (the row wins - see
 * `BillingStore.getPlan`).
 *
 * `null` for a limit means unlimited.  It is deliberately not `Infinity` or
 * `-1`: null survives JSON, SQLite and a JSON.parse round trip unchanged, and
 * `limit === null` reads as "there is no limit" rather than as arithmetic.
 *
 * `tier` orders the ladder, and it is a stored number rather than something
 * inferred from the limits.  Inference is where this goes wrong: a plan with
 * more messages but fewer agents is not obviously an upgrade, and the answer
 * decides whether a change applies now or at period end (see `changePlan`).
 * An operator adding a plan says where on the ladder it sits.
 */

/** Feature entitlements a plan can grant. */
export const FEATURES = Object.freeze(['campaigns', 'workflows', 'faq', 'tickets', 'api', 'ai']);

/**
 * Metered metric -> the plan limit key that caps it.
 *
 * The metric names are the ones Phase 15 lists, the limit keys are the ones a
 * plan carries, and this map is the only place the two spellings meet.
 */
export const METRIC_LIMITS = Object.freeze({
    channels: 'channels',
    contacts: 'contacts',
    messages: 'messagesPerMonth',
    workflow_runs: 'workflowRuns',
    campaigns: 'campaigns',
    agents: 'agents',
    storage_mb: 'storageMb',
    api_requests: 'apiRequests',
});

export const METRICS = Object.freeze(Object.keys(METRIC_LIMITS));

/**
 * Metrics that are a *stock* (how many exist right now) rather than a *flow*
 * (how many happened this period).  A stock is written with `set()`, a flow is
 * accumulated with `record()`.  Incrementing a stock is how you end up
 * refusing a channel to a tenant who deleted two.
 */
export const STOCK_METRICS = Object.freeze(['channels', 'contacts', 'agents', 'storage_mb']);

/** The one metric the database can re-derive from scratch; see `recount`. */
export const RECOUNTABLE_METRICS = Object.freeze(['messages']);

export const DEFAULT_PLANS = Object.freeze({
    starter: {
        key: 'starter',
        name: 'Starter',
        tier: 1,
        limits: {
            channels: 1,
            contacts: 1000,
            messagesPerMonth: 1000,
            workflowRuns: 500,
            campaigns: 2,
            agents: 2,
            storageMb: 500,
            apiRequests: 0,
        },
        features: {
            campaigns: true,
            workflows: false,
            faq: true,
            tickets: false,
            api: false,
            ai: false,
        },
    },
    business: {
        key: 'business',
        name: 'Business',
        tier: 2,
        limits: {
            channels: 5,
            contacts: 25000,
            messagesPerMonth: 25000,
            workflowRuns: 25000,
            campaigns: 50,
            agents: 15,
            storageMb: 10000,
            apiRequests: 100000,
        },
        features: {
            campaigns: true,
            workflows: true,
            faq: true,
            tickets: true,
            api: true,
            ai: false,
        },
    },
    enterprise: {
        key: 'enterprise',
        name: 'Enterprise',
        tier: 3,
        // Unlimited across the board; the contract is the limit, not the code.
        limits: {
            channels: null,
            contacts: null,
            messagesPerMonth: null,
            workflowRuns: null,
            campaigns: null,
            agents: null,
            storageMb: null,
            apiRequests: null,
        },
        features: {
            campaigns: true,
            workflows: true,
            faq: true,
            tickets: true,
            api: true,
            ai: true,
        },
    },
});

/** Every limit key a plan carries, in catalogue order. */
export const LIMIT_KEYS = Object.freeze(Object.keys(DEFAULT_PLANS.starter.limits));

/**
 * Fill in anything a stored or posted plan left out, so every consumer can
 * read `plan.limits.contacts` without a guard.  A missing limit is unlimited
 * and a missing feature is off: the generous default on limits and the mean
 * one on features are both the safe direction - an unset limit should not
 * block a paying tenant, an unset feature should not be given away.
 */
export function normalizePlan(plan = {}) {
    const limits = {};
    for (const key of LIMIT_KEYS) {
        const value = plan.limits?.[key];
        limits[key] = value === null || value === undefined || value === '' ? null : Math.max(0, Number(value) || 0);
    }
    const features = {};
    for (const feature of FEATURES) features[feature] = Boolean(plan.features?.[feature]);
    return {
        key: String(plan.key ?? '').trim(),
        name: String(plan.name ?? plan.key ?? '').trim(),
        tier: Number(plan.tier) || 0,
        limits,
        features,
    };
}
