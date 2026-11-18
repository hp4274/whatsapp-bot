/**
 * Phase 11 routes, mounted into every channel runtime by `FEATURE_ROUTERS`.
 *
 * Every route is generic over `:type`; the registry decides what is valid.
 * Adding a type never touches this file.
 */

import express from 'express';

import { objectCapError } from '../policy/modules.js';
import { notifyCustomer } from '../shop/notice.js';
import { leadSettings, saveLeadSettings } from './leads.js';
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
        emit: (event) => {
            // Background changes (workflows, the school sweep, WhatsApp commands) reach open pages too.
            state.broadcast?.({ type: 'changed', topic: 'objects', path: `/objects/${event.type?.split('.')[0] ?? ''}` });
            return state.engine.dispatch(event);
        },
    });
    state.objects = objects;

    /** Who a record is for, for the Records page: its contact, else the number it was placed from. */
    const withCustomer = (o) => {
        const contact = o.contactId ? state.contacts?.get(o.contactId) : null;
        const phone = contact?.phone ?? o.metadata?.phone ?? null;
        return { ...o, customer: contact || phone ? { id: contact?.id ?? null, name: contact?.name ?? '', phone } : null };
    };

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
                objects: objects.list({ ...query, limit, offset }).map(withCustomer),
                total: objects.count(query),
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/objects/:type', async (req, res) => {
        try {
            // The plan's cap on orders / bookings a month, or leads kept (policy/modules.js).
            const capped = objectCapError(state.platformPolicy?.() ?? {}, objects, String(req.params.type).toLowerCase());
            if (capped) return res.status(403).json({ errors: [capped] });
            const object = await objects.create(req.params.type, req.body ?? {});
            state.broadcast?.({ type: 'object', object });
            return res.status(201).json({ object: withCustomer(object) });
        } catch (err) {
            return fail(res, err);
        }
    });

    // Before `/:type/:id`, or "due", "customers" and "settings" would be parsed as ids.
    /** Contacts to pick as a record's customer, by name or number (the contacts page may not be in the plan). */
    router.get('/objects/:type/customers', (req, res) => {
        try {
            typeOf(req.params.type);
            const search = String(req.query.search ?? '').trim();
            const found = state.contacts?.find(search ? { search } : {}, { limit: 8 }) ?? [];
            return res.json({ contacts: found.map((c) => ({ id: c.id, name: c.name ?? '', phone: c.phone })) });
        } catch (err) {
            return fail(res, err);
        }
    });

    /** The Leads page's "make a lead from every new person who messages" switch (leads.js). */
    router.get('/objects/lead/settings', (req, res) => res.json({
        settings: leadSettings(db),
        rules: { autoCapture: state.platformPolicy?.()?.['leads.autoCapture'] !== false },
    }));

    router.put('/objects/lead/settings', (req, res) => {
        if (req.body?.autoCapture === true && state.platformPolicy?.()?.['leads.autoCapture'] === false) {
            return res.status(403).json({ errors: ['Your plan does not include making leads from new chats.'] });
        }
        const settings = saveLeadSettings(db, req.body ?? {});
        state.broadcast?.({ type: 'changed', topic: 'objects', path: '/objects/lead' });
        return res.json({ settings });
    });

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
            return res.json({ object: withCustomer(find(objects, req.params)) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.put('/objects/:type/:id', async (req, res) => {
        try {
            const before = find(objects, req.params);
            const object = await objects.update(before.id, req.body ?? {});
            state.broadcast?.({ type: 'object', object });
            // An order or booking that moved tells its customer, as the WhatsApp page does (same key: one message).
            const notified = object.status !== before.status && req.body?.notify !== false
                && notifyCustomer(state, object, { statusMoved: true }) === 'sent';
            return res.json({ object: withCustomer(object), notified });
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
