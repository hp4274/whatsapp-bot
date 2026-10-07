/**
 * Phase 11 routes, mounted into every channel runtime by `FEATURE_ROUTERS`.
 *
 * Every route is generic over `:type`; the registry decides what is valid.
 * Adding a type never touches this file.
 */

import express from 'express';

import { ObjectStore } from './store.js';
import { OBJECT_TYPES, ObjectError, eventTypes, typeOf } from './types.js';

/**
 * @param {{ db: import('../db.js').Database, state: object }} deps
 *   `state.engine` is the channel's WorkflowEngine; object changes dispatch
 *   through it. `state.objects` is set here so other features (and the main
 *   thread's scheduler wiring) can reach the store without a second instance.
 */
export function createObjectRouter({ db, state }) {
    const router = express.Router();
    const objects = new ObjectStore(db, {
        // Resolved per call: the engine is attached to `state` after the router
        // is mounted, and a test may swap it.
        emit: (event) => state.engine.dispatch(event),
    });
    state.objects = objects;

    const fail = (res, err) => {
        if (!(err instanceof ObjectError)) throw err;
        const body = { errors: [err.message] };
        if (err.object) body.object = err.object; // saved, but the workflow did not start
        return res.status(err.status).json(body);
    };

    router.get('/object-types', (req, res) => res.json({
        types: Object.fromEntries(Object.entries(OBJECT_TYPES).map(([name, entry]) => [name, {
            ...entry, defaultStatus: entry.statuses[0],
        }])),
        eventTypes: eventTypes(),
    }));

    router.get('/objects-stats', (req, res) => res.json(objects.stats()));

    router.get('/objects/:type', (req, res) => {
        try {
            typeOf(req.params.type);
            const { status, contactId, from, to, limit, offset, ...rest } = req.query;
            // ?data.amount=100 filters the JSON; anything else in the query is ignored.
            const filter = Object.fromEntries(Object.entries(rest)
                .filter(([k]) => k.startsWith('data.')).map(([k, v]) => [k.slice(5), v]));
            const query = { type: req.params.type, status, contactId, from, to, filter };
            return res.json({
                objects: objects.list({ ...query, limit, offset }),
                total: objects.count(query),
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/objects/:type', async (req, res) => {
        try {
            const object = await objects.create(req.params.type, req.body ?? {});
            state.broadcast?.({ type: 'object', object });
            return res.status(201).json({ object });
        } catch (err) {
            return fail(res, err);
        }
    });

    // Before `/:type/:id`, or "due" would be parsed as an id.
    router.get('/objects/:type/due', (req, res) => {
        try {
            const before = req.query.before ? new Date(req.query.before) : new Date();
            if (Number.isNaN(before.getTime())) throw new ObjectError('before must be a date-time');
            return res.json({ objects: objects.due({ type: req.params.type, before, limit: req.query.limit }) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/objects/:type/:id', (req, res) => {
        try {
            return res.json({ object: find(objects, req.params) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.put('/objects/:type/:id', async (req, res) => {
        try {
            const object = await objects.update(find(objects, req.params).id, req.body ?? {});
            state.broadcast?.({ type: 'object', object });
            return res.json({ object });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.delete('/objects/:type/:id', (req, res) => {
        try {
            return res.json({ deleted: objects.remove(find(objects, req.params).id).id });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/objects/:type/:id/events', (req, res) => {
        try {
            return res.json({ events: objects.events(find(objects, req.params).id, { limit: req.query.limit }) });
        } catch (err) {
            return fail(res, err);
        }
    });

    return router;
}

/** An id under the wrong type is a 404, same as another tenant's: the URL names nothing. */
function find(objects, { type, id }) {
    typeOf(type);
    const object = objects.get(id);
    if (!object || object.type !== String(type).toLowerCase()) throw new ObjectError('object not found', 404);
    return object;
}
