/**
 * Phase 6 tables. Listed in `MODULE_SCHEMAS` by `src/schema.js`.
 *
 * `workflow_versions` is immutable: a run pins the version it started on, so
 * editing a workflow never changes a run already in flight. `workflow_runs`
 * is the whole state of a run - no closure, no timer - which is what lets a
 * 24-hour wait survive a restart.
 */

export const WORKFLOWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS workflows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    channel_id INTEGER,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    version INTEGER NOT NULL DEFAULT 1,
    trigger TEXT NOT NULL,
    steps TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_tenant ON workflows(tenant_id, status);

CREATE TABLE IF NOT EXISTS workflow_versions (
    workflow_id INTEGER NOT NULL,
    version INTEGER NOT NULL,
    tenant_id INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    steps TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (workflow_id, version)
);

CREATE TABLE IF NOT EXISTS workflow_runs (
    run_id TEXT PRIMARY KEY,
    tenant_id INTEGER NOT NULL,
    workflow_id INTEGER NOT NULL,
    workflow_version INTEGER NOT NULL,
    contact_id INTEGER,
    channel_id INTEGER,
    status TEXT NOT NULL,
    current_step TEXT,
    context TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    resume_at TEXT,
    started_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT,
    error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_runs_key ON workflow_runs(tenant_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_due ON workflow_runs(status, resume_at);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_workflow ON workflow_runs(tenant_id, workflow_id, status);

CREATE TABLE IF NOT EXISTS workflow_run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    tenant_id INTEGER NOT NULL,
    step_id TEXT NOT NULL,
    action TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL,
    input TEXT,
    output TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run ON workflow_run_steps(run_id, id);

CREATE TABLE IF NOT EXISTS workflow_events (
    id TEXT NOT NULL,
    tenant_id INTEGER NOT NULL,
    channel_id INTEGER,
    type TEXT NOT NULL,
    subject_kind TEXT,
    subject_id TEXT,
    data TEXT NOT NULL,
    source TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS idx_workflow_events_tenant ON workflow_events(tenant_id, type, received_at);
`;
