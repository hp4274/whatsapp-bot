/**
 * The WhatsApp Business catalog of a linked number: read it, show its pictures, copy products into the Orders
 * shop list (shop/), and turn a cart a customer sends from it into an Orders record.
 *
 * Mounted on the tenant router (app.js createTenantRuntime) because the URL names the number: /channels/:id/catalog.
 * Only the business app has a catalog (transport `catalog()`, Baileys); any other transport answers not_business.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import express from 'express';

import { ownerAlert } from '../moduleSweeps.js';
import { logger } from '../observability/logger.js';
import { objectCapError, ruleCap } from '../policy/modules.js';
import { deliver } from '../school/routes.js';
import { moneyIn } from '../shop/bot.js';
import { MAX_IMAGES, ShopStore } from '../shop/store.js';

const CACHE_MS = 5 * 60_000;
const IMAGE_CACHE_MS = 10 * 60_000;
const IMAGE_CACHE_MAX = 200;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png' };

/** shortcut: WhatsApp keeps money in thousandths (orderMessage.totalAmount1000); verify against a real catalog. */
export const major = (amount) => Math.round((Number(amount) || 0) / 10) / 100;

class CatalogError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

const NOT_BUSINESS = 'The catalog comes with the WhatsApp Business app. Link a WhatsApp Business number to use it.';
const services = (state) => state.tenancy?.getTenant?.(state.db.tenantId)?.services ?? [];

/** The shop list with the catalog id each imported product came from. */
function shopStore(state) {
    const store = new ShopStore(state.db);
    const cols = store.db.prepare('PRAGMA table_info(shop_items)').all().map((c) => c.name);
    if (!cols.includes('catalog_id')) store.db.exec(`ALTER TABLE shop_items ADD COLUMN catalog_id TEXT NOT NULL DEFAULT ''`);
    return store;
}

/** The raw catalog, cached per number for 5 minutes. */
async function loadCatalog(state, refresh = false) {
    // The super admin switches WhatsApp Catalog on per business (a service), then its plan rule can still turn it off.
    if (state.tenancy && !services(state).includes('catalog')) {
        throw new CatalogError(403, 'catalog_disabled', 'WhatsApp Catalog is not switched on for your account. Ask your provider to turn it on.');
    }
    if (state.platformPolicy?.()['channels.allowCatalog'] === false) {
        throw new CatalogError(403, 'catalog_disabled', 'The WhatsApp catalog is switched off on this platform.');
    }
    if (!state.transport?.isConnected?.()) throw new CatalogError(409, 'not_connected', 'This number is offline. Connect it to see its catalog.');
    if (state.info?.accountType !== 'business' || typeof state.transport.catalog !== 'function') {
        throw new CatalogError(409, 'not_business', NOT_BUSINESS);
    }
    const cached = state.catalogCache;
    if (!refresh && cached && Date.now() - cached.at < CACHE_MS) return cached;
    let raw;
    try {
        raw = await state.transport.catalog();
    } catch (err) {
        if (err.code === 'not_business') throw new CatalogError(409, 'not_business', NOT_BUSINESS);
        if (err.code === 'not_connected') throw new CatalogError(409, 'not_connected', 'This number is offline. Connect it to see its catalog.');
        logger.warn('could not read the WhatsApp catalog', { error: err.message });
        throw new CatalogError(502, 'catalog_failed', 'WhatsApp did not send the catalog. Try again in a minute.');
    }
    state.catalogCache = { at: Date.now(), products: raw?.products ?? [], collections: raw?.collections ?? [] };
    return state.catalogCache;
}

