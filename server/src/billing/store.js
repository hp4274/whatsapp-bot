/**
 * Plans, subscriptions and usage, scoped to one tenant.
 *
 * Three rules carry this module, and they are commercial rules rather than
 * technical ones:
 *
 *   1. **An upgrade applies immediately, a downgrade at period end.**  The
 *      tenant paid for this period's ceiling, so taking it away mid-month
 *      breaks a campaign they already started; raising it mid-month is what
 *      they just asked and paid for.  So `changePlan` writes the plan key for
 *      an upgrade and `pending_plan_key` for a downgrade.
 *   2. **Grace, not a cutoff.**  A lapsed subscription keeps its entitlements
 *      for `GRACE_DAYS`.  Cutting a business's WhatsApp off the instant a
 *      renewal fails is how you lose the customer instead of collecting the
 *      debt.  Past grace, writes stop - reads never did, because nothing in
 *      the read path calls `check` or `entitled`.
 *   3. **No subscription row means no gate.**  Every tenant that existed
 *      before billing did keeps working untouched, so the guards can be wired
 *      in without a migration.  Metering a tenant is opt-in by subscribing
 *      them.
 *
 * Plan entitlements are the tier *above* channel capabilities, and they
 * compose one way only: **the narrower of the two wins, always.**  A plan that
 * entitles `campaigns` does not switch the capability on for a channel whose
 * operator turned it off, and a channel with the capability cannot outrun a
 * plan that does not sell the feature.  Neither is a fallback for the other;
 * both must say yes.
 *
 * `record()`/`set()` keep counters, and a counter only ever drifts.  That is
 * what `recount()` is for - messages are re-derived from the `messages` table
 * through `db.countSentBetween`, which is the same counter the per-channel
 * daily cap reads (`campaign/safety.js`).  The two ceilings are deliberately
 * different questions: the daily cap is per channel per calendar day and
 * exists to keep a *number* from being banned; the plan limit is per tenant
 * per billing period and exists to sell a tier.  Whichever bites first wins,
 * and neither needs to know about the other.
 */

import { utcNow } from '../protocol.js';
import {
    DEFAULT_PLANS,
    FEATURES,
    METRICS,
    METRIC_LIMITS,
    RECOUNTABLE_METRICS,
    STOCK_METRICS,
    normalizePlan,
} from './plans.js';

/** How long a lapsed or cancelled subscription keeps working. */
export const GRACE_DAYS = 7;

export const SUBSCRIPTION_STATUSES = Object.freeze(['trialing', 'active', 'cancelled']);

export class BillingError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** The `YYYY-MM` bucket a date falls in. */
export const periodOf = (at = new Date()) => new Date(at).toISOString().slice(0, 7);

/** Midnight UTC on the first of `period` (`YYYY-MM`). */
export const periodStart = (period) => `${period}-01T00:00:00.000Z`;

/** Midnight UTC on the first of the month after `period`. */
export function periodEnd(period) {
    const [year, month] = period.split('-').map(Number);
    return new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1)).toISOString();
}

const days = (n) => n * 24 * 3600 * 1000;
const iso = (value) => (value ? new Date(value).toISOString() : null);

export class BillingStore {
    /** @param {import('../db.js').Database} database a tenant-scoped handle */
    constructor(database, { now = () => new Date() } = {}) {
        this.db = database.db;
        this.data = database; // the scoped handle, for countSentBetween
        this.tenantId = database.tenantId;
        this.now = now;
    }

    // ---------------------------------------------------------------- plans --
    /**
     * The catalogue: the constants, with any stored row replacing the one that
     * shares its key, plus operator-only plans that have no constant.
     */
    plans() {
        const merged = new Map(Object.entries(DEFAULT_PLANS).map(([key, plan]) => [key, normalizePlan(plan)]));
        for (const row of this.db.prepare('SELECT * FROM plans').all()) merged.set(row.key, toPlan(row));
        return [...merged.values()].sort((a, b) => a.tier - b.tier || a.key.localeCompare(b.key));
    }

