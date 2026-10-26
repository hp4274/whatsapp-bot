/**
 * Inbound request helper that is not a bearer token: a per-tenant rate limit
 * for the API.
 */

import { RateLimiter } from '../campaign/limits.js';

/**
 * Token-bucket rate limit for the authenticated API, one bucket per key.
 *
 * Reuses `RateLimiter` from the outbound pipeline, but only its non-blocking
 * half (`delay()`/`consume()`): outbound *waits* for a token because the
 * message must go eventually, inbound *refuses* with 429 because the client
 * should back off, not queue inside our process.
 *
 * ponytail: buckets live in a Map in this process. Idle buckets are swept
 * when the map grows past `maxKeys`; a second app process has its own
 * buckets, so the effective limit doubles. Upgrade is a shared store (Redis
 * INCR with TTL) behind the same middleware signature.
 *
 * `limitsFor(req)` may return `{ ratePerSecond, burst }` to override the
 * defaults per request (a tenant's security policy). A changed value is
 * applied to the live bucket, so its tokens carry over.
 */
export function rateLimit({
    ratePerSecond = 20, burst = 40, maxKeys = 10000, idleMs = 60000,
    keyFor = defaultKey, limitsFor = () => null, now = () => performance.now() / 1000,
} = {}) {
    const buckets = new Map(); // key -> { limiter, seen }

    const sweep = () => {
        const cutoff = now() - idleMs / 1000;
        for (const [key, entry] of buckets) if (entry.seen < cutoff) buckets.delete(key);
    };

    return (req, res, next) => {
        const key = keyFor(req);
        if (key == null) return next();
        const limits = limitsFor(req);
        const rate = limits?.ratePerSecond ?? ratePerSecond;
        const size = limits?.burst ?? burst;
        let entry = buckets.get(key);
        if (!entry) {
            if (buckets.size >= maxKeys) sweep();
            entry = { limiter: new RateLimiter(rate, size, now), seen: 0 };
            buckets.set(key, entry);
        } else if (entry.limiter.rate !== rate || entry.limiter.burst !== size) {
            entry.limiter.delay(); // settle the idle refill at the old rate before the new one applies
            entry.limiter.setRate(rate, size);
        }
        entry.seen = now();
        const wait = entry.limiter.delay();
        if (wait > 0) {
            res.setHeader('Retry-After', String(Math.ceil(wait)));
            return res.status(429).json({ errors: ['Too many requests. Slow down.'] });
        }
        entry.limiter.consume();
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