/** Baileys parses one picture per product (original, else the small requested one). */
const imageUrlsOf = (p) => [p.imageUrls?.original || p.imageUrls?.requested].filter((u) => /^https:\/\//i.test(String(u ?? '')));

function view(channelId, p) {
    const id = String(p.id);
    const images = imageUrlsOf(p).map((_, i) => `/api/channels/${channelId}/catalog/image?p=${encodeURIComponent(id)}&i=${i}`);
    return {
        id, name: String(p.name ?? ''), description: String(p.description ?? ''), price: major(p.price),
        currency: String(p.currency ?? ''), image: images[0] ?? null, images, url: String(p.url ?? ''),
        retailerId: String(p.retailerId ?? ''), hidden: Boolean(p.isHidden), status: String(p.reviewStatus?.whatsapp ?? ''),
    };
}

const imageCache = new Map(); // `${channelId}:${productId}:${i}` -> { at, type, bytes }

/** A product picture from WhatsApp's CDN; only URLs from the cached catalog are ever fetched. */
async function productImage(state, productId, index) {
    const key = `${state.channel.id}:${productId}:${index}`;
    const hit = imageCache.get(key);
    if (hit && Date.now() - hit.at < IMAGE_CACHE_MS) return hit;
    const { products } = await loadCatalog(state);
    const product = products.find((p) => String(p.id) === productId);
    const url = product && imageUrlsOf(product)[index];
    if (!url) throw new CatalogError(404, 'not_found', 'That picture is not in the catalog.');
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    const type = String(res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !type.startsWith('image/')) throw new CatalogError(502, 'catalog_failed', 'WhatsApp did not send the picture.');
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new CatalogError(502, 'catalog_failed', 'The picture is too large.');
    if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value);
    const entry = { at: Date.now(), type, bytes };
    imageCache.set(key, entry);
    return entry;
}

/** A catalog picture saved into uploads as a media id the shop can use, or null when it is not a JPG/PNG. */
async function saveImage(state, productId, index) {
    try {
        const { type, bytes } = await productImage(state, productId, index);
        if (!IMAGE_EXT[type] || !state.media?.uploadDir) return null;
        const mediaId = `med_${crypto.randomBytes(6).toString('hex')}`;
        await fs.promises.mkdir(state.media.uploadDir, { recursive: true });
        await fs.promises.writeFile(path.join(state.media.uploadDir, `${mediaId}_catalog${IMAGE_EXT[type]}`), bytes);
        state.media.claim(mediaId);
        return mediaId;
    } catch (err) {
        logger.warn('could not copy a catalog picture', { error: err.message });
        return null; // the product still comes in, without its picture
    }
}

export function createCatalogRouter({ channels, runtimes }) {
    const app = express.Router();
    const fail = (res, err) => {
        if (err instanceof CatalogError) return res.status(err.status).json({ errors: [err.message], code: err.code });
        throw err;
    };
    /** The number's running state; a number that is not running is offline. */
    const stateOf = (req) => {
        const channel = channels.get(req.params.id);
        if (!channel) throw new CatalogError(404, 'not_found', 'channel not found');
        const state = runtimes.get(channel.id)?.state;
        if (!state) throw new CatalogError(409, 'not_connected', 'This number is offline. Connect it to see its catalog.');
        return state;
    };

    app.get('/channels/:id/catalog', async (req, res) => {
        try {
            const state = stateOf(req);
            const catalog = await loadCatalog(state, req.query.refresh === '1');
            res.json({
                products: catalog.products.map((p) => view(state.channel.id, p)),
                collections: catalog.collections,
                fetchedAt: new Date(catalog.at).toISOString(),
            });
        } catch (err) {
            fail(res, err);
        }
    });

    app.get('/channels/:id/catalog/image', async (req, res) => {
        try {
            const { type, bytes } = await productImage(stateOf(req), String(req.query.p ?? ''), Number(req.query.i) || 0);
            res.set({ 'content-type': type, 'cache-control': 'private, max-age=600' }).send(bytes);
        } catch (err) {
            fail(res, err);
        }
    });

    app.post('/channels/:id/catalog/import', async (req, res) => {
        try {
            const state = stateOf(req);
            if (!services(state).includes('orders')) throw new CatalogError(403, 'orders_off', 'Orders is not part of your plan, so products cannot be added to it.');
            const ids = new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String));
            const { products } = await loadCatalog(state);
            const store = shopStore(state);
            const imported = new Set(store.db.prepare(`SELECT catalog_id FROM shop_items WHERE tenant_id = ? AND mode = 'order' AND catalog_id != ''`)
                .all(store.tenantId).map((r) => r.catalog_id));
            const cap = ruleCap(state.platformPolicy?.() ?? {}, 'orders.maxProducts');
            let count = store.products('order').length;
            let created = 0;
            let skipped = 0;
            for (const p of products.filter((x) => ids.has(String(x.id)))) {
                if (imported.has(String(p.id)) || !String(p.name ?? '').trim() || (cap !== null && count >= cap)) {
                    skipped += 1;
                    continue;
                }
                const images = [];
                for (let i = 0; i < Math.min(imageUrlsOf(p).length, MAX_IMAGES); i += 1) {
                    const mediaId = await saveImage(state, String(p.id), i);
                    if (mediaId) images.push(mediaId);
                }
                const item = store.saveProduct('order', {
                    name: p.name, description: p.description, price: major(p.price), images, active: !p.isHidden,
                });
                store.db.prepare('UPDATE shop_items SET catalog_id = ? WHERE id = ?').run(String(p.id), item.id);
                imported.add(String(p.id));
                created += 1;
                count += 1;
            }
            skipped += [...ids].filter((id) => !products.some((p) => String(p.id) === id)).length;
            if (created) state.broadcast?.({ type: 'changed', topic: 'shop' });
            res.json({ created, skipped });
        } catch (err) {
            fail(res, err);
        }
    });

    return app;
}

