/**
 * Inbound request authentication that is not a bearer token: Meta's webhook
 * signature, and a per-tenant rate limit for the API.
 *
 * Meta signs every webhook POST as `X-Hub-Signature-256: sha256=<hex>` where
 * the hex is HMAC-SHA256 over the raw request bytes with the app secret. It
 * has to be the raw bytes - a re-serialised `req.body` is not what was signed -
 * so `express.json`'s `verify` hook captures the buffer onto `req.rawBody`.
 */

import crypto from 'node:crypto';

import { RateLimiter } from '../campaign/limits.js';
import { logger } from '../observability/logger.js';

export function signPayload(rawBody, secret) {
    return `sha256=${crypto.createHmac('sha256', String(secret)).update(rawBody).digest('hex')}`;
}

/** Constant-time check of the header against the HMAC of the raw body. */
export function verifySignature(rawBody, header, secret) {
    if (!rawBody || !header || !secret) return false;
    const expected = Buffer.from(signPayload(rawBody, secret));
    const actual = Buffer.from(String(header));
    // timingSafeEqual throws on unequal lengths; an unequal length is just "no".
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Constant-time string equality for shared secrets (verify tokens and the like). */
export function safeEqual(a, b) {
    const left = crypto.createHash('sha256').update(String(a ?? '')).digest();
    const right = crypto.createHash('sha256').update(String(b ?? '')).digest();
    return crypto.timingSafeEqual(left, right);
}

const warnedChannels = new Set();

/**
 * Middleware. `secretFor(req)` returns the channel's app secret, or nothing.
 *
 * DEFAULT-OPEN BY DECISION: with no app secret configured the request is let
 * through unsigned, with one warning per channel. Every install before Phase
 * 18 has no secret stored, and Meta only signs with a secret the operator has
 * entered; verifying against nothing would take every one of those webhooks
 * dark on upgrade. The control is enforced the moment a secret is saved. If
 * fail-closed is wanted, set the secret - there is no flag to bypass the
 * check once it exists.
 */
export function webhookSignatureGuard(secretFor) {
    return (req, res, next) => {
        const secret = secretFor(req);
        if (!secret) {
            const id = req.channel?.id ?? 'default';
            if (!warnedChannels.has(id)) {
                warnedChannels.add(id);
                logger.warn('webhook accepted without signature verification: no appSecret configured', { channelId: id });
            }
            return next();
        }
        if (!verifySignature(req.rawBody, req.get('x-hub-signature-256'), secret)) {
            logger.warn('webhook signature rejected', { channelId: req.channel?.id, hasHeader: Boolean(req.get('x-hub-signature-256')) });
            return res.sendStatus(401);
        }
        return next();
    };
}

/**
 * Token-bucket rate limit for the authenticated API, one bucket per key.
 *
 * Reuses `RateLimiter` from the outbound pipeline, but only its non-blocking
 * half (`delay()`/`consume()`): outbound *waits* for a token because the
 * message must go eventually, inbound *refuses* with 429 because the client
 * should back off, not queue inside our process. Not applied to the webhook -
 * that is Meta's traffic and throttling it loses messages.
 *
 * ponytail: buckets live in a Map in this process. Idle buckets are swept
 * when the map grows past `maxKeys`; a second app process has its own
 * buckets, so the effective limit doubles. Upgrade is a shared store (Redis
 * INCR with TTL) behind the same middleware signature.
 */
export function rateLimit({
    ratePerSecond = 20, burst = 40, maxKeys = 10000, idleMs = 60000,
    keyFor = defaultKey, now = () => performance.now() / 1000,
} = {}) {
    const buckets = new Map(); // key -> { limiter, seen }

    const sweep = () => {
        const cutoff = now() - idleMs / 1000;
        for (const [key, entry] of buckets) if (entry.seen < cutoff) buckets.delete(key);
    };

    return (req, res, next) => {
        const key = keyFor(req);
        if (key == null) return next();
        let entry = buckets.get(key);
        if (!entry) {
            if (buckets.size >= maxKeys) sweep();
            entry = { limiter: new RateLimiter(ratePerSecond, burst, now), seen: 0 };
            buckets.set(key, entry);
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
