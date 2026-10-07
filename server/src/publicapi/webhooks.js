/**
 * Outbound webhooks: how a customer's system hears about what happened here.
 *
 * Two decisions worth knowing about.
 *
 * 1. Every delivery is signed. The inbound Meta webhook in `app.js` has no
 *    signature check and that is a logged gap; adding a second unsigned path
 *    would make it a pattern. The signature covers a timestamp as well as the
 *    body, so a captured request cannot be replayed an hour later into a
 *    receiver that only checks the HMAC.
 *
 * 2. Delivery is durable but this file contains no retry loop. The Phase 7
 *    scheduler already does leases, exponential backoff, attempt limits and a
 *    dead-letter queue; a second implementation would be a worse copy with its
 *    own bugs. `enqueue` writes a delivery row and schedules one job per
 *    endpoint; `createWebhookDeliveryHandler` is the handler the worker runs.
 *
 * Retryability follows the vocabulary of `messaging/errors.js`: a network
 * failure, a 429 or a 5xx is worth another attempt, and anything else the
 * receiver says (404, 401, 422) is a configuration problem that more attempts
 * will not fix, so it is recorded and not thrown.
 */

import crypto from 'node:crypto';

import { utcNow } from '../protocol.js';

/** What a customer may subscribe to. Phase 16 of phases/README.md, verbatim. */
export const WEBHOOK_EVENTS = Object.freeze([
    'message.received',
    'message.delivered',
    'message.failed',
    'workflow.started',
    'workflow.completed',
    'workflow.failed',
    'ticket.created',
    'ticket.updated',
]);

/** The scheduler `kind` the main thread registers the handler under. */
export const WEBHOOK_JOB_KIND = 'webhook.deliver';

export const SIGNATURE_HEADER = 'x-webhook-signature';
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export class WebhookError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// ---------------------------------------------------------------- signing --
/**
 * `t=<unix seconds>,v1=<hex hmac>` where the HMAC is sha256 over
 * `<t>.<raw body>`. The timestamp is inside the signed string, so it cannot be
 * edited without invalidating the signature - that is what makes a capture
 * un-replayable once the receiver enforces a tolerance.
 *
 * `v1` leaves room for a future algorithm without breaking existing receivers.
 */
export function signPayload(rawBody, secret, timestampMs = Date.now()) {
    const t = Math.floor(timestampMs / 1000);
    const mac = crypto.createHmac('sha256', String(secret)).update(`${t}.${rawBody}`).digest('hex');
    return `t=${t},v1=${mac}`;
}

/**
 * The check a customer runs on their side. Exported so the docs can show it.
 *
 * @param {string} rawBody the body exactly as received, before JSON.parse
 * @param {string} header  the `X-Webhook-Signature` value
 * @param {string} secret  the endpoint secret
 */
export function verifySignature(rawBody, header, secret, {
    toleranceMs = SIGNATURE_TOLERANCE_MS, now = () => Date.now(),
} = {}) {
    const parts = Object.fromEntries(String(header ?? '').split(',')
        .map((part) => part.split('=').map((s) => s.trim()))
        .filter((pair) => pair.length === 2));
    const t = Number(parts.t);
    if (!Number.isFinite(t) || !parts.v1) return false;
    if (toleranceMs > 0 && Math.abs(now() - t * 1000) > toleranceMs) return false;
    const expected = crypto.createHmac('sha256', String(secret)).update(`${t}.${rawBody}`).digest('hex');
    const given = Buffer.from(String(parts.v1), 'hex');
    const want = Buffer.from(expected, 'hex');
    // Length check first: timingSafeEqual throws on a mismatch rather than
    // returning false, and a wrong length is not a secret worth protecting.
    return given.length === want.length && crypto.timingSafeEqual(given, want);
}

