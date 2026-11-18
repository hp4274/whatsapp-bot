/**
 * HTTP for ordering (/shop/order, the Orders service) and booking (/shop/booking, the Appointments service) on
 * WhatsApp. Mounted per channel runtime (no /api prefix); app.js gates each path by its service.
 *
 * Moving an order or booking along here (confirm payment, shipped, cancelled...) also tells the customer on
 * WhatsApp, unless `notify` is false; so does a status change on the Records page (shop/notice.js has the words).
 * A business that also installed the order_status_updates recipe should leave `notify` off or remove the recipe.
 */

import express from 'express';

import { ObjectError, OBJECT_TYPES } from '../objects/types.js';
import { ruleCap } from '../policy/modules.js';
import { notifyCustomer } from './notice.js';
import { MODES, MODE_SERVICE, ShopError, ShopStore } from './store.js';

const RECORD_TYPE = { order: 'order', booking: 'appointment' };

export function createShopRouter({ db, state }) {
    const app = express.Router();
    const store = () => new ShopStore(db);
    const changed = () => state.broadcast?.({ type: 'changed', topic: 'shop' });
    const fail = (res, err) => {
        if (err instanceof ShopError || err instanceof ObjectError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };
    /** The platform's rules for this mode (policy/modules.js), as the page needs them. */
    const rules = (mode) => {
        const p = state.platformPolicy?.() ?? {};
        const k = (name) => p[`${MODE_SERVICE[mode]}.${name}`];
        return {
            allowWhatsapp: k('allowWhatsapp') !== false, allowUpi: k('allowUpi') !== false,
            maxProducts: ruleCap(p, `${MODE_SERVICE[mode]}.maxProducts`), allowReminders: mode === 'booking' && k('allowReminders') !== false,
        };
    };
    /** The body, once every picture still on disk is an image (anything else would break the WhatsApp carousel). */
    const pictures = (body) => {
        for (const id of Array.isArray(body.images) ? body.images : []) {
            const media = state.media?.get(id);
            if (media && !String(media.mimetype).startsWith('image/')) throw new ShopError(`${media.filename} is not a picture: use a JPG or PNG`);
        }
        return body;
    };
    // An unknown mode is a bad URL: let it 404 like any other.
    app.param('mode', (req, res, next, mode) => (MODES.includes(mode) ? next() : next('route')));

    app.get('/shop/:mode', (req, res) => {
        const { mode } = req.params;
        const type = RECORD_TYPE[mode];
        res.json({
            settings: store().settings(mode),
            products: store().products(mode),
            orders: (state.objects?.list({ type, limit: 100 }) ?? []).filter((o) => o.metadata?.source === 'whatsapp'),
            statuses: OBJECT_TYPES[type].statuses,
            rules: rules(mode),
        });
    });

    app.put('/shop/:mode/settings', (req, res) => {
        try {
            const settings = store().saveSettings(req.params.mode, req.body ?? {});
            changed();
            res.json({ settings });
        } catch (err) {
            fail(res, err);
        }
    });

    app.post('/shop/:mode/products', (req, res) => {
        try {
            const cap = rules(req.params.mode).maxProducts;
            if (cap !== null && store().products(req.params.mode).length >= cap) {
                const noun = req.params.mode === 'booking' ? 'services' : 'products';
                return res.status(403).json({ errors: [`Your plan allows ${cap} ${noun}, and you have reached it.`] });
            }
            const product = store().saveProduct(req.params.mode, pictures(req.body ?? {}));
            changed();
            res.status(201).json({ product });
        } catch (err) {
            fail(res, err);
        }
    });

    app.put('/shop/:mode/products/:id', (req, res) => {
        try {
            const product = store().saveProduct(req.params.mode, pictures(req.body ?? {}), Number(req.params.id));
            changed();
            res.json({ product });
        } catch (err) {
            fail(res, err);
        }
    });

    app.delete('/shop/:mode/products/:id', (req, res) => {
        try {
            store().removeProduct(req.params.mode, Number(req.params.id));
            changed();
            res.json({ deleted: true });
        } catch (err) {
            fail(res, err);
        }
    });

    /** { status?, payment?: 'paid', notify? = true }. Marking it paid also confirms a still-new order. */
    app.post('/shop/:mode/orders/:id', async (req, res) => {
        try {
            const object = state.objects?.get(Number(req.params.id));
            if (!object || object.type !== RECORD_TYPE[req.params.mode]) return res.status(404).json({ errors: ['order not found'] });
            const { status, payment, notify = true } = req.body ?? {};
            const patch = {};
            const paidNow = payment === 'paid' && object.metadata?.payment !== 'paid';
            if (paidNow) patch.metadata = { ...object.metadata, payment: 'paid' };
            const fresh = object.status === OBJECT_TYPES[object.type].statuses[0];
            const nextStatus = status ?? (paidNow && fresh ? 'confirmed' : undefined);
            if (nextStatus && nextStatus !== object.status) patch.status = nextStatus;
            if (!Object.keys(patch).length) return res.json({ order: object, notified: false });
            const updated = await state.objects.update(object.id, patch, { source: 'shop' });
            const outcome = notify !== false ? notifyCustomer(state, updated, { paidNow, statusMoved: Boolean(patch.status) }) : 'skipped';
            changed();
            res.json({ order: updated, notified: outcome === 'sent' });
        } catch (err) {
            fail(res, err);
        }
    });

    return app;
}
