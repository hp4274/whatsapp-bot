/**
 * Persistent job queue on SQLite.
 *
 * The one claim that matters: `claim()` leases jobs with a single
 * `UPDATE ... RETURNING`, never a SELECT followed by an UPDATE. SQLite applies
 * one statement atomically, so two workers racing for the same due job get
 * disjoint sets - the loser's subquery no longer sees status 'pending'.
 *
 * A lease is a timestamp, not a lock object, so a worker that dies holds
 * nothing: once `lease_until` passes, `reclaimExpiredLeases()` makes the job
 * claimable again. That is the whole crash-recovery story.
 */

export const JOB_STATUSES = Object.freeze([
    'pending', 'leased', 'done', 'failed', 'dead', 'cancelled',
]);

export const DEFAULT_LEASE_MS = 60_000;

/** Same shape as protocol.utcNow(), but for an arbitrary instant. */
export function isoAt(ms) {
    return new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export class JobStore {
    /**
     * @param {import('../db.js').Database} database a tenant-scoped handle
     * @param {{ now?: () => number }} options injected clock, in ms epoch
     */
    constructor(database, { now = () => Date.now() } = {}) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.now = now;
    }

    // ------------------------------------------------------------- writes --
    /**
     * Queue a job. `runAt` accepts ms epoch, a Date, or an ISO string, and
     * defaults to now - an immediate job is just one due at this instant.
     *
     * Scheduling the same `idempotencyKey` twice returns the job already there
     * instead of creating a second one, so a retried HTTP request or a replayed
     * webhook cannot double-book a reminder.
     */
    schedule({ kind, payload = {}, runAt, maxAttempts = 3, idempotencyKey = null }) {
        if (!kind) throw new TypeError('kind is required');
        const key = idempotencyKey == null ? null : String(idempotencyKey);
        if (key) {
            const existing = this.findByKey(key);
            if (existing) return existing;
        }
        const stamp = isoAt(this.now());
        const info = this.db.prepare(
            `INSERT INTO scheduled_jobs (tenant_id, kind, payload, run_at, status, attempt,
                                         max_attempts, idempotency_key, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`)
            .run(
                this.tenantId, String(kind), JSON.stringify(payload ?? {}),
                this.#at(runAt), Math.max(1, Number(maxAttempts) || 1), key, stamp, stamp,
            );
        return this.get(Number(info.lastInsertRowid));
    }

    /**
     * Atomically lease up to `limit` due pending jobs for `owner`.
     *
     * `allTenants` exists because a single process-wide worker should not need
     * one timer per tenant; the rows it returns still carry their tenant id, so
     * a handler can scope its own work.
     */
    claim(owner, { limit = 1, now, leaseMs = DEFAULT_LEASE_MS, allTenants = false } = {}) {
        const at = now == null ? this.now() : Number(now);
        const nowIso = isoAt(at);
        const scope = allTenants ? '' : 'AND j.tenant_id = ?';
        const args = allTenants ? [] : [this.tenantId];
        return this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = 'leased', lease_owner = ?, lease_until = ?,
                    attempt = attempt + 1, updated_at = ?
              WHERE id IN (
                    SELECT id FROM scheduled_jobs AS j
                     WHERE j.status = 'pending' AND j.run_at <= ? ${scope}
                       AND NOT EXISTS (SELECT 1 FROM scheduler_pauses p
                                        WHERE p.tenant_id = j.tenant_id AND p.kind = j.kind)
                     ORDER BY j.run_at, j.id
                     LIMIT ?)
          RETURNING *`)
            .all(String(owner), isoAt(at + Math.max(1, leaseMs)), nowIso, nowIso, ...args, Math.max(1, limit))
            .map(toJob);
    }

    complete(id) {
        return this.#finish(id, 'done', null);
    }

    /**
     * Record a failed attempt. Past `max_attempts` the job dead-letters and
     * stops being claimed; otherwise it goes back to pending at `retryAt`.
     */
    fail(id, error, { retryAt } = {}) {
        const job = this.get(id);
        if (!job) return null;
        const stamp = isoAt(this.now());
        const message = String(error?.message ?? error ?? 'failed');
        if (job.attempt >= job.maxAttempts) {
            this.db.prepare(
                `UPDATE scheduled_jobs
                    SET status = 'dead', lease_owner = NULL, lease_until = NULL,
                        last_error = ?, updated_at = ?
                  WHERE id = ? AND tenant_id = ?`)
                .run(message, stamp, id, this.tenantId);
            return this.get(id);
        }
        this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = 'pending', lease_owner = NULL, lease_until = NULL,
                    run_at = ?, last_error = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ?`)
            .run(this.#at(retryAt), message, stamp, id, this.tenantId);
        return this.get(id);
    }

    /** Hand a leased job back unrun - what a graceful shutdown does. */
    release(id, { runAt } = {}) {
        const stamp = isoAt(this.now());
        this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = 'pending', lease_owner = NULL, lease_until = NULL,
                    run_at = ?, attempt = MAX(0, attempt - 1), updated_at = ?
              WHERE id = ? AND tenant_id = ? AND status = 'leased'`)
            .run(this.#at(runAt), stamp, id, this.tenantId);
        return this.get(id);
    }

    /** Release everything still leased by one worker, by its owner id. */
    releaseOwned(owner, { runAt } = {}) {
        return this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = 'pending', lease_owner = NULL, lease_until = NULL,
                    run_at = ?, attempt = MAX(0, attempt - 1), updated_at = ?
              WHERE status = 'leased' AND lease_owner = ? AND tenant_id = ?
          RETURNING *`)
            .all(this.#at(runAt), isoAt(this.now()), String(owner), this.tenantId)
            .map(toJob);
    }

    cancel(id) {
        this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = 'cancelled', lease_owner = NULL, lease_until = NULL, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND status IN ('pending', 'leased')`)
            .run(isoAt(this.now()), id, this.tenantId);
        return this.get(id);
    }

    /**
     * A worker that died left its jobs leased forever. Once the lease expires
     * they are claimable again - unless the crash already burned the last
     * attempt, in which case they dead-letter rather than loop.
     */
    reclaimExpiredLeases(now) {
        const at = now == null ? this.now() : Number(now);
        return this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'pending' END,
                    lease_owner = NULL, lease_until = NULL,
                    last_error = 'lease expired', updated_at = ?
              WHERE status = 'leased' AND lease_until <= ? AND tenant_id = ?
          RETURNING *`)
            .all(isoAt(at), isoAt(at), this.tenantId)
            .map(toJob);
    }

    /** Put a dead job back in the queue with its attempt counter cleared. */
    retryDead(id, { runAt } = {}) {
        const stamp = isoAt(this.now());
        this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = 'pending', attempt = 0, run_at = ?,
                    lease_owner = NULL, lease_until = NULL, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND status = 'dead'`)
            .run(this.#at(runAt), stamp, id, this.tenantId);
        return this.get(id);
    }

    pause(kind) {
        this.db.prepare(
            `INSERT OR IGNORE INTO scheduler_pauses (tenant_id, kind, paused_at) VALUES (?, ?, ?)`)
            .run(this.tenantId, String(kind), isoAt(this.now()));
    }

    resume(kind) {
        this.db.prepare('DELETE FROM scheduler_pauses WHERE tenant_id = ? AND kind = ?')
            .run(this.tenantId, String(kind));
    }

    pausedKinds() {
        return this.db.prepare('SELECT kind FROM scheduler_pauses WHERE tenant_id = ? ORDER BY kind')
            .all(this.tenantId).map((row) => row.kind);
    }

    // -------------------------------------------------------------- reads --
    get(id) {
        const row = this.db.prepare('SELECT * FROM scheduled_jobs WHERE id = ? AND tenant_id = ?')
            .get(id, this.tenantId);
        return row ? toJob(row) : null;
    }

    findByKey(key) {
        const row = this.db.prepare(
            'SELECT * FROM scheduled_jobs WHERE tenant_id = ? AND idempotency_key = ?')
            .get(this.tenantId, String(key));
        return row ? toJob(row) : null;
    }

    list({ status, kind, limit = 100 } = {}) {
        const args = [this.tenantId];
        let sql = 'SELECT * FROM scheduled_jobs WHERE tenant_id = ?';
        if (status) { sql += ' AND status = ?'; args.push(String(status)); }
        if (kind) { sql += ' AND kind = ?'; args.push(String(kind)); }
        sql += ' ORDER BY run_at, id LIMIT ?';
        args.push(Math.max(1, limit));
        return this.db.prepare(sql).all(...args).map(toJob);
    }

    listDead({ limit = 100 } = {}) {
        return this.list({ status: 'dead', limit });
    }

    /** Metrics an operator or a /metrics endpoint can read straight out. */
    stats(now) {
        const at = now == null ? this.now() : Number(now);
        const byStatus = {};
        for (const row of this.db.prepare(
            'SELECT status, COUNT(*) AS n FROM scheduled_jobs WHERE tenant_id = ? GROUP BY status')
            .all(this.tenantId)) byStatus[row.status] = row.n;
        const byKind = {};
        for (const row of this.db.prepare(
            `SELECT kind, status, COUNT(*) AS n FROM scheduled_jobs
              WHERE tenant_id = ? GROUP BY kind, status`).all(this.tenantId)) {
            byKind[row.kind] ??= {};
            byKind[row.kind][row.status] = row.n;
        }
        const oldest = this.db.prepare(
            `SELECT MIN(run_at) AS run_at FROM scheduled_jobs
              WHERE tenant_id = ? AND status = 'pending'`).get(this.tenantId)?.run_at;
        return {
            byStatus,
            byKind,
            paused: this.pausedKinds(),
            oldestPendingAt: oldest ?? null,
            oldestPendingAgeSeconds: oldest
                ? Math.max(0, Math.round((at - Date.parse(oldest)) / 1000)) : 0,
        };
    }

    // ------------------------------------------------------------ private --
    #finish(id, status, error) {
        this.db.prepare(
            `UPDATE scheduled_jobs
                SET status = ?, lease_owner = NULL, lease_until = NULL,
                    last_error = ?, updated_at = ?
              WHERE id = ? AND tenant_id = ?`)
            .run(status, error, isoAt(this.now()), id, this.tenantId);
        return this.get(id);
    }

    #at(value) {
        if (value == null) return isoAt(this.now());
        if (typeof value === 'string') return value;
        return isoAt(value instanceof Date ? value.getTime() : Number(value));
    }
}

function toJob(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        kind: row.kind,
        payload: parsePayload(row.payload),
        runAt: row.run_at,
        status: row.status,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        leaseUntil: row.lease_until,
        leaseOwner: row.lease_owner,
        lastError: row.last_error,
        idempotencyKey: row.idempotency_key,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parsePayload(text) {
    try {
        const value = JSON.parse(text ?? '{}');
        return value && typeof value === 'object' ? value : { value };
    } catch {
        // A payload that cannot be parsed must not stop the job being listed or
        // cancelled, so surface it as-is rather than throwing on read.
        return { raw: text };
    }
}