/**
 * A cart the customer sent from the business's WhatsApp catalog (inbound `order`, transports/baileys.js) becomes an
 * Orders record, with one "received" reply and an owner alert. False when this business does not take them.
 */
export async function handleCatalogOrder(state, saved, order) {
    if (!order || !state.objects || !services(state).includes('orders') || !services(state).includes('catalog')) return false;
    const policy = state.platformPolicy?.() ?? {};
    if (policy['channels.catalogOrders'] === false || objectCapError(policy, state.objects, 'order')) return false;
    let details = null;
    try {
        details = await state.transport?.getOrderDetails?.(order.orderId, order.token) ?? null;
    } catch (err) {
        logger.warn('could not read a WhatsApp catalog order', { error: err.message });
    }
    const currency = details?.price?.currency || order.currency || 'INR';
    const money = moneyIn(currency);
    const lines = (details?.products ?? []).map((p) => ({ name: String(p.name ?? ''), qty: Number(p.quantity) || 1, price: major(p.price) }));
    const total = details ? major(details.price?.total) : Number(order.total) || 0;
    const items = lines.length
        ? lines.map((l) => `${l.qty} x ${l.name} - ${money(l.price * l.qty)}`).join('\n')
        : `${order.itemCount} item${order.itemCount === 1 ? '' : 's'} from the WhatsApp catalog`;
    const phone = saved.sender;
    const contact = state.contacts?.getByPhone(phone) ?? state.contacts?.upsert({ phone, name: saved.senderName || undefined, source: 'shop' });
    const metadata = { source: 'whatsapp', phone, lines, total, payment: 'none', catalogOrderId: order.orderId };

    let object = null;
    for (let attempt = 0; attempt < 5 && !object; attempt += 1) {
        try {
            object = await state.objects.create('order', {
                reference: `WA-${Math.random().toString(36).slice(2, 7).toUpperCase()}`, contactId: contact?.id ?? null,
                source: 'whatsapp-catalog', metadata,
                data: { amount: total, currency, items, ...(order.note && { notes: order.note }) },
            });
        } catch (err) {
            if (err.status !== 409) throw err; // a reference clash: pick another
        }
    }
    if (!object) throw new Error('could not pick an order reference');
    deliver(state, {
        recipient: phone, text: `Thanks! We received your order ${object.reference} and will confirm it shortly.`,
        key: `catalog.order.${saved.messageId ?? object.id}`,
    });
    const who = [contact?.name || saved.senderName, `+${phone}`].filter(Boolean).join(' ');
    ownerAlert(state, `New WhatsApp catalog order ${object.reference} from ${who}: ${items.replaceAll('\n', ', ')} - total ${money(total)}`, `catalog.order.${object.id}`);
    state.broadcast?.({ type: 'changed', topic: 'shop' });
    return true;
}