    getPlan(key) {
        const clean = String(key ?? '').trim();
        if (!clean) return null;
        const row = this.db.prepare('SELECT * FROM plans WHERE key = ?').get(clean);
        if (row) return toPlan(row);
        return DEFAULT_PLANS[clean] ? normalizePlan(DEFAULT_PLANS[clean]) : null;
    }

    /** Operator override. Upsert, because "edit the starter plan" is a create. */
    savePlan(input) {
        const plan = normalizePlan(input);
        if (!/^[a-z0-9_-]+$/.test(plan.key)) throw new BillingError('plan key must be lowercase letters, digits, - or _');
        if (!plan.name) throw new BillingError('plan name is required');
        const now = utcNow();
        this.db.prepare(
            `INSERT INTO plans (key, name, tier, limits, features, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET
                name = excluded.name, tier = excluded.tier, limits = excluded.limits,
                features = excluded.features, updated_at = excluded.updated_at`)
            .run(plan.key, plan.name, plan.tier, JSON.stringify(plan.limits), JSON.stringify(plan.features), now, now);
        return this.getPlan(plan.key);
    }

    /** Drops the override. A catalogue key reverts to its constant, not to nothing. */
    removePlan(key) {
        const clean = String(key ?? '').trim();
        const info = this.db.prepare('DELETE FROM plans WHERE key = ?').run(clean);
        if (!info.changes && !DEFAULT_PLANS[clean]) throw new BillingError('plan not found', 404);
        return this.getPlan(clean);
    }

    // --------------------------------------------------------- subscription --
    /**
     * Put a tenant on a plan. `tenantId` is explicit because an operator calls
     * this for someone else - but only through `db.forTenant(id)`, so a
     * mismatch is a bug rather than a privilege.
     */
    subscribe(tenantId = this.tenantId, planKey, { startsAt = null, trialEndsAt = null } = {}) {
        if (Number(tenantId) !== Number(this.tenantId)) {
            throw new BillingError('subscription belongs to another tenant', 403);
        }
        const plan = this.getPlan(planKey);
        if (!plan) throw new BillingError('unknown plan', 404);

        const start = iso(startsAt) ?? this.now().toISOString();
        const trial = iso(trialEndsAt);
        const now = utcNow();
        this.db.prepare(
            `INSERT INTO subscriptions (tenant_id, plan_key, status, starts_at, trial_ends_at,
                                        current_period_end, pending_plan_key, cancel_at_period_end,
                                        cancelled_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)
             ON CONFLICT (tenant_id) DO UPDATE SET
                plan_key = excluded.plan_key, status = excluded.status, starts_at = excluded.starts_at,
                trial_ends_at = excluded.trial_ends_at, current_period_end = excluded.current_period_end,
                pending_plan_key = NULL, cancel_at_period_end = 0, cancelled_at = NULL,
                updated_at = excluded.updated_at`)
            .run(Number(tenantId), plan.key, trial ? 'trialing' : 'active', start, trial,
                periodEnd(periodOf(start)), now, now);
        return this.subscription();
    }

    /**
     * The live subscription, with the effective plan and state worked out.
     *
     * Reading is also when a rolled-over period is applied: a scheduled
     * downgrade or a period-end cancellation lands here rather than in a cron
     * job, because a job that does not run leaves a tenant on a plan they
     * stopped paying for and nobody notices for a month.
     */
    subscription() {
        let row = this.row();
        if (!row) return null;
        row = this.rollover(row);

        const plan = this.getPlan(row.plan_key) ?? normalizePlan({ key: row.plan_key, name: row.plan_key });
        const grace = this.graceEndsAt(row);
        const nowIso = this.now().toISOString();
        let state = row.status;
        if (row.status === 'cancelled' || (row.status === 'trialing' && row.trial_ends_at && row.trial_ends_at <= nowIso)) {
            state = grace && nowIso < grace ? 'grace' : 'expired';
        }
        return {
            tenantId: row.tenant_id,
            planKey: row.plan_key,
            plan,
            status: row.status,
            state,
            startsAt: row.starts_at,
            trialEndsAt: row.trial_ends_at,
            period: periodOf(this.now()),
            currentPeriodEnd: row.current_period_end,
            pendingPlanKey: row.pending_plan_key,
            cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
            cancelledAt: row.cancelled_at,
            graceEndsAt: grace,
        };
    }

