/**
 * In-process metrics: counters, timers and gauges, read back by `snapshot()`.
 *
 * ponytail: a plain object, not Prometheus. One process, one map; the
 * snapshot is what `GET /api/metrics` returns and what an alert rule reads.
 * Upgrade path when there is more than one process: export the same snapshot
 * in the text exposition format, or push it to a statsd sink - the call sites
 * (`inc`, `observe`, `gauge`) do not change.
 */

import { ErrorCode } from '../messaging/errors.js';

const counters = new Map();
const timers = new Map();
const gauges = new Map();
/** Error timestamps in the last window, so an alert can ask "how many lately". */
const recentErrors = [];
const ERROR_WINDOW_MS = 5 * 60 * 1000;
const startedAt = Date.now();

/** `name{a=1,b=2}` with labels sorted, so the same labels always hit the same key. */
const keyOf = (name, labels = {}) => {
    const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
    return parts.length ? `${name}{${parts.join(',')}}` : name;
};

export function inc(name, labels = {}, by = 1) {
    const key = keyOf(name, labels);
    counters.set(key, (counters.get(key) ?? 0) + by);
}

export function observe(name, ms, labels = {}) {
    const key = keyOf(name, labels);
    const t = timers.get(key) ?? { count: 0, totalMs: 0, maxMs: 0 };
    t.count += 1;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
    timers.set(key, t);
}

/** Time a block: `const done = timed('x'); ...; done()`. */
export function timed(name, labels = {}) {
    const started = process.hrtime.bigint();
    return () => observe(name, Number(process.hrtime.bigint() - started) / 1e6, labels);
}

/**
 * A gauge is read at snapshot time, so queue depth is registered once as a
 * function rather than updated on every enqueue.
 */
export function gauge(name, read) {
    gauges.set(name, typeof read === 'function' ? read : () => read);
}

// ---------------------------------------------------------- domain helpers --

/** Provider round-trip time; `labels` is normally `{ provider, channelId }`. */
export function recordProviderLatency(ms, labels = {}) {
    observe('provider_latency_ms', ms, labels);
    inc('provider_requests', labels);
}

/** A normalized send failure. Unknown codes are folded into UNKNOWN so the label set stays bounded. */
export function recordError(code, labels = {}) {
    const known = code in ErrorCode ? code : ErrorCode.UNKNOWN;
    inc('errors', { ...labels, code: known });
    recentErrors.push(Date.now());
}

/** `outcome` is the run's terminal status: completed, failed, waiting, cancelled. */
export function recordWorkflowRun(outcome, labels = {}) {
    inc('workflow_runs', { ...labels, outcome: String(outcome) });
}

/** Register a channel's queue so its depth shows up under `queue_depth{channelId=N}`. */
export function registerQueue(channelId, depth) {
    gauge(keyOf('queue_depth', { channelId }), depth);
}

export function unregisterQueue(channelId) {
    gauges.delete(keyOf('queue_depth', { channelId }));
}

// ------------------------------------------------------------------ output --

export function snapshot(now = Date.now()) {
    const since = now - ERROR_WINDOW_MS;
    while (recentErrors.length && recentErrors[0] < since) recentErrors.shift();

    const timerOut = {};
    for (const [key, t] of timers) {
        timerOut[key] = { ...t, avgMs: t.count ? t.totalMs / t.count : 0 };
    }
    const gaugeOut = {};
    for (const [key, read] of gauges) {
        try {
            gaugeOut[key] = read();
        } catch (err) {
            gaugeOut[key] = null; // a broken gauge must not break the whole snapshot
            inc('metrics_gauge_errors', { gauge: key });
            void err;
        }
    }

    let errors = 0;
    let requests = 0;
    for (const [key, value] of counters) {
        if (key.startsWith('errors{') || key === 'errors') errors += value;
        if (key.startsWith('provider_requests')) requests += value;
    }

    return {
        startedAt: new Date(startedAt).toISOString(),
        uptimeSec: Math.round((now - startedAt) / 1000),
        counters: Object.fromEntries(counters),
        timers: timerOut,
        gauges: gaugeOut,
        errors: {
            total: errors,
            last5m: recentErrors.length,
            // Lifetime ratio of failed sends to provider calls; null until there is a denominator.
            rate: requests ? errors / requests : null,
        },
    };
}

/** Tests only: start from nothing. */
export function reset() {
    counters.clear();
    timers.clear();
    gauges.clear();
    recentErrors.length = 0;
}