// ------------------------------------------------------------------ store --
export class WebhookStore {
    /** @param {import('../db.js').Database} database a tenant- or channel-scoped handle */
    constructor(database, { now = () => utcNow() } = {}) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.now = now;
    }

    // ------------------------------------------------------- endpoints --
    createEndpoint({ url, events = [], secret = null, isActive = true } = {}) {
        const clean = cleanEvents(events);
        if (!clean.length) throw new WebhookError('events must include at least one event type');
        const info = this.db.prepare(
            `INSERT INTO webhook_endpoints (tenant_id, url, secret, events, is_active, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, cleanUrl(url),
                secret ? String(secret) : crypto.randomBytes(32).toString('base64url'),
                JSON.stringify(clean), isActive ? 1 : 0, this.now());
        return this.getEndpoint(Number(info.lastInsertRowid));
    }

    getEndpoint(id) {
        const row = this.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toEndpoint(row) : null;
    }

    listEndpoints() {
        return this.db.prepare('SELECT * FROM webhook_endpoints WHERE tenant_id = ? ORDER BY id')
            .all(this.tenantId).map(toEndpoint);
    }

    updateEndpoint(id, { url, events, isActive } = {}) {
        const current = this.#requireEndpoint(id);
        this.db.prepare(
            `UPDATE webhook_endpoints SET url = ?, events = ?, is_active = ? WHERE id = ? AND tenant_id = ?`)
            .run(
                url === undefined ? current.url : cleanUrl(url),
                JSON.stringify(events === undefined ? current.events : cleanEvents(events)),
                (isActive === undefined ? current.isActive : Boolean(isActive)) ? 1 : 0,
                current.id, this.tenantId,
            );
        return this.getEndpoint(current.id);
    }

    removeEndpoint(id) {
        const endpoint = this.#requireEndpoint(id);
        this.db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?')
            .run(endpoint.id, this.tenantId);
        return endpoint;
    }

    // ------------------------------------------------------ deliveries --
    /**
     * Fan one event out to every active endpoint subscribed to it: a delivery
     * row plus a job each.
     *
     * The row is written before the job is scheduled, so a crash in between
     * leaves a visible pending delivery rather than a silent nothing. The job's
     * idempotency key is the delivery id, which makes a double-enqueue a no-op.
     *
     * @param {import('../scheduler/store.js').JobStore} jobs this tenant's job store
     * @returns {object[]} the delivery rows created
     */
    enqueue({ type, payload = {} }, jobs) {
        if (!WEBHOOK_EVENTS.includes(type)) return [];
        const out = [];
        for (const endpoint of this.listEndpoints()) {
            if (!endpoint.isActive || !endpoint.events.includes(type)) continue;
            const body = { event: type, occurredAt: this.now(), data: payload };
            const info = this.db.prepare(
                `INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_type, payload, status, created_at)
                 VALUES (?, ?, ?, ?, 'pending', ?)`)
                .run(this.tenantId, endpoint.id, type, JSON.stringify(body), this.now());
            const delivery = this.getDelivery(Number(info.lastInsertRowid));
            jobs?.schedule({
                kind: WEBHOOK_JOB_KIND,
                payload: { deliveryId: delivery.id },
                maxAttempts: 5,
                idempotencyKey: `${WEBHOOK_JOB_KIND}:${delivery.id}`,
            });
            out.push(delivery);
        }
        return out;
    }

    getDelivery(id) {
        const row = this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toDelivery(row) : null;
    }

    listDeliveries({ endpointId, status, limit = 100 } = {}) {
        const args = [this.tenantId];
        let sql = 'SELECT * FROM webhook_deliveries WHERE tenant_id = ?';
        if (endpointId != null) { sql += ' AND endpoint_id = ?'; args.push(Number(endpointId)); }
        if (status) { sql += ' AND status = ?'; args.push(String(status)); }
        sql += ' ORDER BY id DESC LIMIT ?';
        args.push(Math.min(Number(limit) || 100, 1000));
        return this.db.prepare(sql).all(...args).map(toDelivery);
    }

    recordAttempt(id, { status, attempt, responseCode = null, error = null }) {
        this.db.prepare(
            `UPDATE webhook_deliveries SET status = ?, attempt = ?, response_code = ?, error = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(status, Number(attempt), responseCode, error, Number(id), this.tenantId);
        return this.getDelivery(id);
    }

    #requireEndpoint(id) {
        const endpoint = this.getEndpoint(id);
        if (!endpoint) throw new WebhookError('webhook endpoint not found', 404);
        return endpoint;
    }
}

