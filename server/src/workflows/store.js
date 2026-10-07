/**
 * Workflow definitions and runs, scoped to one tenant.
 *
 * Definitions are versioned the way templates are: changing the trigger or
 * the steps writes a new immutable `workflow_versions` row and bumps
 * `workflows.version`. A run records the version it started on and reads its
 * steps from that row, never from the live definition, so an edit cannot
 * change a run already in flight.
 */

import crypto from 'node:crypto';

import { WORKFLOW_STATUSES, WorkflowError, matches, validateDefinition } from './definition.js';

export const RUN_STATUSES = Object.freeze(['running', 'waiting', 'completed', 'failed', 'stopped']);

export class WorkflowStore {
    /** @param {import('../db.js').Database} database a tenant-scoped handle */
    constructor(database, { now = () => new Date() } = {}) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.now = () => iso(now());
    }

    // -------------------------------------------------------- definitions --
    create({ name, channelId = null, status = 'draft', trigger, steps }) {
        const clean = String(name ?? '').trim();
        if (!clean) throw new WorkflowError('a workflow needs a name');
        const def = validateDefinition({ trigger, steps });
        const now = this.now();
        const info = this.db.prepare(
            `INSERT INTO workflows (tenant_id, channel_id, name, status, version, trigger, steps, created_at, updated_at)
             VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`)
            .run(this.tenantId, channelId == null ? null : Number(channelId), clean, pickStatus(status, 'draft'),
                JSON.stringify(def.trigger), JSON.stringify(def.steps), now, now);
        const id = Number(info.lastInsertRowid);
        this.#snapshot(id, 1, def, now);
        return this.get(id);
    }

    /** Name, channel and status change in place; trigger or steps make a new version. */
    update(id, patch = {}) {
        const current = this.#require(id);
        const now = this.now();
        let version = current.version;
        let def = { trigger: current.trigger, steps: current.steps };
        if (patch.trigger !== undefined || patch.steps !== undefined) {
            def = validateDefinition({
                trigger: patch.trigger ?? current.trigger,
                steps: patch.steps ?? current.steps,
            });
            version += 1;
            this.#snapshot(current.id, version, def, now);
        }
        this.db.prepare(
            `UPDATE workflows SET name = ?, channel_id = ?, status = ?, version = ?, trigger = ?, steps = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(
                patch.name === undefined ? current.name : String(patch.name).trim() || current.name,
                patch.channelId === undefined ? current.channelId : (patch.channelId == null ? null : Number(patch.channelId)),
                pickStatus(patch.status, current.status),
                version, JSON.stringify(def.trigger), JSON.stringify(def.steps), now,
                current.id, this.tenantId,
            );
        return this.get(current.id);
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM workflows WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toWorkflow(row) : null;
    }

    list({ status = null } = {}) {
        const rows = status
            ? this.db.prepare('SELECT * FROM workflows WHERE tenant_id = ? AND status = ? ORDER BY id').all(this.tenantId, status)
            : this.db.prepare('SELECT * FROM workflows WHERE tenant_id = ? ORDER BY id').all(this.tenantId);
        return rows.map(toWorkflow);
    }

    remove(id) {
        const info = this.db.prepare('DELETE FROM workflows WHERE id = ? AND tenant_id = ?').run(Number(id), this.tenantId);
        if (!info.changes) throw new WorkflowError('workflow not found', 404);
        // Versions stay: finished runs still point at them.
        return true;
    }

    /** The frozen trigger and steps a run executes against. */
    getVersion(id, version) {
        const row = this.db.prepare(
            'SELECT * FROM workflow_versions WHERE workflow_id = ? AND version = ? AND tenant_id = ?')
            .get(Number(id), Number(version), this.tenantId);
        return row ? { workflowId: row.workflow_id, version: row.version, trigger: parse(row.trigger, {}), steps: parse(row.steps, []), createdAt: row.created_at } : null;
    }

    versions(id) {
        return this.db.prepare('SELECT * FROM workflow_versions WHERE workflow_id = ? AND tenant_id = ? ORDER BY version')
            .all(Number(id), this.tenantId)
            .map((row) => ({ version: row.version, createdAt: row.created_at }));
    }

    // ------------------------------------------------------------- events --
    /**
     * Active workflows whose trigger fits this event: same type, same channel
     * (or any), and every trigger condition true over `event.data`.
     * `source` is never consulted - an order from the API and one from a
     * webhook must run the same workflow.
     */
    match(event) {
        return this.db.prepare(
            `SELECT * FROM workflows WHERE tenant_id = ? AND status = 'active'
             AND json_extract(trigger, '$.type') = ?
             AND (channel_id IS NULL OR channel_id = ?) ORDER BY id`)
            .all(this.tenantId, event.type, event.channelId ?? null)
            .map(toWorkflow)
            .filter((wf) => matches(wf.trigger.conditions, event.data));
    }

    /** Record an inbound event once; a redelivery is ignored, not duplicated. */
    logEvent(event) {
        return this.db.prepare(
            `INSERT OR IGNORE INTO workflow_events
             (id, tenant_id, channel_id, type, subject_kind, subject_id, data, source, occurred_at, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(event.id, this.tenantId, event.channelId ?? null, event.type,
                event.subject?.kind ?? null, event.subject?.id == null ? null : String(event.subject.id),
                JSON.stringify(event.data ?? {}), event.source ?? 'internal', event.occurredAt, this.now()).changes > 0;
    }

    // --------------------------------------------------------------- runs --
    /** Returns the existing run when the key was seen before; never two for one key. */
    createRun({ workflowId, workflowVersion, contactId = null, channelId = null, currentStep, context, idempotencyKey }) {
        const existing = this.findRunByKey(idempotencyKey);
        if (existing) return { run: existing, created: false };
        const now = this.now();
        const runId = crypto.randomUUID();
        try {
            this.db.prepare(
                `INSERT INTO workflow_runs (run_id, tenant_id, workflow_id, workflow_version, contact_id, channel_id,
                                            status, current_step, context, idempotency_key, started_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`)
                .run(runId, this.tenantId, Number(workflowId), Number(workflowVersion), contactId, channelId,
                    currentStep, JSON.stringify(context), idempotencyKey, now, now);
        } catch (err) {
            // Lost a race on the unique index: the other writer's run is the run.
            if (!String(err.message).includes('UNIQUE')) throw err;
            return { run: this.findRunByKey(idempotencyKey), created: false };
        }
        return { run: this.getRun(runId), created: true };
    }

    findRunByKey(key) {
        const row = this.db.prepare('SELECT * FROM workflow_runs WHERE tenant_id = ? AND idempotency_key = ?')
            .get(this.tenantId, key);
        return row ? toRun(row) : null;
    }

    getRun(runId) {
        const row = this.db.prepare('SELECT * FROM workflow_runs WHERE run_id = ? AND tenant_id = ?')
            .get(String(runId), this.tenantId);
        return row ? toRun(row) : null;
    }

    updateRun(runId, { status, currentStep, context, resumeAt, error, finished }) {
        const sets = ['updated_at = ?'];
        const args = [this.now()];
        if (status !== undefined) { sets.push('status = ?'); args.push(status); }
        if (currentStep !== undefined) { sets.push('current_step = ?'); args.push(currentStep); }
        if (context !== undefined) { sets.push('context = ?'); args.push(JSON.stringify(context)); }
        if (resumeAt !== undefined) { sets.push('resume_at = ?'); args.push(resumeAt); }
        if (error !== undefined) { sets.push('error = ?'); args.push(error); }
        if (finished !== undefined) { sets.push('finished_at = ?'); args.push(finished ? this.now() : null); }
        this.db.prepare(`UPDATE workflow_runs SET ${sets.join(', ')} WHERE run_id = ? AND tenant_id = ?`)
            .run(...args, String(runId), this.tenantId);
        return this.getRun(runId);
    }

    listRuns({ workflowId = null, contactId = null, status = null, limit = 100 } = {}) {
        const clauses = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (workflowId != null) { clauses.push('workflow_id = ?'); args.push(Number(workflowId)); }
        if (contactId != null) { clauses.push('contact_id = ?'); args.push(Number(contactId)); }
        if (status) { clauses.push('status = ?'); args.push(status); }
        return this.db.prepare(
            `SELECT * FROM workflow_runs WHERE ${clauses.join(' AND ')} ORDER BY started_at DESC LIMIT ?`)
            .all(...args, Math.min(Number(limit) || 100, 1000)).map(toRun);
    }

    /** Waiting runs whose timer has gone off, oldest first. */
    due(now = this.now()) {
        return this.db.prepare(
            `SELECT * FROM workflow_runs WHERE tenant_id = ? AND status = 'waiting' AND resume_at <= ?
             ORDER BY resume_at`).all(this.tenantId, iso(now)).map(toRun);
    }

    /** Mark every live run of a workflow (for one contact, if given) stopped. */
    stopRuns({ workflowId, contactId = null, except = null }) {
        const now = this.now();
        return this.db.prepare(
            `UPDATE workflow_runs SET status = 'stopped', finished_at = ?, updated_at = ?
             WHERE tenant_id = ? AND workflow_id = ? AND status IN ('running', 'waiting')
             AND (? IS NULL OR contact_id = ?) AND (? IS NULL OR run_id != ?)`)
            .run(now, now, this.tenantId, Number(workflowId), contactId, contactId, except, except).changes;
    }

    // ---------------------------------------------------------- run steps --
    /** Open a step attempt. The attempt number counts earlier tries of the same step. */
    startStep(runId, step, input) {
        const attempt = this.db.prepare(
            'SELECT COUNT(*) AS n FROM workflow_run_steps WHERE run_id = ? AND step_id = ?').get(runId, step.id).n + 1;
        const info = this.db.prepare(
            `INSERT INTO workflow_run_steps (run_id, tenant_id, step_id, action, attempt, status, input, started_at)
             VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`)
            .run(runId, this.tenantId, step.id, step.action, attempt, JSON.stringify(input ?? null), this.now());
        return Number(info.lastInsertRowid);
    }

    finishStep(id, { status, output = null, error = null }) {
        this.db.prepare(
            `UPDATE workflow_run_steps SET status = ?, output = ?, error = ?, finished_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(status, JSON.stringify(output), error, this.now(), id, this.tenantId);
    }

    runSteps(runId) {
        return this.db.prepare(
            'SELECT * FROM workflow_run_steps WHERE run_id = ? AND tenant_id = ? ORDER BY id')
            .all(String(runId), this.tenantId).map((row) => ({
                id: row.id,
                stepId: row.step_id,
                action: row.action,
                attempt: row.attempt,
                status: row.status,
                input: parse(row.input, null),
                output: parse(row.output, null),
                error: row.error,
                startedAt: row.started_at,
                finishedAt: row.finished_at,
            }));
    }

    // ------------------------------------------------------------ private --
    #snapshot(id, version, def, now) {
        this.db.prepare(
            `INSERT INTO workflow_versions (workflow_id, version, tenant_id, trigger, steps, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`)
            .run(id, version, this.tenantId, JSON.stringify(def.trigger), JSON.stringify(def.steps), now);
    }

    #require(id) {
        const wf = this.get(id);
        if (!wf) throw new WorkflowError('workflow not found', 404);
        return wf;
    }
}

/**
 * For the scheduler, which is not a tenant: which runs are due anywhere, and
 * whose they are, so it can hand each to that tenant's engine.
 */
export function dueRuns(database, now = new Date()) {
    return database.db.prepare(
        `SELECT run_id, tenant_id FROM workflow_runs WHERE status = 'waiting' AND resume_at <= ?
         ORDER BY resume_at`).all(iso(now))
        .map((row) => ({ runId: row.run_id, tenantId: row.tenant_id }));
}

/** Same shape as `utcNow()`, so timestamps compare as strings across tables. */
export const iso = (value) => (typeof value === 'string' ? value
    : new Date(value).toISOString().replace(/\.\d{3}Z$/, '+00:00'));

const pickStatus = (value, fallback) => (WORKFLOW_STATUSES.includes(value) ? value : fallback);

function toWorkflow(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        channelId: row.channel_id,
        name: row.name,
        status: row.status,
        version: row.version,
        trigger: parse(row.trigger, { type: '', conditions: [] }),
        steps: parse(row.steps, []),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toRun(row) {
    return {
        runId: row.run_id,
        tenantId: row.tenant_id,
        workflowId: row.workflow_id,
        workflowVersion: row.workflow_version,
        contactId: row.contact_id,
        channelId: row.channel_id,
        status: row.status,
        currentStep: row.current_step,
        context: parse(row.context, {}),
        idempotencyKey: row.idempotency_key,
        resumeAt: row.resume_at,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        finishedAt: row.finished_at,
        error: row.error,
    };
}

function parse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

