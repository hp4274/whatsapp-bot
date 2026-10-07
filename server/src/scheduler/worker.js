/**
 * The loop that runs scheduled jobs.
 *
 * It knows nothing about what a job means: a caller registers a handler for a
 * `kind` and the worker hands it the opaque payload. The workflow engine is one
 * such handler, payment reminders another.
 *
 * Shape follows CampaignManager: one loop, events out through `emit('event')`,
 * `shutdown()` waits for in-flight work. Clock and timer are injected so tests
 * can simulate a lease expiring tomorrow without waiting for tomorrow.
 */

import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

import { RetryPolicy } from '../campaign/limits.js';
import { DEFAULT_LEASE_MS, isoAt } from './store.js';

export class SchedulerWorker extends EventEmitter {
    /**
     * @param {import('./store.js').JobStore} store tenant-scoped job store
     */
    constructor(store, {
        now = () => Date.now(),
        setTimeoutFn = setTimeout,
        pollMs = 1000,
        leaseMs = DEFAULT_LEASE_MS,
        batchSize = 5,
        jobTimeoutMs = 30_000,
        allTenants = false,
        retryPolicy = new RetryPolicy(),
        owner = `worker-${crypto.randomUUID().slice(0, 8)}`,
    } = {}) {
        super();
        this.store = store;
        this.now = now;
        this.setTimeoutFn = setTimeoutFn;
        this.pollMs = pollMs;
        this.leaseMs = leaseMs;
        this.batchSize = batchSize;
        this.jobTimeoutMs = jobTimeoutMs;
        this.allTenants = allTenants;
        this.retryPolicy = retryPolicy;
        this.owner = owner;
        this.handlers = new Map();
        this.running = false;
        this.shuttingDown = false;
        this.loop = null;
        this.inFlight = new Map();      // job id -> promise
        this.metrics = { claimed: 0, done: 0, failed: 0, dead: 0, timedOut: 0 };
    }

    /** @param {(payload: object, job: object) => Promise<void>} handler */
    register(kind, handler) {
        if (typeof handler !== 'function') throw new TypeError('handler must be a function');
        this.handlers.set(String(kind), handler);
        return this;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.shuttingDown = false;
        this.loop = this.#run().finally(() => { this.loop = null; });
    }

    /**
     * Stop claiming, let in-flight handlers finish, then make sure nothing is
     * left leased by this worker - otherwise a clean restart would have to wait
     * out the lease on a job nobody is running.
     */
    async shutdown() {
        this.shuttingDown = true;
        this.running = false;
        if (this.loop) await this.loop;
        await Promise.allSettled([...this.inFlight.values()]);
        this.store.releaseOwned(this.owner, { runAt: this.now() });
        this.emit('event', { type: 'schedulerStopped', owner: this.owner });
    }

    /**
     * One pass: reclaim dead workers' leases, claim what is due, run it.
     * Public because tests drive ticks directly rather than through timers.
     */
    async tick() {
        const at = this.now();
        this.store.reclaimExpiredLeases(at);
        if (this.shuttingDown) return [];
        const jobs = this.store.claim(this.owner, {
            limit: this.batchSize,
            now: at,
            leaseMs: this.leaseMs,
            allTenants: this.allTenants,
        });
        this.metrics.claimed += jobs.length;
        await Promise.all(jobs.map((job) => this.#dispatch(job)));
        return jobs;
    }

    // -------------------------------------------------------------- worker --
    async #run() {
        while (!this.shuttingDown) {
            try {
                await this.tick();
            } catch (err) {
                // A broken tick must not kill the loop; the next one retries.
                this.emit('event', { type: 'schedulerError', error: err.message });
            }
            if (this.shuttingDown) break;
            // ponytail: fixed poll interval, so a job can start up to pollMs
            // late. Wake the loop on schedule() if that latency ever matters.
            await new Promise((resolve) => this.setTimeoutFn(resolve, this.pollMs));
        }
    }

    #dispatch(job) {
        const promise = this.#runJob(job).finally(() => this.inFlight.delete(job.id));
        this.inFlight.set(job.id, promise);
        return promise;
    }

    async #runJob(job) {
        const handler = this.handlers.get(job.kind);
        if (!handler) {
            // An unregistered kind is a wiring bug, not a transient fault, so
            // let it burn attempts and dead-letter where an operator sees it.
            this.#fail(job, new Error(`no handler registered for kind '${job.kind}'`));
            return;
        }
        let timer = null;
        try {
            await Promise.race([
                handler(job.payload, job),
                new Promise((_, reject) => {
                    timer = this.setTimeoutFn(
                        () => reject(new Error(`job timed out after ${this.jobTimeoutMs}ms`)),
                        this.jobTimeoutMs,
                    );
                }),
            ]);
            this.store.complete(job.id);
            this.metrics.done += 1;
            this.emit('event', { type: 'jobDone', job: this.store.get(job.id) });
        } catch (err) {
            if (/job timed out/.test(err.message)) this.metrics.timedOut += 1;
            this.#fail(job, err);
        } finally {
            // The timeout promise is abandoned either way; clear its timer so a
            // long-lived process does not accumulate them.
            clearTimeout(timer);
        }
    }

    #fail(job, err) {
        // Backoff comes from the campaign RetryPolicy, which already does
        // exponential growth with jitter; attempt limits are the job's own.
        const retryAt = this.now() + this.retryPolicy.delayFor(job.attempt) * 1000;
        const saved = this.store.fail(job.id, err, { retryAt: isoAt(retryAt) });
        if (saved?.status === 'dead') {
            this.metrics.dead += 1;
            this.emit('event', { type: 'jobDead', job: saved });
        } else {
            this.metrics.failed += 1;
            this.emit('event', { type: 'jobFailed', job: saved, error: err.message });
        }
    }
}