    /**
     * Upgrade now, downgrade at period end - the whole point of the phase.
     * A lateral move (same tier) applies now: there is nothing to protect.
     */
    changePlan(key) {
        const row = this.rollover(this.require());
        const next = this.getPlan(key);
        if (!next) throw new BillingError('unknown plan', 404);
        const current = this.getPlan(row.plan_key);

        if (next.key === row.plan_key) {
            // Re-selecting the current plan cancels a scheduled downgrade,
            // which is exactly what a customer who changed their mind means.
            this.patch({ pending_plan_key: null });
            return this.subscription();
        }
        if (next.tier >= (current?.tier ?? 0)) {
            this.patch({ plan_key: next.key, pending_plan_key: null, status: 'active' });
        } else {
            this.patch({ pending_plan_key: next.key });
        }
        return this.subscription();
    }

    /** Default is at period end: they paid for the rest of the month. */
    cancel({ atPeriodEnd = true } = {}) {
        this.rollover(this.require());
        if (atPeriodEnd) this.patch({ cancel_at_period_end: 1 });
        else this.patch({ status: 'cancelled', cancelled_at: this.now().toISOString(), cancel_at_period_end: 0 });
        return this.subscription();
    }

    /**
     * When the grace window closes, or null while nothing has lapsed.
     * Counted from whichever end actually happened - the cancellation, or the
     * trial running out.
     */
    graceEndsAt(row = this.row()) {
        if (!row) return null;
        const from = row.status === 'cancelled'
            ? (row.cancelled_at ?? row.current_period_end)
            : (row.status === 'trialing' ? row.trial_ends_at : null);
        return from ? new Date(new Date(from).getTime() + days(GRACE_DAYS)).toISOString() : null;
    }

    // ---------------------------------------------------------------- usage --
    /** Accumulate a flow metric. Rejects a stock metric, which needs `set`. */
    record(metric, n = 1) {
        const clean = this.metric(metric);
        if (STOCK_METRICS.includes(clean)) {
            throw new BillingError(`${clean} is a stock metric; use set()`);
        }
        return this.write(clean, n, { add: true });
    }

    /**
     * Overwrite a stock metric with the count that exists right now.  Stocks
     * go down as well as up, so the caller that just counted them is the only
     * honest source.
     */
    set(metric, value) {
        return this.write(this.metric(metric), Math.max(0, Number(value) || 0), { add: false });
    }

    usage({ period = periodOf(this.now()) } = {}) {
        const counters = this.counters(period);
        return {
            period,
            planKey: this.subscription()?.planKey ?? null,
            metrics: METRICS.map((metric) => {
                const used = counters[metric] ?? 0;
                const limit = this.limitFor(metric);
                return { metric, used, limit, remaining: limit === null ? null : Math.max(0, limit - used) };
            }),
        };
    }

    /** Newest period first, so the UI does not have to reverse it. */
    history({ months = 6 } = {}) {
        const periods = [];
        const at = new Date(this.now());
        for (let i = 0; i < Math.max(1, Math.min(60, Number(months) || 6)); i += 1) {
            periods.push(periodOf(at));
            at.setUTCMonth(at.getUTCMonth() - 1, 1);
        }
        return periods.map((period) => ({ period, metrics: this.counters(period) }));
    }

    // ------------------------------------------------------------ decisions --
    /** The cap on `metric` under the effective plan; null = unlimited. */
    limitFor(metric) {
        const subscription = this.subscription();
        if (!subscription) return null; // billing not in use for this tenant
        const key = METRIC_LIMITS[String(metric)];
        if (!key) return null;
        return subscription.plan.limits[key] ?? null;
    }

    /**
     * May this tenant do `n` more of `metric`?  The one call a guard makes.
     * `reason` is null when allowed, so a caller can forward it straight into
     * an error message.
     */
    check(metric, n = 1) {
        const clean = this.metric(metric);
        const subscription = this.subscription();
        const used = this.counters(periodOf(this.now()))[clean] ?? 0;
        if (!subscription) return { allowed: true, limit: null, used, remaining: null, reason: null };
        if (subscription.state === 'expired') {
            return { allowed: false, limit: 0, used, remaining: 0, reason: 'subscription_expired' };
        }
        const limit = this.limitFor(clean);
        if (limit === null) return { allowed: true, limit: null, used, remaining: null, reason: null };
        const remaining = Math.max(0, limit - used);
        return {
            allowed: used + Math.max(0, Number(n) || 0) <= limit,
            limit,
            used,
            remaining,
            reason: used + Math.max(0, Number(n) || 0) <= limit ? null : 'limit_reached',
        };
    }

