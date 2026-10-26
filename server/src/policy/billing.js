/**
 * Plan quota overrides. See `index.js` for the field shape. Null (the default)
 * keeps the plan's own limit (`plan.limits`), so an empty policy table meters
 * exactly as before; a number replaces it, and 0 lifts it. A tenant with no
 * subscription stays unmetered whatever is set here (billing/store.js rule 3).
 */

import { METRIC_LIMITS } from '../billing/plans.js';

const S = 'account';
const G = 'Quotas';

/** Metered metric -> the policy field that overrides its plan limit. */
export const BILLING_FIELDS = Object.freeze({
    messages: 'billing.messagesPerMonth',
    api_requests: 'billing.apiRequestsPerMonth',
    storage_mb: 'billing.storageMb',
});

export const BILLING_POLICY = Object.freeze([
    { key: 'billing.messagesPerMonth', service: S, group: G, type: 'int', default: null, nullLabel: 'Plan limit',
      min: 0, max: 100000000, unlimitedAt: 0,
      label: 'Messages per month', hint: 'Every message the business sends, per calendar month (UTC). 0 = no limit.' },
    { key: 'billing.apiRequestsPerMonth', service: S, group: G, type: 'int', default: null, nullLabel: 'Plan limit',
      min: 0, max: 100000000, unlimitedAt: 0,
      label: 'API requests per month', hint: 'Calls to the public API. 0 = no limit.' },
    { key: 'billing.storageMb', service: S, group: G, type: 'int', default: null, nullLabel: 'Plan limit',
      min: 0, max: 10000000, unlimitedAt: 0,
      label: 'Storage (MB)', hint: 'Uploaded media and contact sheets together. 0 = no limit.' },
]);

/** The effective cap on `metric`: the policy override, else the plan's limit. Null = unlimited. */
export function billingLimit(metric, planLimits = {}, values = {}) {
    const override = values?.[BILLING_FIELDS[metric]];
    if (override !== null && override !== undefined) return Number(override) === 0 ? null : Number(override);
    return planLimits?.[METRIC_LIMITS[metric]] ?? null;
}
