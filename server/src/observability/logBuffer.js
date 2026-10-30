/**
 * The last ~2,000 backend log lines, in memory, for the super admin's "Backend logs" view.
 *
 * Lines arrive here from logger.js after it has scrubbed them (secrets, message bodies, phone numbers), and from
 * console.warn/error through the same masking, so this buffer can never show more than stdout already did. It is
 * per process and lost on restart on purpose: it answers "what just happened", the log shipper keeps history.
 *
 * Each line also gets a plain sentence ("POST /api/campaigns/5/start answered 409 in 12 ms") so the admin does not
 * have to read JSON to see which request failed.
 */

export const LOG_CAPACITY = 2000;
const RANK = { debug: 10, info: 20, warn: 30, error: 40 };

const ring = new Array(LOG_CAPACITY);
let next = 0; // slot the next line goes in
let count = 0;
let seq = 0; // monotonic id, the `before` cursor
const watchers = new Set();

/** Store one already-redacted line (a plain object with level, time, message, ...fields). */
export function remember(line) {
    const entry = { id: ++seq, ...line };
    ring[next] = entry;
    next = (next + 1) % LOG_CAPACITY;
    count = Math.min(count + 1, LOG_CAPACITY);
    if ((RANK[entry.level] ?? 0) >= RANK.warn) {
        for (const fn of watchers) {
            try {
                fn(entry);
            } catch {
                // a broken watcher must never break logging
            }
        }
    }
}

/**
 * Call `fn` after warn/error lines, at most once per `everyMs`: a failing sweep can write a line per tenant per
 * minute, and every call becomes a reload on each open admin screen. Returns the unsubscribe function.
 */
export function onWarnings(fn, { everyMs = 5000 } = {}) {
    let timer = null;
    let last = 0;
    const watcher = () => {
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            last = Date.now();
            fn();
        }, Math.max(0, last + everyMs - Date.now()));
        timer.unref?.();
    };
    watchers.add(watcher);
    return () => {
        watchers.delete(watcher);
        if (timer) clearTimeout(timer);
    };
}

/**
 * Publish `topic` on an admin feed (adminFeed.js) after warn/error lines, throttled by onWarnings. The feed is held
 * weakly: this buffer is per process and outlives any one app (tests build dozens), and must not keep a closed
 * app's feed alive. Defined here, away from the app's scope, so the closure captures nothing else.
 */
export function publishWarnings(feed, topic = 'logs') {
    const ref = new WeakRef(feed);
    const stop = onWarnings(() => {
        const live = ref.deref();
        if (live) live.publish(topic);
        else stop();
    });
    return stop;
}

const cap = (s) => String(s ?? '').replace(/^./, (c) => c.toUpperCase());
const ms = (n) => (Number(n) >= 1000 ? `${(Number(n) / 1000).toFixed(1)} s` : `${Math.round(Number(n))} ms`);

/** One line as a sentence. Errors keep their error text: that is the part the admin is looking for. */
export function summariseLog(line) {
    const message = String(line?.message ?? '');
    if (message === 'request' && line.method) {
        const status = Number(line.status);
        const outcome = status >= 500 ? 'failed with' : status >= 400 ? 'was refused with' : 'answered';
        return `${line.method} ${line.path ?? ''} ${outcome} ${status} in ${ms(line.durationMs ?? 0)}`;
    }
    const alert = /^ops alert: (\S+)/.exec(message);
    if (alert) return `Ops alert (${alert[1].replace(/_/g, ' ')}): ${line.alert?.summary || 'see the details'}`;
    const error = line.error ?? line.err?.message;
    if (error && !message.includes(String(error))) return `${cap(message)}: ${String(error).slice(0, 300)}`;
    return cap(message) || '(empty line)';
}

/**
 * Newest first. `level` is a floor (warn = warn and error), `q` matches anywhere in the line, `tenant` a tenant id,
 * `requestId` exact, `before` the id cursor of the previous page, `after` only lines newer than an id.
 */
export function recentLogs(query = {}) {
    const floor = RANK[query.level] ?? 0;
    const q = String(query.q ?? '').trim().toLowerCase().slice(0, 200);
    const tenant = query.tenant ? Number(query.tenant) : null;
    const requestId = query.requestId ? String(query.requestId) : null;
    const before = Number(query.before) > 0 ? Number(query.before) : Infinity;
    const after = Number(query.after) > 0 ? Number(query.after) : 0;
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000);
    const lines = [];
    let more = false;
    for (let i = 1; i <= count; i++) {
        const entry = ring[(next - i + LOG_CAPACITY) % LOG_CAPACITY];
        if (entry.id >= before) continue;
        if (entry.id <= after) break;
        if ((RANK[entry.level] ?? 0) < floor) continue;
        if (tenant !== null && Number(entry.tenantId) !== tenant) continue;
        if (requestId && entry.requestId !== requestId) continue;
        if (q && !JSON.stringify(entry).toLowerCase().includes(q)) continue;
        if (lines.length === limit) {
            more = true;
            break;
        }
        const { id, level, time, ...rest } = entry;
        lines.push({
            id, level, time, summary: summariseLog(entry),
            severity: level === 'error' ? 'danger' : level === 'warn' ? 'warn' : 'info',
            requestId: entry.requestId ?? null, tenantId: entry.tenantId ?? null,
            line: { level, time, ...rest },
        });
    }
    return { lines, nextBefore: more ? lines[lines.length - 1].id : null, size: count, capacity: LOG_CAPACITY };
}

/** Tests only: forget everything. */
export function clearLogs() {
    ring.fill(undefined);
    next = 0;
    count = 0;
}
