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
});
