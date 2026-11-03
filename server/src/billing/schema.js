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
    -- Price, trial, services and tenant limits; see migratePlans.
    details    TEXT NOT NULL DEFAULT '{}',
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
    -- How the business pays: 'paid' (charged for its plan and top-ups) | 'free'. NULL = never recorded, billed as paid.
    payment              TEXT,
    -- When the plan stops (then GRACE_DAYS of grace, then expired). NULL = no end date: it renews monthly.
    valid_until          TEXT,
    -- Extra messages bought for one period (YYYY-MM) on top of the plan's monthly quota.
    topup_messages       INTEGER NOT NULL DEFAULT 0,
    topup_period         TEXT,
    -- What this business pays on a plan with no list price (Enterprise, custom), per the plan's interval. NULL = none agreed.
    custom_price         INTEGER,
    -- How often this business is billed: 'month' | 'quarter' | 'year'. NULL = the plan's own interval.
    billing_cycle        TEXT,
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

-- Charges (a plan put on or renewed, a top-up) and the payments the super admin records against them (ledger.js).
CREATE TABLE IF NOT EXISTS billing_ledger (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id  INTEGER NOT NULL,
    kind       TEXT NOT NULL,            -- 'plan' | 'topup' | 'payment'
    amount     INTEGER NOT NULL,         -- whole units of currency, always above 0
    currency   TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    method     TEXT NOT NULL DEFAULT '', -- a payment's: 'upi' | 'bank' | 'cash' (ledger.js PAYMENT_METHODS)
    at         TEXT NOT NULL,            -- when it was charged or paid
    created_by INTEGER,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_billing_ledger_tenant ON billing_ledger(tenant_id, at);
`;

/**
 * `details` came after `plans` shipped: description, price, currency,
 * interval, trialDays, services, tenantLimits and active.  One JSON column for
 * the same reason as `limits` - the commercial fields are the catalogue's
 * shape, not the database's.
 */
export function migratePlans(db) {
    const cols = db.prepare('PRAGMA table_info(plans)').all().map((c) => c.name);
    if (!cols.includes('details')) db.exec("ALTER TABLE plans ADD COLUMN details TEXT NOT NULL DEFAULT '{}'");
    const subs = db.prepare('PRAGMA table_info(subscriptions)').all().map((c) => c.name);
    if (!subs.includes('payment')) db.exec('ALTER TABLE subscriptions ADD COLUMN payment TEXT');
    if (!subs.includes('valid_until')) db.exec('ALTER TABLE subscriptions ADD COLUMN valid_until TEXT');
    if (!subs.includes('topup_messages')) db.exec('ALTER TABLE subscriptions ADD COLUMN topup_messages INTEGER NOT NULL DEFAULT 0');
    if (!subs.includes('topup_period')) db.exec('ALTER TABLE subscriptions ADD COLUMN topup_period TEXT');
    if (!subs.includes('custom_price')) db.exec('ALTER TABLE subscriptions ADD COLUMN custom_price INTEGER');
    if (!subs.includes('billing_cycle')) db.exec('ALTER TABLE subscriptions ADD COLUMN billing_cycle TEXT');
    const ledger = db.prepare('PRAGMA table_info(billing_ledger)').all().map((c) => c.name);
    if (ledger.length && !ledger.includes('method')) db.exec("ALTER TABLE billing_ledger ADD COLUMN method TEXT NOT NULL DEFAULT ''");
    // 'unpaid' is gone: what is owed is now the payments ledger's balance, so an unpaid business is a paying one.
    db.exec("UPDATE subscriptions SET payment = 'paid' WHERE payment = 'unpaid'");
}

/** How a business pays: 'paid' is charged for its plan and top-ups (ledger.js), 'free' is not. The plan's state is what is enforced. */
export const PAYMENTS = Object.freeze(['paid', 'free']);
