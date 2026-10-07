/**
 * Tables for the generic job scheduler.
 *
 * `kind` and `payload` are deliberately opaque: the scheduler runs jobs, it
 * does not know what a workflow or a payment reminder is. Whatever registers a
 * handler for a kind owns the meaning of that kind's payload.
 *
 * Timestamps are the same ISO-with-+00:00 strings the rest of the app stores,
 * which are fixed-width and therefore safe to compare with `<=` in SQL.
 */

export const SCHEDULER_SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_jobs (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id        INTEGER NOT NULL,
    kind             TEXT NOT NULL,
    payload          TEXT NOT NULL DEFAULT '{}',
    run_at           TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    attempt          INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    lease_until      TEXT,
    lease_owner      TEXT,
    last_error       TEXT,
    idempotency_key  TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
-- Partial index: a null key means "no dedupe", and many of those must coexist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_jobs_idem
    ON scheduled_jobs(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
    ON scheduled_jobs(status, run_at);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_lease
    ON scheduled_jobs(status, lease_until);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_tenant
    ON scheduled_jobs(tenant_id, status, kind);

CREATE TABLE IF NOT EXISTS scheduler_pauses (
    tenant_id  INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    paused_at  TEXT NOT NULL,
    PRIMARY KEY (tenant_id, kind)
);
`;
