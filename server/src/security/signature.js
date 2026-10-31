/**
 * Inbound request helper that is not a bearer token: a per-tenant rate limit
 * for the API.
 */

import { DatabaseSync } from 'node:sqlite';

/**
 * Token-bucket rate limit for the authenticated API, one bucket per key.
 *
 * Unlike the outbound pacer (campaign/limits.js), which *waits* for a token
 * because the message must go eventually, inbound *refuses* with 429 because
 * the client should back off, not queue inside our process.
 *
 * Buckets are rows in `db` - pass the app's SQLite connection and every process
 * on the host spends one budget per key instead of one each (without it, a
 * private in-memory database). Limiters sharing a `db` must use distinct keys.
 * Refill-and-take is one UPSERT, so two processes cannot both spend the last
 * token: `level` is the bucket before the last request took its token (it took
 * one iff level >= 1), which lets the statement decide and report in one go.
 * The clock is wall time because the processes must agree on it. Buckets idle
 * for `idleMs` (refilled by then) are dropped at most once per `idleMs`.
 *
 * `limitsFor(req)` may return `{ ratePerSecond, burst }` to override the
 * defaults per request (a tenant's security policy). A changed value is
 * applied to the live bucket, so its tokens carry over; the idle time before
 * the change still refills at the old rate (the stored `rate`).
 */
export function rateLimit({
    db = new DatabaseSync(':memory:'), ratePerSecond = 20, burst = 40, idleMs = 60000,
    keyFor = defaultKey, limitsFor = () => null, now = () => Date.now() / 1000,
} = {}) {
    db.exec(`CREATE TABLE IF NOT EXISTS rate_buckets (
        key TEXT PRIMARY KEY, level REAL NOT NULL, rate REAL NOT NULL, at REAL NOT NULL)`);
    const take = db.prepare(`
        INSERT INTO rate_buckets (key, level, rate, at) VALUES (:key, :size, :rate, :now)
        ON CONFLICT (key) DO UPDATE SET
            level = MIN(:size, level - (level >= 1) + MAX(0, :now - at) * rate),
            rate = :rate, at = MAX(at, :now)
        RETURNING level`);
    let swept = now();

    return (req, res, next) => {
        const key = keyFor(req);
        if (key == null) return next();
        const limits = limitsFor(req);
        const rate = limits?.ratePerSecond ?? ratePerSecond;
        const size = Math.max(1, limits?.burst ?? burst);
        const t = now();
        if (t - swept >= idleMs / 1000) {
            swept = t;
            db.prepare('DELETE FROM rate_buckets WHERE at < ?').run(t - idleMs / 1000);
        }
        const { level } = take.get({ key, size, rate, now: t });
        if (level < 1) {
            res.setHeader('Retry-After', String(Math.ceil((1 - level) / rate)));
            return res.status(429).json({ errors: ['Too many requests. Slow down.'] });
        }
        return next();
    };
}

/** API key first (its own budget), then the tenant, then the user, then the address. */
function defaultKey(req) {
    if (req.apiKey?.id != null) return `key:${req.apiKey.id}`;
    if (req.user?.tenantId != null) return `tenant:${req.user.tenantId}`;
    if (req.user?.id != null) return `user:${req.user.id}`;
    return `ip:${req.ip}`;
}
