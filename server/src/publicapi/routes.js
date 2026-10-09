/**
 * The public `/v1` API: a façade, not a layer.
 *
 * Every route here validates, maps onto a store that already exists
 * (ObjectStore, ContactStore, TicketStore, WorkflowEngine) and returns a shape
 * this file owns. That indirection is the whole point: the internal shapes are
 * free to change with the product, and `/v1` is not, because a customer's
 * integration is deployed somewhere we cannot edit. There is no second object
 * model in here - `POST /v1/orders` is `objects.create('order', …)`.
 *
 * Authentication is an API key, not a session, so this router must be mounted
 * outside the bearer middleware in `app.js` (see `createPublicApiRouter`'s
 * doc comment for what the main thread has to wire). The key selects the
 * tenant; a key is checked against `db.tenantId` on every request, so a
 * mis-wired dispatcher cannot leak across tenants - it 403s instead.
 */

import express from 'express';

import { API_SCOPES, ApiKeyError, ApiKeyStore } from './keys.js';
import { WEBHOOK_EVENTS, WebhookError, WebhookStore } from './webhooks.js';

/** Which v1 resource maps to which object type. Adding one is one line. */
const OBJECT_ROUTES = Object.freeze({
    appointments: 'appointment',
    orders: 'order',
    payments: 'payment',
});

/**
 * @param {{ db: import('../db.js').Database, state: object }} deps
 *
 * The main thread must mount this so it is NOT behind `app.use('/api', …)`'s
 * session check - that middleware 401s anything without a bearer *session*,
 * and an API key is not one. The pattern already in `app.js` is the Meta
 * webhook: resolve the tenant first, then hand off to that tenant's runtime
 * router with the URL rewritten.
 *
 *   app.all('/api/v1/*', (req, res, next) => {
 *       const key = new ApiKeyStore(db).verify(bearerOrApiKeyHeader(req));
 *       if (!key) return res.status(401).json({ error: 'invalid_api_key' });
 *       if (tenancy.getTenant(key.tenantId)?.status !== 'active') return res.sendStatus(404);
 *       req.url = req.url.slice('/api'.length);   // -> /v1/...
 *       return runtimeFor(key.tenantId).router(req, res, next);
 *   });
 */
