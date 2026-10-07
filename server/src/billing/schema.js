/**
 * Tables for plans, subscriptions and metered usage.
 *
 * `plans` has no `tenant_id`: a plan is platform configuration, the operator's
 * to edit, and invisible as a writable thing to tenants (ARCHITECTURE.md §8).
 * It exists so the catalogue in `plans.js` can be overridden without a deploy;
 * an empty table is the normal state.
 *
 * `subscriptions` is keyed by `tenant_id`, not by an id: a tenant has exactly
 * one subscription at a time.  Subscription history is the audit log's job,
 * and a second active row is a billing bug waiting to happen rather than a
 * feature.
 *
 * `usage_counters` is one row per (tenant, period, metric).  The period is a
 * `YYYY-MM` string rather than two timestamps because that is both the bucket
 * the UI shows and the bucket a monthly limit is measured in - keeping them
 * the same thing means a limit can never straddle two buckets.
 */

export const BILLING_SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
    key        TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    tier       INTEGER NOT NULL DEFAULT 0,
    -- JSON blobs, because the shape is the plan catalogue's business and a
    -- column per limit would mean a migration every time one is added.
    limits     TEXT NOT NULL DEFAULT '{}',
    features   TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
    tenant_id            INTEGER PRIMARY KEY,
    plan_key             TEXT NOT NULL,
    -- 'trialing' | 'active' | 'cancelled'. The *effective* state (grace,
    -- expired) is derived from the dates below, never stored: a stored state
    -- needs a cron job to stay true, and a cron job that misfires cuts a
    -- paying customer off.
    status               TEXT NOT NULL DEFAULT 'active',
    starts_at            TEXT NOT NULL,
    trial_ends_at        TEXT,
    -- Start of the next calendar month, i.e. when a scheduled downgrade and a
    -- period-end cancellation take effect and the usage bucket rolls over.
    current_period_end   TEXT NOT NULL,
    -- A downgrade waiting for the period to end. NULL = nothing scheduled.
    pending_plan_key     TEXT,
    cancel_at_period_end INTEGER NOT NULL DEFAULT 0,
    cancelled_at         TEXT,
    created_at           TEXT NOT NULL,
    updated_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_counters (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER NOT NULL,
    period     TEXT NOT NULL,
    metric     TEXT NOT NULL,
    value      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (tenant_id, period, metric)
);
CREATE INDEX IF NOT EXISTS idx_usage_counters_period ON usage_counters(tenant_id, period);
`;
