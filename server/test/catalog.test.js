/**
 * The WhatsApp Business catalog: listing (prices from thousandths, same-origin picture paths), the picture route
 * refusing what is not in the catalog, importing into the Orders shop once, the platform rule, and a cart sent from
 * the catalog becoming an Orders record with one reply.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-catalog-'));
let app;
let server;
let base;
let db;
let owner;
let state;
let channelId;

const call = async (method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${owner}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};

const PRODUCTS = [
    { id: 'p1', name: 'Brownie', description: 'Fudgy', price: 60000, currency: 'INR', imageUrls: { original: 'https://cdn.example/p1.jpg' }, url: '', retailerId: 'BR1', isHidden: false, reviewStatus: { whatsapp: 'APPROVED' } },
    { id: 'p2', name: 'Cake', description: '', price: 499500, currency: 'INR', imageUrls: {}, isHidden: true, reviewStatus: { whatsapp: 'PENDING' } },
];

before(async () => {
    db = new Database(path.join(tmp, 'c.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connection/connect`, { method: 'POST' });
    const rt = app.locals.runtimeFor(1);
    channelId = rt.channels.getDefault().id;
    state = rt.runtimeFor(rt.channels.getDefault()).state;
    state.transport.connected = true;
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WhatsApp catalog', () => {
    const services = (list) => app.locals.tenancy.db.prepare('UPDATE tenants SET services = ? WHERE id = 1').run(JSON.stringify(list));
    const tenantServices = () => app.locals.tenancy.getTenant(1).services;

    it('a personal number has no catalog', async () => {
        state.info = { ...state.info, accountType: 'personal' };
        const res = await call('GET', `/api/channels/${channelId}/catalog`);
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'not_business');
        assert.match(res.body.errors[0], /WhatsApp Business app/);
    });

    it('lists a business number\'s catalog in major units with same-origin pictures', async () => {
        state.info = { ...state.info, accountType: 'business' };
        let calls = 0;
        state.transport.catalog = async () => {
            calls += 1;
            return { products: PRODUCTS, collections: [{ id: 'c1', name: 'Bakes', productIds: ['p1', 'p2'] }] };
        };
        const res = await call('GET', `/api/channels/${channelId}/catalog`);
        assert.equal(res.status, 200);
        const [brownie, cake] = res.body.products;
        assert.equal(brownie.price, 60);
        assert.equal(cake.price, 499.5);
        assert.equal(brownie.image, `/api/channels/${channelId}/catalog/image?p=p1&i=0`);
        assert.deepEqual(cake.images, []);
        assert.equal(cake.image, null);
        assert.equal(cake.hidden, true);
        assert.equal(brownie.status, 'APPROVED');
        assert.equal(res.body.collections[0].name, 'Bakes');
        assert.ok(res.body.fetchedAt);
        await call('GET', `/api/channels/${channelId}/catalog`);
        assert.equal(calls, 1, 'cached');
        await call('GET', `/api/channels/${channelId}/catalog?refresh=1`);
        assert.equal(calls, 2, 'refresh bypasses the cache');
    });

    it('the picture route only serves pictures from the catalog', async () => {
        assert.equal((await call('GET', `/api/channels/${channelId}/catalog/image?p=nope&i=0`)).status, 404);
        assert.equal((await call('GET', `/api/channels/${channelId}/catalog/image?p=p2&i=0`)).status, 404);
    });

    it('imports products into the Orders shop once', async () => {
        const others = tenantServices().filter((s) => s !== 'orders');
        services(others);
        assert.equal((await call('POST', `/api/channels/${channelId}/catalog/import`, { ids: ['p2'] })).body.code, 'orders_off');
        services([...others, 'orders']);
        const first = await call('POST', `/api/channels/${channelId}/catalog/import`, { ids: ['p2'] });
        assert.deepEqual(first.body, { created: 1, skipped: 0 });
        const again = await call('POST', `/api/channels/${channelId}/catalog/import`, { ids: ['p2'] });
        assert.deepEqual(again.body, { created: 0, skipped: 1 });
        const { products } = (await call('GET', '/api/shop/order')).body;
        assert.equal(products.length, 1);
        assert.equal(products[0].name, 'Cake');
        assert.equal(products[0].price, 499.5);
        assert.equal(products[0].active, false);
    });

    it('the platform rule switches the catalog off', async () => {
        const policy = state.platformPolicy;
        state.platformPolicy = () => ({ ...policy(), 'channels.allowCatalog': false });
        try {
            const res = await call('GET', `/api/channels/${channelId}/catalog`);
            assert.equal(res.status, 403);
            assert.equal(res.body.code, 'catalog_disabled');
        } finally {
            state.platformPolicy = policy;
        }
    });

    it('needs the WhatsApp Catalog service the super admin switches on', async () => {
        const before = tenantServices();
        services(before.filter((s) => s !== 'catalog'));
        try {
            const res = await call('GET', `/api/channels/${channelId}/catalog?refresh=1`);
            assert.equal(res.status, 403);
            assert.equal(res.body.code, 'catalog_disabled');
            assert.match(res.body.errors[0], /not switched on for your account/);
        } finally {
            services(before);
        }
    });

    it('a cart sent from the catalog becomes an Orders record and is answered once', async () => {
        state.transport.getOrderDetails = async (orderId, token) => {
            assert.equal(orderId, 'o1');
            assert.equal(token, 'tok');
            return { price: { total: 120000, currency: 'INR' }, products: [{ id: 'p1', name: 'Brownie', price: 60000, currency: 'INR', quantity: 2 }] };
        };
        const buyer = '919800000077';
        const message = {
            messageId: 'in.catalog.1', sender: buyer, senderName: 'Asha', body: 'Order: 2 items', mediaType: 'order',
            order: { orderId: 'o1', token: 'tok', itemCount: 2, total: 120, currency: 'INR', note: '' },
        };
        await state.transport.events.emit('inbound', message);
        await state.transport.events.emit('inbound', message); // a redelivery
        await new Promise((r) => setTimeout(r, 100));
        const orders = state.objects.list({ type: 'order', limit: 10 }).filter((o) => o.metadata?.catalogOrderId);
        assert.equal(orders.length, 1);
        assert.match(orders[0].reference, /^WA-[A-Z0-9]{5}$/);
        assert.equal(orders[0].data.amount, 120);
        assert.match(orders[0].data.items, /2 x Brownie/);
        assert.equal(orders[0].metadata.catalogOrderId, 'o1');
        const replies = db.db.prepare('SELECT message FROM messages WHERE recipient LIKE ?').all(`%${buyer.slice(-10)}%`).map((r) => r.message);
        assert.equal(replies.filter((m) => m.includes(`We received your order ${orders[0].reference}`)).length, 1);
    });

    // What the Baileys transport returns (transports/baileys.js catalog()): every picture, sale price, profile.
    const image = (name) => ({ original: `https://cdn.test/${name}.jpg`, requested: `https://cdn.test/${name}-800.jpg` });
    const FULL = {
        business: { name: 'Bakes', description: 'Home bakery', category: 'Bakery', address: '', email: '', websites: ['https://bakes.test'], hours: null },
        products: [
            {
                id: 'f1', name: 'Tart', description: 'Lemon', price: 250000, salePrice: 199000, currency: 'INR', url: 'https://bakes.test/tart',
                retailerId: 'T1', isHidden: false, reviewStatus: { whatsapp: 'REJECTED' }, canAppeal: true, availability: 'out of stock',
                images: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(image),
            },
            { id: 'f2', name: 'Bun', description: '', price: 20000, salePrice: null, currency: 'INR', images: [], isHidden: false, reviewStatus: { whatsapp: '' } },
        ],
        collections: [{ id: 'c1', name: 'Sweet', productIds: ['f1'], status: 'APPROVED', canAppeal: false, truncated: false }],
        truncated: true,
    };

    it('returns everything the catalog holds: profile, link, every picture, sale price, review and collections', async () => {
        state.info = { ...state.info, accountType: null, account: '919800000001' }; // unknown is asked, not refused
        state.transport.catalog = async () => FULL;
        const { status, body } = await call('GET', `/api/channels/${channelId}/catalog?refresh=1`);
        assert.equal(status, 200);
        assert.deepEqual(body.business, FULL.business);
        assert.equal(body.link, 'https://wa.me/c/919800000001');
        assert.deepEqual([body.total, body.truncated], [2, true]);
        assert.deepEqual(body.collections, FULL.collections);
        const [tart, bun] = body.products;
        assert.equal(tart.images.length, 7);
        assert.equal(tart.images[6], `/api/channels/${channelId}/catalog/image?p=f1&i=6`);
        assert.deepEqual(
            [tart.price, tart.salePrice, tart.status, tart.canAppeal, tart.availability, tart.url, tart.retailerId, tart.collectionIds],
            [250, 199, 'REJECTED', true, 'out of stock', 'https://bakes.test/tart', 'T1', ['c1']]);
        assert.deepEqual([bun.salePrice, bun.canAppeal, bun.availability, bun.collectionIds, bun.image], [null, false, '', [], null]);
    });

    it('another number linked on the channel is not shown the last number\'s catalog', async () => {
        state.transport.connected = true;
        let calls = 0;
        state.transport.catalog = async () => { calls += 1; return FULL; };
        state.info = { ...state.info, account: '919800000002' };
        assert.equal((await call('GET', `/api/channels/${channelId}/catalog`)).body.link, 'https://wa.me/c/919800000002');
        await call('GET', `/api/channels/${channelId}/catalog`);
        assert.equal(calls, 1);
    });

    it('imports every picture up to the shop limit, falling back to the resized one', async () => {
        state.transport.connected = true;
        const real = globalThis.fetch;
        const asked = [];
        globalThis.fetch = async (url, ...rest) => {
            if (!String(url).startsWith('https://cdn.test/')) return real(url, ...rest);
            asked.push(String(url));
            // the first picture's original is gone from the CDN
            if (String(url) === 'https://cdn.test/a.jpg') return new Response('gone', { status: 404, headers: { 'content-type': 'text/plain' } });
            return new Response(Buffer.from('ffd8ffe0', 'hex'), { headers: { 'content-type': 'image/jpeg' } });
        };
        try {
            const res = await call('POST', `/api/channels/${channelId}/catalog/import`, { ids: ['f1'] });
            assert.deepEqual(res.body, { created: 1, skipped: 0 });
            const tart = (await call('GET', '/api/shop/order')).body.products.find((p) => p.name === 'Tart');
            assert.equal(tart.images.length, 5);
            assert.equal(tart.price, 250);
            assert.deepEqual(asked.slice(0, 3), ['https://cdn.test/a.jpg', 'https://cdn.test/a-800.jpg', 'https://cdn.test/b.jpg']);
        } finally {
            globalThis.fetch = real;
        }
    });

    it('passes on why WhatsApp refused, and an empty catalog is not an error', async () => {
        state.transport.connected = true;
        state.transport.catalog = async () => { throw Object.assign(new Error('WhatsApp refused the catalog request (403 forbidden).'), { code: 'catalog_failed' }); };
        const refused = await call('GET', `/api/channels/${channelId}/catalog?refresh=1`);
        assert.equal(refused.status, 502);
        assert.deepEqual(refused.body, { errors: ['WhatsApp refused the catalog request (403 forbidden).'], code: 'catalog_failed' });
        state.transport.catalog = async () => { throw Object.assign(new Error('not a WhatsApp Business number'), { code: 'not_business' }); };
        assert.equal((await call('GET', `/api/channels/${channelId}/catalog?refresh=1`)).body.code, 'not_business');
        state.transport.catalog = async () => ({ business: null, products: [], collections: [], truncated: false });
        const empty = await call('GET', `/api/channels/${channelId}/catalog?refresh=1`);
        assert.equal(empty.status, 200);
        assert.deepEqual([empty.body.products, empty.body.total, empty.body.truncated, empty.body.business], [[], 0, false, null]);
    });

    it('creates, updates and deletes a catalog product through WhatsApp', async () => {
        state.info = { ...state.info, accountType: 'business' };
        state.transport.connected = true;
        state.transport.createProduct = async (p) => ({ id: 'w1', name: p.name, price: 50000, currency: 'INR' });
        state.transport.updateProduct = async (id, p) => ({ id, name: p.name, price: 60000, currency: 'INR' });
        state.transport.deleteProduct = async (id) => ({ deleted: true, id });
        let cacheCleared = false;
        const origBroadcast = state.broadcast;
        state.broadcast = (msg) => { if (msg.topic === 'catalog') cacheCleared = true; origBroadcast(msg); };

        const created = await call('POST', `/api/channels/${channelId}/catalog/products`, {
            name: 'Brownie', description: 'Fudgy', price: 50, currency: 'INR', url: '', retailerId: '', availability: 'in stock', hidden: false, salePrice: 0,
        });
        assert.equal(created.status, 201);
        assert.deepEqual(created.body, { id: 'w1', name: 'Brownie', description: '', price: 50, salePrice: null, currency: 'INR' });
        assert.ok(cacheCleared, 'cleared the catalog cache');

        const updated = await call('PUT', `/api/channels/${channelId}/catalog/products/w1`, {
            name: 'Brownie', description: 'Fudgy', price: 60, currency: 'INR', url: '', retailerId: '', availability: 'in stock', hidden: false, salePrice: 0,
        });
        assert.equal(updated.status, 200);
        assert.deepEqual(updated.body, { id: 'w1', name: 'Brownie', description: '', price: 60, salePrice: null, currency: 'INR' });

        const deleted = await call('DELETE', `/api/channels/${channelId}/catalog/products/w1`);
        assert.equal(deleted.status, 204);
        assert.equal(deleted.body, null);

        state.broadcast = origBroadcast;
    });

    it('saves a product with its pictures: uploaded ones by file, kept ones by their catalog address', async () => {
        state.info = { ...state.info, accountType: 'business' };
        state.transport.connected = true;
        const mediaId = 'med_0123456789ab';
        fs.mkdirSync(state.media.uploadDir, { recursive: true });
        fs.writeFileSync(path.join(state.media.uploadDir, `${mediaId}_new.jpg`), Buffer.from([0xff, 0xd8, 0xff]));
        state.media.claim(mediaId);
        state.catalogCache = null;
        state.transport.catalog = async () => ({ business: null, collections: [], truncated: false, products: [
            { id: 'k1', name: 'Kept', price: 1000, currency: 'INR', images: [{ original: 'https://cdn.whatsapp.net/a.jpg', requested: '' }, { original: 'https://cdn.whatsapp.net/b.jpg', requested: '' }] },
        ] });
        const sent = [];
        state.transport.createProduct = async (p) => { sent.push(p.images); return { id: 'n1', name: p.name, price: 1000, currency: 'INR' }; };
        state.transport.updateProduct = async (id, p) => { sent.push(p.images); return { id, name: p.name, price: 1000, currency: 'INR' }; };
        const base = { name: 'Brownie', price: 1, currency: 'INR' };

        assert.equal((await call('POST', `/api/channels/${channelId}/catalog/products`, { ...base, images: [mediaId] })).status, 201);
        assert.equal(sent[0].length, 1);
        assert.ok(sent[0][0].path.endsWith(`${mediaId}_new.jpg`));
        // editing: the second picture first, then a new one; the first is dropped
        const kept = `/api/channels/${channelId}/catalog/image?p=k1&i=1`;
        assert.equal((await call('PUT', `/api/channels/${channelId}/catalog/products/k1`, { ...base, images: [kept, mediaId] })).status, 200);
        assert.equal(sent[1][0].url, 'https://cdn.whatsapp.net/b.jpg');
        assert.ok(sent[1][1].path);
        // no pictures named: WhatsApp keeps what the product has
        await call('PUT', `/api/channels/${channelId}/catalog/products/k1`, base);
        assert.equal(sent[2], undefined);
        // refused: not an upload, a picture the product does not have, too many
        for (const images of [['med_ffffffffffff'], [`/api/channels/${channelId}/catalog/image?p=k1&i=7`], Array(11).fill(mediaId)]) {
            const res = await call('POST', `/api/channels/${channelId}/catalog/products`, { ...base, images });
            assert.equal(res.status, 400, JSON.stringify(res.body));
        }
        // a server with no write set up says so in words, not a 500
        state.transport.createProduct = async () => { throw Object.assign(new Error('catalog writes are not configured'), { code: 'catalog_failed' }); };
        const off = await call('POST', `/api/channels/${channelId}/catalog/products`, base);
        assert.equal(off.status, 501);
        assert.match(off.body.errors[0], /not set up on this server yet/);
    });

    it('refuses catalog writes when the number is not a business', async () => {
        state.info = { ...state.info, accountType: 'personal' };
        state.transport.connected = true;
        const res = await call('POST', `/api/channels/${channelId}/catalog/products`, { name: 'x', price: 1 });
        assert.equal(res.status, 409);
        assert.equal(res.body.code, 'not_business');
    });

    it('refuses catalog writes when the catalog service is off', async () => {
        state.info = { ...state.info, accountType: 'business' };
        const before = tenantServices();
        services(before.filter((s) => s !== 'catalog'));
        try {
            const res = await call('POST', `/api/channels/${channelId}/catalog/products`, { name: 'x', price: 1 });
            assert.equal(res.status, 403);
            assert.equal(res.body.code, 'catalog_disabled');
        } finally {
            services(before);
        }
    });
});