    /**
     * Does the plan sell this feature?  Still true during grace - grace is the
     * point.  Compose with the channel capability by requiring both; the
     * narrower of the two wins.
     */
    entitled(feature) {
        if (!FEATURES.includes(String(feature))) return false;
        const subscription = this.subscription();
        if (!subscription) return true; // no plan on file, no gate
        if (subscription.state === 'expired') return false;
        return Boolean(subscription.plan.features[feature]);
    }

    /**
     * Rebuild the message counter from the `messages` table.  An increment-only
     * counter drifts - a crash between the send and the `record`, a backfill, a
     * direct DELETE - and a drifted counter either sells a tenant short or
     * gives the product away.  Messages are the one metric the database can
     * re-derive, so they are authoritative-by-recount and everything else is
     * trusted as a counter.
     */
    recount({ period = periodOf(this.now()) } = {}) {
        const before = this.counters(period);
        const repaired = {};
        for (const metric of RECOUNTABLE_METRICS) {
            const value = this.data.countSentBetween(periodStart(period), periodEnd(period));
            this.write(metric, value, { add: false, period });
            repaired[metric] = { was: before[metric] ?? 0, now: value };
        }
        return { period, repaired };
    }

    // ----------------------------------------------------------- internals --
    row() {
        return this.db.prepare('SELECT * FROM subscriptions WHERE tenant_id = ?').get(this.tenantId) ?? null;
    }

    require() {
        const row = this.row();
        if (!row) throw new BillingError('this tenant has no subscription', 404);
        return row;
    }

    /** Apply anything the end of a period was waiting for, then re-read. */
    rollover(row) {
        if (!row || row.status === 'cancelled') return row;
        if (this.now().toISOString() < row.current_period_end) return row;

        const patch = { current_period_end: periodEnd(periodOf(this.now())) };
        if (row.pending_plan_key) {
            patch.plan_key = row.pending_plan_key;
            patch.pending_plan_key = null;
        }
        if (row.cancel_at_period_end) {
            patch.status = 'cancelled';
            patch.cancelled_at = row.current_period_end;
        }
        this.patch(patch);
        return this.row();
    }

    patch(fields) {
        const keys = Object.keys(fields);
        this.db.prepare(
            `UPDATE subscriptions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ?
             WHERE tenant_id = ?`).run(...keys.map((k) => fields[k]), utcNow(), this.tenantId);
    }

    metric(metric) {
        const clean = String(metric ?? '').trim();
        if (!METRICS.includes(clean)) throw new BillingError(`unknown metric ${clean || '(empty)'}`);
        return clean;
    }

    write(metric, value, { add, period = periodOf(this.now()) }) {
        this.db.prepare(
            `INSERT INTO usage_counters (tenant_id, period, metric, value, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (tenant_id, period, metric) DO UPDATE SET
                value = ${add ? 'MAX(0, usage_counters.value + excluded.value)' : 'excluded.value'},
                updated_at = excluded.updated_at`)
            .run(this.tenantId, period, metric, Math.trunc(Number(value) || 0), utcNow());
        return this.counters(period)[metric] ?? 0;
    }

    counters(period) {
        const out = {};
        for (const r of this.db.prepare('SELECT metric, value FROM usage_counters WHERE tenant_id = ? AND period = ?')
            .all(this.tenantId, period)) out[r.metric] = r.value;
        return out;
    }
}

function toPlan(row) {
    return normalizePlan({
        key: row.key,
        name: row.name,
        tier: row.tier,
        limits: parse(row.limits),
        features: parse(row.features),
    });
}

const parse = (value) => {
    try {
        return JSON.parse(value) ?? {};
    } catch {
        return {};
    }
};

export { METRICS, FEATURES };