export function createPublicApiRouter({ db, state }) {
    const router = express.Router();
    const keys = new ApiKeyStore(db);
    state.apiKeys = keys;

    /**
     * Re-verify here rather than trust a `req` property set upstream. It is one
     * sha256, and it means the tenant isolation claim is enforced by the code
     * that reads the data instead of by a middleware two files away.
     */
    router.use('/v1', (req, res, next) => {
        const header = req.get('authorization') ?? '';
        const presented = header.startsWith('Bearer ') ? header.slice(7) : req.get('x-api-key');
        const key = keys.verify(presented);
        if (!key) return res.status(401).json({ error: 'invalid_api_key', message: 'Provide a valid API key.' });
        if (key.tenantId !== db.tenantId) {
            return res.status(403).json({ error: 'wrong_tenant', message: 'That key belongs to another account.' });
        }
        keys.touch(key.id); // Phase 18 reads last_used_at for per-key rate limits.
        req.apiKey = key;
        return next();
    });

    /**
     * Replay protection for a customer's own retries. Same key, same stored
     * response - including the status - so a timed-out POST that is sent again
     * cannot create a second order. Mirrors what MessageService does for sends,
     * one level up.
     */
    router.use('/v1', (req, res, next) => {
        const idempotencyKey = req.get('idempotency-key');
        if (!idempotencyKey || req.method === 'GET' || req.method === 'HEAD') return next();
        const stored = db.db.prepare('SELECT * FROM api_idempotency WHERE tenant_id = ? AND key = ?')
            .get(db.tenantId, idempotencyKey);
        if (stored) {
            // A key reused on a different route is a bug in the caller, and
            // replaying the wrong body would hide it.
            if (stored.route !== req.path) {
                return res.status(409).json({
                    error: 'idempotency_key_reused',
                    message: `That Idempotency-Key was already used for ${stored.route}.`,
                });
            }
            res.set('idempotent-replay', 'true');
            return res.status(stored.status).json(JSON.parse(stored.response));
        }
        const json = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode < 400) {
                db.db.prepare(
                    `INSERT OR IGNORE INTO api_idempotency (tenant_id, key, route, status, response, created_at)
                     VALUES (?, ?, ?, ?, ?, ?)`)
                    .run(db.tenantId, idempotencyKey, req.path, res.statusCode,
                        JSON.stringify(body), new Date().toISOString());
            }
            return json(body);
        };
        return next();
    });

    /** Enforced on every route - a key that can write orders cannot read contacts. */
    const scope = (required) => (req, res, next) => (req.apiKey.scopes.includes(required)
        ? next()
        : res.status(403).json({
            error: 'insufficient_scope',
            message: `This key needs the "${required}" scope.`,
            required,
        }));

    const fail = (res, err) => {
        const status = Number(err?.status) || (err instanceof ApiKeyError ? 400 : 500);
        if (status >= 500) throw err;
        return res.status(status).json({ error: errorCode(status), message: err.message });
    };

    // ---------------------------------------------- tenant key management --
    // Session routes (behind the bearer middleware, gated on the `api` service);
    // writes already need admin there. Secrets appear only in the create response.
    const webhooks = new WebhookStore(db);
    const manageFail = (res, err) => {
        if (!(err instanceof ApiKeyError || err instanceof WebhookError)) throw err;
        return res.status(err.status).json({ errors: [err.message] });
    };
    const publicEndpoint = ({ secret, ...endpoint }) => ({ ...endpoint, secretHint: `…${String(secret).slice(-4)}` });

    router.get('/api-keys', (req, res) => res.json({ keys: keys.list(), scopes: API_SCOPES }));
    router.post('/api-keys', (req, res) => {
        try {
            return res.status(201).json({ key: keys.createKey(req.body ?? {}) });
        } catch (err) {
            return manageFail(res, err);
        }
    });
    router.delete('/api-keys/:id', (req, res) => {
        try {
            return res.json({ key: keys.revoke(req.params.id) });
        } catch (err) {
            return manageFail(res, err);
        }
    });

    router.get('/webhook-endpoints', (req, res) => res.json({
        endpoints: webhooks.listEndpoints().map(publicEndpoint), events: WEBHOOK_EVENTS,
    }));
    router.post('/webhook-endpoints', (req, res) => {
        try {
            return res.status(201).json({ endpoint: webhooks.createEndpoint({ ...req.body, secret: null }) });
        } catch (err) {
            return manageFail(res, err);
        }
    });
    router.put('/webhook-endpoints/:id', (req, res) => {
        try {
            return res.json({ endpoint: publicEndpoint(webhooks.updateEndpoint(req.params.id, req.body ?? {})) });
        } catch (err) {
            return manageFail(res, err);
        }
    });
    router.delete('/webhook-endpoints/:id', (req, res) => {
        try {
            return res.json({ deleted: webhooks.removeEndpoint(req.params.id).id });
        } catch (err) {
            return manageFail(res, err);
        }
    });
    router.get('/webhook-endpoints/:id/deliveries', (req, res) => {
        if (!webhooks.getEndpoint(req.params.id)) return res.status(404).json({ errors: ['endpoint not found'] });
        return res.json({ deliveries: webhooks.listDeliveries({ endpointId: Number(req.params.id), limit: 50 }) });
    });

    const v1 = express.Router();
    router.use('/v1', v1);

    /** What a key can do, so an integrator can check their wiring without guessing. */
    v1.get('/', (req, res) => res.json({
        version: 'v1',
        scopes: req.apiKey.scopes,
        availableScopes: API_SCOPES,
        resources: ['events', 'contacts', ...Object.keys(OBJECT_ROUTES), 'tickets'],
    }));

    // ------------------------------------------------------------ events --
    /**
     * The generic door: anything the workflow engine understands. A customer
     * whose ERP has no matching object type still gets automation out of this.
     */
    v1.post('/events', scope('events:write'), async (req, res) => {
        const { type, occurredAt, subject = null, data = {}, contactPhone } = req.body ?? {};
        if (!type) return res.status(400).json({ error: 'invalid_request', message: 'type is required' });
        try {
            // A phone is what an outside system has; the engine wants a contact.
            const payload = { ...data };
            if (contactPhone) payload.phone = contactPhone;
            const runs = await state.engine.dispatch({
                type, occurredAt, subject, data: payload, source: 'api',
                channelId: state.channel?.id ?? null,
            });
            return res.status(202).json({
                accepted: true,
                event: { type, occurredAt: occurredAt ?? null },
                workflowRuns: runs.map((run) => ({ id: run.id, status: run.status })),
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    // ---------------------------------------------------------- contacts --
    v1.post('/contacts', scope('contacts:write'), (req, res) => {
        const { phone, name, email, tags, customFields, optInStatus } = req.body ?? {};
        if (!phone) return res.status(400).json({ error: 'invalid_request', message: 'phone is required' });
        try {
            const contact = state.contacts.upsert({
                phone, name, email, tags, customFields, optInStatus, source: 'api',
            });
            return res.status(201).json({ contact: toContact(contact) });
        } catch (err) {
            return fail(res, err);
        }
    });

    // Phone is the reference an outside system holds; ids here are ours.
    v1.get('/contacts/:phone', scope('contacts:read'), (req, res) => {
        try {
            const contact = state.contacts.getByPhone(state.contacts.normalize(req.params.phone));
            if (!contact) return res.status(404).json({ error: 'not_found', message: 'contact not found' });
            return res.json({ contact: toContact(contact) });
        } catch (err) {
            return fail(res, err);
        }
    });

    // ----------------------------------------------------------- objects --
    for (const [resource, type] of Object.entries(OBJECT_ROUTES)) {
        v1.post(`/${resource}`, scope('objects:write'), async (req, res) => {
            const { reference, contactId, status, metadata, ...rest } = req.body ?? {};
            // `data` may be nested or flat: an outside system posting
            // {amount: 100} should not have to learn our envelope.
            const data = rest.data ?? rest;
            try {
                const object = await state.objects.create(type, {
                    reference, contactId, status, metadata, data, source: 'api',
                });
                state.broadcast?.({ type: 'object', object });
                return res.status(201).json({ [singular(resource)]: toObject(object) });
            } catch (err) {
                // The object is saved even when its workflow could not start;
                // say so rather than implying nothing happened.
                if (err?.object) {
                    return res.status(202).json({
                        [singular(resource)]: toObject(err.object),
                        warning: err.message,
                    });
                }
                return fail(res, err);
            }
        });

        v1.get(`/${resource}/:reference`, scope('objects:read'), (req, res) => {
            try {
                const object = state.objects.getByReference(type, req.params.reference);
                if (!object) return res.status(404).json({ error: 'not_found', message: `${type} not found` });
                return res.json({ [singular(resource)]: toObject(object) });
            } catch (err) {
                return fail(res, err);
            }
        });
    }

    // ----------------------------------------------------------- tickets --
    v1.post('/tickets', scope('tickets:write'), (req, res) => {
        const { contactId, subject, category, priority, status, metadata } = req.body ?? {};
        try {
            const ticket = state.tickets.create({
                contactId, subject, category, priority, status, metadata,
                channelId: state.channel?.id ?? null, source: 'api',
            });
            state.broadcast?.({ type: 'ticket', ticket });
            return res.status(201).json({ ticket: toTicket(ticket) });
        } catch (err) {
            return fail(res, err);
        }
    });

    // Read is gated on tickets:write deliberately: the scope list is fixed and
    // small, and a key that can file a ticket may read the one it filed.
    v1.get('/tickets/:reference', scope('tickets:write'), (req, res) => {
        try {
            const ticket = state.tickets.getByReference(req.params.reference);
            if (!ticket) return res.status(404).json({ error: 'not_found', message: 'ticket not found' });
            return res.json({ ticket: toTicket(ticket) });
        } catch (err) {
            return fail(res, err);
        }
    });

    return router;
}

// ------------------------------------------------------- stable v1 shapes --
// These are the contract. Internal field renames stop here.

function toContact(contact) {
    return {
        id: contact.id,
        phone: contact.phone,
        name: contact.name,
        email: contact.email,
        tags: contact.tags,
        customFields: contact.customFields,
        status: contact.status,
        optInStatus: contact.optInStatus,
        createdAt: contact.createdAt,
        updatedAt: contact.updatedAt,
    };
}

function toObject(object) {
    return {
        id: object.id,
        type: object.type,
        reference: object.reference,
        contactId: object.contactId,
        status: object.status,
        data: object.data,
        metadata: object.metadata,
        occursAt: object.occursAt,
        createdAt: object.createdAt,
        updatedAt: object.updatedAt,
    };
}

function toTicket(ticket) {
    return {
        id: ticket.id,
        reference: ticket.reference,
        subject: ticket.subject,
        category: ticket.category,
        status: ticket.status,
        priority: ticket.priority,
        contactId: ticket.contactId,
        assignedTo: ticket.assignedTo,
        slaDueAt: ticket.slaDueAt,
        createdAt: ticket.createdAt,
        updatedAt: ticket.updatedAt,
    };
}

const singular = (resource) => resource.replace(/s$/, '');

function errorCode(status) {
    if (status === 404) return 'not_found';
    if (status === 409) return 'conflict';
    if (status === 403) return 'forbidden';
    if (status === 502) return 'upstream_failed';
    return 'invalid_request';
}