// ---------------------------------------------------------------- handler --
/**
 * The scheduler handler for `WEBHOOK_JOB_KIND`.
 *
 * Throwing is how a retry is requested: the worker applies backoff and
 * dead-letters past `maxAttempts`. So a 4xx that is not 408/429 is recorded as
 * `failed` and returns normally - retrying a 404 five times just makes five
 * entries in someone's error log.
 *
 * @param {{ db: import('../db.js').Database, fetch?: typeof globalThis.fetch, timeoutMs?: number }} deps
 *   `db` is any handle; the tenant comes from the job row, so one registration
 *   serves every tenant a worker claims for.
 */
export function createWebhookDeliveryHandler({ db, fetch = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    return async function deliver(payload, job) {
        const scoped = db.tenantId === job.tenantId ? db : db.forTenant(job.tenantId);
        const store = new WebhookStore(scoped);
        const delivery = store.getDelivery(payload?.deliveryId);
        if (!delivery) return; // the endpoint was deleted; nothing to deliver
        const endpoint = store.getEndpoint(delivery.endpointId);
        if (!endpoint || !endpoint.isActive) {
            store.recordAttempt(delivery.id, {
                status: 'failed', attempt: job.attempt, error: 'endpoint is inactive or deleted',
            });
            return;
        }

        const raw = JSON.stringify(delivery.payload);
        let response;
        try {
            response = await fetch(endpoint.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    [SIGNATURE_HEADER]: signPayload(raw, endpoint.secret),
                    'x-webhook-event': delivery.eventType,
                    'x-webhook-delivery': String(delivery.id),
                },
                body: raw,
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (err) {
            // No response at all: DNS, TLS, timeout. Always worth retrying.
            store.recordAttempt(delivery.id, {
                status: 'pending', attempt: job.attempt, error: String(err.message ?? err),
            });
            throw err;
        }

        if (response.ok) {
            store.recordAttempt(delivery.id, {
                status: 'delivered', attempt: job.attempt, responseCode: response.status,
            });
            return;
        }

        const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
        const message = `endpoint responded ${response.status}`;
        store.recordAttempt(delivery.id, {
            status: retryable ? 'pending' : 'failed',
            attempt: job.attempt,
            responseCode: response.status,
            error: message,
        });
        if (retryable) throw new Error(message);
    };
}

/**
 * The one-liner the rest of the app calls: `emit('ticket.created', {...})`.
 *
 * Never throws. A business write must not fail because a customer's webhook
 * receiver is unreachable - the delivery row and the job queue are where that
 * problem becomes visible.
 */
export function createWebhookEmitter({ db, jobs, onError = () => {} }) {
    const store = new WebhookStore(db);
    return (type, payload = {}) => {
        try {
            return store.enqueue({ type, payload }, jobs);
        } catch (err) {
            onError(err);
            return [];
        }
    };
}

function cleanUrl(url) {
    let parsed;
    try {
        parsed = new URL(String(url ?? ''));
    } catch {
        throw new WebhookError('url must be an absolute http(s) URL');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new WebhookError('url must be an absolute http(s) URL');
    }
    return parsed.toString();
}

function cleanEvents(events) {
    const list = Array.isArray(events) ? events : String(events ?? '').split(/[,\s]+/);
    const out = [];
    for (const raw of list) {
        const type = String(raw ?? '').trim();
        if (!type) continue;
        if (!WEBHOOK_EVENTS.includes(type)) throw new WebhookError(`unknown webhook event "${type}"`);
        if (!out.includes(type)) out.push(type);
    }
    return out;
}

function toEndpoint(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        url: row.url,
        secret: row.secret,
        events: parseJson(row.events, []),
        isActive: Boolean(row.is_active),
        createdAt: row.created_at,
    };
}

function toDelivery(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        endpointId: row.endpoint_id,
        eventType: row.event_type,
        payload: parseJson(row.payload, {}),
        status: row.status,
        attempt: row.attempt,
        responseCode: row.response_code ?? null,
        error: row.error ?? null,
        createdAt: row.created_at,
    };
}

function parseJson(text, fallback) {
    try {
        const value = JSON.parse(text ?? 'null');
        return value ?? fallback;
    } catch {
        return fallback;
    }
}
