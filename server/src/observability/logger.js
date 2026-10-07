/**
 * Structured logging: one JSON object per line, with the request id and the
 * tenant/channel it concerned attached automatically.
 *
 * Context flows through `AsyncLocalStorage` rather than through function
 * arguments: `requestContext()` opens a store per request, `bindContext()`
 * adds to it once the dispatcher knows the tenant, and every log line written
 * inside that request (including from awaited code) carries both. Nothing has
 * to thread a logger through fifteen call sites to get a tenant id in a line.
 *
 * Secrets are scrubbed by key name before serialisation. Logging a config
 * object is exactly the kind of thing that leaks a token into an aggregator,
 * so the scrubber is not optional and not bypassable from the public API.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const als = new AsyncLocalStorage();

/**
 * Key names whose values never reach a log line. Matched case-insensitively
 * against each property name at every depth. `^key$` rather than `key` so
 * `idempotencyKey` and `keyword` survive; `api[-_]?key` catches the rest.
 */
const SECRET_KEY_PATTERN = /token|password|passwd|secret|authorization|cookie|^key$|api[-_]?key|private[-_]?key|encryption[-_]?key/i;
const REDACTED = '[redacted]';
const MAX_DEPTH = 8;

let threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
let sink = (level, line) => (LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout).write(`${line}\n`);

/** Replace the writer. Tests capture lines; a deployment could ship them elsewhere. */
export function setSink(fn) {
    sink = fn;
}

export function setLevel(level) {
    if (!(level in LEVELS)) throw new RangeError(`unknown log level: ${level}`);
    threshold = LEVELS[level];
}

/** Deep-copy `value` with secret-looking keys redacted. Safe on cycles and errors. */
export function scrub(value, depth = 0, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Error) {
        return scrub({ name: value.name, message: value.message, stack: value.stack, ...value }, depth, seen);
    }
    if (depth >= MAX_DEPTH) return '[depth]';
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1, seen));
    if (value instanceof Date) return value.toISOString();
    const out = {};
    for (const [key, item] of Object.entries(value)) {
        out[key] = SECRET_KEY_PATTERN.test(key) && item != null && item !== '' ? REDACTED : scrub(item, depth + 1, seen);
    }
    return out;
}

function write(level, context, message, fields) {
    if (LEVELS[level] < threshold) return;
    const line = {
        level,
        time: new Date().toISOString(),
        message: String(message),
        ...als.getStore(),
        ...context,
        ...scrub(fields ?? {}),
    };
    sink(level, JSON.stringify(line));
}

/**
 * A logger bound to fixed fields. `child()` adds more; the ambient request
 * context is merged underneath both at write time, so a child made at startup
 * still shows the current request id.
 */
export function createLogger(context = {}) {
    const bound = scrub(context);
    return {
        debug: (message, fields) => write('debug', bound, message, fields),
        info: (message, fields) => write('info', bound, message, fields),
        warn: (message, fields) => write('warn', bound, message, fields),
        error: (message, fields) => write('error', bound, message, fields),
        child: (more) => createLogger({ ...bound, ...more }),
    };
}

export const logger = createLogger();

/** The ambient context (request id, tenant, channel) for the current async chain. */
export function currentContext() {
    return als.getStore() ?? {};
}

/** Add fields to the current request's context, e.g. once the tenant is resolved. */
export function bindContext(fields) {
    const store = als.getStore();
    if (store) Object.assign(store, fields);
    return store;
}

/** Run `fn` with extra context, for work that starts outside a request (sweeps, workers). */
export function runWithContext(fields, fn) {
    return als.run({ ...als.getStore(), ...fields }, fn);
}

/**
 * Express middleware: assign a request id (honouring an inbound X-Request-Id
 * so a proxy's id survives), echo it back, open the log context and write one
 * access line on finish. Mount it before anything that logs.
 */
export function requestContext() {
    return (req, res, next) => {
        const requestId = String(req.get('x-request-id') ?? '').trim().slice(0, 128) || crypto.randomUUID();
        req.id = requestId;
        res.setHeader('x-request-id', requestId);
        const started = process.hrtime.bigint();
        res.on('finish', () => {
            // tenantId / channelId are bound later by the dispatcher, so read
            // them now rather than when the request started.
            logger.info('request', {
                method: req.method,
                path: req.originalUrl ?? req.url,
                status: res.statusCode,
                durationMs: Number(process.hrtime.bigint() - started) / 1e6,
                tenantId: req.tenantId ?? req.user?.tenantId,
            });
        });
        als.run({ requestId }, next);
    };
}
