/**
 * Phase 7: the generic job scheduler.
 *
 * The claims worth testing are that two workers can never run the same job,
 * that a worker which dies loses nothing once its lease expires, that attempts
 * are bounded and end in a dead letter an operator can act on, and that none of
 * it leaks across tenants. Every clock is injected, so nothing here sleeps.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import { Database } from '../src/db.js';
import { SCHEDULER_SCHEMA } from '../src/scheduler/schema.js';
import { JobStore, isoAt } from '../src/scheduler/store.js';
import { SchedulerWorker } from '../src/scheduler/worker.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-scheduler-'));
const T0 = Date.parse('2026-01-01T00:00:00Z');

let db;
let clock;
let store;
let storeB;
let nextTenant = 100;

const now = () => clock;

before(() => {
    db = new Database(path.join(tmp, 's.db'));
    db.db.exec(SCHEDULER_SCHEMA);
});

after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

// Each test gets its own pair of tenants, so no test can see another's rows.
beforeEach(() => {
    clock = T0;
    const a = nextTenant += 1;
    const b = nextTenant += 1;
    store = new JobStore(db.forTenant(a), { now });
    storeB = new JobStore(db.forTenant(b), { now });
});

describe('JobStore', () => {
    it('schedules and claims a due job, leaving a future one alone', () => {
        const due = store.schedule({ kind: 'ping', payload: { n: 1 } });
        store.schedule({ kind: 'ping', runAt: clock + 60_000 });

        const claimed = store.claim('w1', { limit: 10 });
        assert.equal(claimed.length, 1);
        assert.equal(claimed[0].id, due.id);
        assert.deepEqual(claimed[0].payload, { n: 1 });
        assert.equal(claimed[0].status, 'leased');
        assert.equal(claimed[0].leaseOwner, 'w1');
        assert.equal(claimed[0].attempt, 1);

        // The future job becomes claimable only once its time arrives.
        assert.equal(store.claim('w1', { limit: 10 }).length, 0);
        clock += 60_000;
        assert.equal(store.claim('w1', { limit: 10 }).length, 1);
    });

    it('treats a repeated idempotency key as the same job', () => {
        const first = store.schedule({ kind: 'reminder', idempotencyKey: 'appt-7-24h' });
        const second = store.schedule({ kind: 'reminder', idempotencyKey: 'appt-7-24h' });
        assert.equal(second.id, first.id);
        assert.equal(store.list().length, 1);

        // A null key means "no dedupe", so those must still coexist.
        store.schedule({ kind: 'reminder' });
        store.schedule({ kind: 'reminder' });
        assert.equal(store.list().length, 3);
    });

    it('never hands the same job to two owners', () => {
        for (let i = 0; i < 20; i += 1) store.schedule({ kind: 'ping' });

        const a = store.claim('w1', { limit: 20 }).map((j) => j.id);
        const b = store.claim('w2', { limit: 20 }).map((j) => j.id);

        assert.equal(a.length, 20);
        assert.equal(b.length, 0);
        assert.equal(new Set([...a, ...b]).size, a.length + b.length);
    });

    it('splits a batch between two owners without overlap', () => {
        for (let i = 0; i < 10; i += 1) store.schedule({ kind: 'ping' });

        const a = store.claim('w1', { limit: 4 }).map((j) => j.id);
        const b = store.claim('w2', { limit: 4 }).map((j) => j.id);
        const c = store.claim('w3', { limit: 4 }).map((j) => j.id);

        assert.deepEqual([a.length, b.length, c.length], [4, 4, 2]);
        const all = [...a, ...b, ...c];
        assert.equal(new Set(all).size, 10);
        for (const id of all) assert.equal(store.get(id).status, 'leased');
    });

    it('reclaims a lease after the worker holding it disappears', () => {
        const job = store.schedule({ kind: 'ping', maxAttempts: 3 });
        store.claim('doomed', { leaseMs: 30_000 });

        // Still leased while the lease holds: a slow worker is not a dead one.
        clock += 10_000;
        assert.equal(store.reclaimExpiredLeases().length, 0);
        assert.equal(store.claim('w2').length, 0);

        clock += 25_000;
        const reclaimed = store.reclaimExpiredLeases();
        assert.equal(reclaimed.length, 1);
        assert.equal(reclaimed[0].id, job.id);
        assert.equal(reclaimed[0].status, 'pending');
        assert.equal(reclaimed[0].leaseOwner, null);
        // The crashed attempt is spent, so the retry is attempt two.
        assert.equal(store.claim('w2')[0].attempt, 2);
    });

    it('dead-letters a lease that expires on the last attempt', () => {
        const job = store.schedule({ kind: 'ping', maxAttempts: 1 });
        store.claim('doomed', { leaseMs: 1_000 });
        clock += 2_000;
        assert.equal(store.reclaimExpiredLeases()[0].status, 'dead');
        assert.equal(store.claim('w2').length, 0);
        assert.equal(store.listDead()[0].id, job.id);
    });

    it('retries up to max_attempts and then dead-letters', () => {
        const job = store.schedule({ kind: 'ping', maxAttempts: 3 });

        for (let attempt = 1; attempt <= 2; attempt += 1) {
            const [leased] = store.claim('w1');
            assert.equal(leased.attempt, attempt);
            const after2 = store.fail(leased.id, new Error(`boom ${attempt}`),
                { retryAt: isoAt(clock + 5_000) });
            assert.equal(after2.status, 'pending');
            assert.equal(after2.lastError, `boom ${attempt}`);
            assert.equal(store.claim('w1').length, 0, 'not due yet');
            clock += 5_000;
        }

        const [last] = store.claim('w1');
        assert.equal(last.attempt, 3);
        const dead = store.fail(last.id, new Error('final'));
        assert.equal(dead.status, 'dead');
        assert.equal(store.claim('w1').length, 0, 'dead jobs stop being claimed');
        assert.deepEqual(store.listDead().map((j) => j.id), [job.id]);

        const revived = store.retryDead(job.id);
        assert.equal(revived.status, 'pending');
        assert.equal(revived.attempt, 0);
        assert.equal(store.claim('w1')[0].id, job.id);
    });

    it('cancels a pending job and leaves finished ones alone', () => {
        const job = store.schedule({ kind: 'ping', runAt: clock + 60_000 });
        assert.equal(store.cancel(job.id).status, 'cancelled');
        clock += 60_000;
        assert.equal(store.claim('w1').length, 0);

        const other = store.schedule({ kind: 'ping' });
        store.claim('w1');
        store.complete(other.id);
        assert.equal(store.cancel(other.id).status, 'done');
    });

    it('releases a lease without spending the attempt', () => {
        const job = store.schedule({ kind: 'ping' });
        store.claim('w1');
        const released = store.release(job.id);
        assert.equal(released.status, 'pending');
        assert.equal(released.attempt, 0);
        assert.equal(store.claim('w2')[0].attempt, 1);
    });

    it('stops claiming a paused kind and resumes it', () => {
        const paused = store.schedule({ kind: 'reminder' });
        const other = store.schedule({ kind: 'followup' });

        store.pause('reminder');
        assert.deepEqual(store.pausedKinds(), ['reminder']);
        assert.deepEqual(store.claim('w1', { limit: 10 }).map((j) => j.id), [other.id]);

        store.resume('reminder');
        assert.deepEqual(store.claim('w1', { limit: 10 }).map((j) => j.id), [paused.id]);
    });

    it('reports counts by status and kind and the oldest pending age', () => {
        store.schedule({ kind: 'reminder' });
        clock += 60_000;
        store.schedule({ kind: 'followup' });
        const [leased] = store.claim('w1', { limit: 1 });
        store.complete(leased.id);

        const stats = store.stats();
        assert.equal(stats.byStatus.done, 1);
        assert.equal(stats.byStatus.pending, 1);
        assert.equal(stats.byKind.followup.pending, 1);
        assert.equal(stats.byKind.reminder.done, 1);
        assert.equal(stats.oldestPendingAgeSeconds, 0);

        clock += 120_000;
        assert.equal(store.stats().oldestPendingAgeSeconds, 120);
    });

    it('keeps every operation inside one tenant', () => {
        const mine = store.schedule({ kind: 'ping', idempotencyKey: 'shared' });
        const theirs = storeB.schedule({ kind: 'ping', idempotencyKey: 'shared' });
        assert.notEqual(mine.id, theirs.id, 'the same key in two tenants is two jobs');

        assert.equal(store.get(theirs.id), null);
        assert.equal(store.cancel(theirs.id), null);
        assert.equal(storeB.get(mine.id), null);

        // A greedy claim in one tenant must not touch the other's queue.
        assert.deepEqual(store.claim('w1', { limit: 100 }).map((j) => j.id), [mine.id]);
        assert.equal(storeB.get(theirs.id).status, 'pending');

        store.pause('ping');
        assert.deepEqual(storeB.pausedKinds(), []);
        assert.equal(storeB.claim('w1').length, 1);

        assert.equal(store.stats().byStatus.pending, undefined);
        assert.equal(storeB.list().length, 1);
    });

    it('claims across tenants only when asked', () => {
        const mine = store.schedule({ kind: 'ping' });
        const theirs = storeB.schedule({ kind: 'ping' });
        const claimed = store.claim('global', { limit: 100, allTenants: true }).map((j) => j.id);
        assert.ok(claimed.includes(mine.id) && claimed.includes(theirs.id));
        assert.equal(storeB.get(theirs.id).leaseOwner, 'global');
    });
});

describe('SchedulerWorker', () => {
    const makeWorker = (options = {}) => new SchedulerWorker(store, {
        now,
        // Default: timers never fire by themselves, so tests drive every tick.
        setTimeoutFn: () => null,
        ...options,
    });

    it('runs a due job through the handler registered for its kind', async () => {
        const seen = [];
        const worker = makeWorker();
        worker.register('ping', async (payload, job) => { seen.push([payload, job.kind]); });
        const job = store.schedule({ kind: 'ping', payload: { n: 7 } });

        await worker.tick();

        assert.deepEqual(seen, [[{ n: 7 }, 'ping']]);
        assert.equal(store.get(job.id).status, 'done');
        assert.equal(worker.metrics.done, 1);
    });

    it('retries a throwing handler with backoff, then dead-letters it', async () => {
        const worker = makeWorker({ retryPolicy: { delayFor: () => 10 } });
        worker.register('ping', async () => { throw new Error('nope'); });
        const job = store.schedule({ kind: 'ping', maxAttempts: 2 });

        await worker.tick();
        let row = store.get(job.id);
        assert.equal(row.status, 'pending');
        assert.equal(row.lastError, 'nope');
        assert.equal(Date.parse(row.runAt), clock + 10_000, 'backoff applied');

        await worker.tick();
        assert.equal(store.get(job.id).status, 'pending', 'still waiting out the backoff');

        clock += 10_000;
        await worker.tick();
        assert.equal(store.get(job.id).status, 'dead');
        assert.equal(worker.metrics.dead, 1);
    });

    it('dead-letters a kind nobody registered rather than losing it', async () => {
        const worker = makeWorker({ retryPolicy: { delayFor: () => 0 } });
        const job = store.schedule({ kind: 'mystery', maxAttempts: 1 });
        await worker.tick();
        const row = store.get(job.id);
        assert.equal(row.status, 'dead');
        assert.match(row.lastError, /no handler registered/);
    });

    it('fails a job that overruns its timeout instead of hanging', async () => {
        const worker = makeWorker({
            jobTimeoutMs: 5_000,
            retryPolicy: { delayFor: () => 1 },
            // Fire only the per-job timeout, which is the one we are testing.
            setTimeoutFn: (fn, ms) => (ms === 5_000 ? fn() : null),
        });
        worker.register('hang', () => new Promise(() => {}));
        const job = store.schedule({ kind: 'hang', maxAttempts: 2 });

        await worker.tick();

        const row = store.get(job.id);
        assert.equal(row.status, 'pending');
        assert.match(row.lastError, /timed out after 5000ms/);
        assert.equal(worker.metrics.timedOut, 1);
        assert.equal(worker.inFlight.size, 0);
    });

    it('reclaims a crashed worker leases on the next tick', async () => {
        const job = store.schedule({ kind: 'ping' });
        store.claim('crashed', { leaseMs: 1_000 });

        const ran = [];
        const worker = makeWorker();
        worker.register('ping', async () => { ran.push(job.id); });

        await worker.tick();
        assert.deepEqual(ran, [], 'lease still held');

        clock += 2_000;
        await worker.tick();
        assert.deepEqual(ran, [job.id]);
        assert.equal(store.get(job.id).status, 'done');
    });

    it('lets an in-flight job finish on shutdown and holds no lease after', async () => {
        let release;
        const started = new Promise((resolve) => { release = resolve; });
        let finished = false;

        const worker = makeWorker({
            pollMs: 1,
            // Resolve only the poll wait, so start()'s loop turns while the
            // per-job timeout never fires.
            setTimeoutFn: (fn, ms) => { if (ms === 1) Promise.resolve().then(fn); return null; },
        });
        worker.register('slow', async () => { await started; finished = true; });
        const job = store.schedule({ kind: 'slow' });

        worker.start();
        await waitFor(() => store.get(job.id).status === 'leased');

        const stopping = worker.shutdown();
        assert.equal(finished, false, 'shutdown does not abandon the handler');
        release();
        await stopping;

        assert.equal(finished, true);
        assert.equal(store.get(job.id).status, 'done');
        assert.equal(worker.inFlight.size, 0);
        assert.equal(worker.running, false);

        // Nothing new is claimed once it is down.
        store.schedule({ kind: 'slow' });
        assert.deepEqual(await worker.tick(), []);
    });

    it('releases a still-leased job back to pending on shutdown', async () => {
        const worker = makeWorker();
        const job = store.schedule({ kind: 'ping' });
        store.claim(worker.owner, { leaseMs: 60_000 });

        await worker.shutdown();

        const row = store.get(job.id);
        assert.equal(row.status, 'pending');
        assert.equal(row.leaseOwner, null);
        assert.equal(row.attempt, 0);
    });
});

/** Spin the microtask queue until a condition holds - no wall-clock waiting. */
async function waitFor(predicate, turns = 200) {
    for (let i = 0; i < turns; i += 1) {
        if (predicate()) return;
        await Promise.resolve();
    }
    throw new Error('condition never became true');
}
