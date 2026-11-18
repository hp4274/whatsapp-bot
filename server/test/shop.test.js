/**
 * The WhatsApp shop end to end: products in, MENU -> pick -> option -> CHECKOUT -> address -> order with the
 * UPI payment, PAID, the business confirming it, STATUS; then the booking mode and INFO.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { parseWhen } from '../src/shop/bot.js';
import { ShopStore } from '../src/shop/store.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-shop-'));
let app;
let server;
let base;
let db;
let owner;
let transport;

const call = async (method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${owner}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const sentTo = (phone) => db.db.prepare('SELECT message FROM messages WHERE recipient LIKE ? ORDER BY rowid')
    .all(`%${phone.slice(-10)}%`).map((r) => r.message);
const last = (phone) => sentTo(phone).at(-1) ?? '';
const say = async (from, body, extra = {}) => {
    await transport.events.emit('inbound', { messageId: `in.${Math.random()}`, sender: from, senderName: 'Asha', body, ...extra });
    await new Promise((r) => setTimeout(r, 50));
};

before(async () => {
    db = new Database(path.join(tmp, 's.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connection/connect`, { method: 'POST' });
    const rt = app.locals.runtimeFor(1);
    transport = rt.runtimeFor(rt.channels.getDefault()).state.transport;
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('shop', () => {
    const buyer = '919800000001';

    const services = (list) => app.locals.tenancy.db.prepare('UPDATE tenants SET services = ? WHERE id = 1').run(JSON.stringify(list));
    const others = () => app.locals.tenancy.getTenant(1).services.filter((x) => x !== 'orders' && x !== 'appointments');

    it('belongs to the Orders service: without it, nothing answers even when switched on', async () => {
        services(others());
        assert.equal((await call('GET', '/api/shop/order')).status, 403, 'its routes answer "disabled"');
        new ShopStore(db.forTenant(1)).saveSettings('order', { enabled: true });
        new ShopStore(db.forTenant(1)).saveProduct('order', { name: 'Brownie', price: 60 });
        await say(buyer, 'MENU');
        assert.doesNotMatch(last(buyer), /add it to your cart|Reply with a number/);
        assert.equal((await fetch(`${base}/api/shop/nope`, { headers: { authorization: `Bearer ${owner}` } })).status, 404);
    });

    it('with Orders and Appointments: MENU is the HELP list until the owner switches it on', async () => {
        services([...others(), 'orders', 'appointments']);
        db.db.prepare('DELETE FROM shop_config').run();
        db.db.prepare('DELETE FROM shop_items').run();
        await say(buyer, 'MENU');
        assert.doesNotMatch(last(buyer), /add it to your cart/);
    });

    it('takes an order from the menu to the payment, then PAID, confirm and STATUS', async () => {
        const bad = await call('PUT', '/api/shop/order/settings', { upiId: 'not a upi' });
        assert.equal(bad.status, 400);
        assert.equal((await call('PUT', '/api/shop/order/settings', {
            enabled: true, title: 'Asha Bakes', upiId: 'asha@okbank', payeeName: 'Asha', deliveryFee: 40,
        })).status, 200);
        await call('POST', '/api/shop/order/products', { name: 'Brownie', price: 60, category: 'Cakes' });
        await call('POST', '/api/shop/order/products', { name: 'Cake', price: 500, variants: [{ name: '500 g', price: 500 }, { name: '1 kg', price: 900 }] });

        await say(buyer, 'menu');
        assert.match(last(buyer), /Asha Bakes[\s\S]*1\. Brownie - ₹60[\s\S]*2\. Cake - from ₹500/);
        await say(buyer, '1 x 3');
        assert.match(last(buyer), /Added 3 x Brownie[\s\S]*Total: ₹220/);
        await say(buyer, '2');
        assert.match(last(buyer), /1\. 500 g - ₹500\n2\. 1 kg - ₹900/);
        await say(buyer, '2');
        assert.match(last(buyer), /1 x Cake \(1 kg\) - ₹900[\s\S]*Total: ₹1,120/);
        await say(buyer, 'remove 1');
        assert.doesNotMatch(last(buyer), /Brownie/);
        await say(buyer, 'checkout');
        assert.match(last(buyer), /delivery address/);
        await say(buyer, '12 MG Road, Pune 411001');
        await new Promise((r) => setTimeout(r, 500)); // the QR image is drawn first
        assert.match(last(buyer), /Order \*ORD-[A-Z0-9]{5}\* placed[\s\S]*Total: ₹940[\s\S]*upi:\/\/pay\?pa=asha%40okbank[^ ]*am=940/);

        const { orders } = (await call('GET', '/api/shop/order')).body;
        assert.equal(orders.length, 1);
        assert.equal(orders[0].data.amount, 940);
        assert.equal(orders[0].metadata.payment, 'pending');
        assert.equal(orders[0].data.notes, '12 MG Road, Pune 411001');

        await say(buyer, 'PAID');
        assert.match(last(buyer), /check the payment/);
        assert.equal((await call('GET', '/api/shop/order')).body.orders[0].metadata.payment, 'claimed');

        assert.equal((await call('POST', `/api/shop/booking/orders/${orders[0].id}`, { payment: 'paid' })).status, 404, 'an order is not a booking');
        const confirmed = await call('POST', `/api/shop/order/orders/${orders[0].id}`, { payment: 'paid' });
        assert.equal(confirmed.body.order.status, 'confirmed', 'paying a new order confirms it');
        assert.equal(confirmed.body.notified, true);
        assert.match(last(buyer), /Payment received[\s\S]*is confirmed/);

        await say(buyer, 'where is my order');
        assert.match(last(buyer), /ORD-[A-Z0-9]{5} - Confirmed - ₹940 \(paid\)/);
    });

    it('a bare number with no cart is not the shop\'s', async () => {
        const stranger = '919800000002';
        await say(stranger, '2');
        assert.doesNotMatch(last(stranger), /Added|choose one/);
    });

    it('takes bookings beside orders, each from its own list, and answers INFO', async () => {
        await call('PUT', '/api/shop/booking/settings', { enabled: true, payNow: false, info: 'Open 10-7, Baner Road, Pune' });
        await call('POST', '/api/shop/booking/products', { name: 'Haircut', price: 300 });
        const client = '919800000003';
        await say(client, 'book');
        assert.match(last(client), /1\. Haircut - ₹300[\s\S]*Reply with a number to book/);
        assert.doesNotMatch(last(client), /Brownie/, 'products stay on the order list');
        await say(client, '1');
        assert.match(last(client), /When would you like to come/);
        await say(client, 'whenever');
        assert.match(last(client), /could not read/);
        await say(client, 'tomorrow 11am');
        assert.match(last(client), /Booking \*BK-[A-Z0-9]{5}\* received/);
        const { orders } = (await call('GET', '/api/shop/booking')).body;
        assert.equal(orders[0].type, 'appointment');
        assert.equal(orders[0].data.service, 'Haircut');
        await say(client, 'menu');
        assert.match(last(client), /Asha Bakes[\s\S]*Brownie/, 'MENU still opens the products');
        await say(client, 'info');
        assert.equal(last(client), 'Open 10-7, Baner Road, Pune');
    });

    describe('pictures and the carousel', () => {
        let state;
        const picture = (name, ext = 'png') => {
            const mediaId = `med_${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}${Math.random().toString(16).slice(2, 8).padEnd(6, '0')}`;
            fs.mkdirSync(state.media.uploadDir, { recursive: true });
            fs.writeFileSync(path.join(state.media.uploadDir, `${mediaId}_${name}.${ext}`), 'x');
            state.media.claim(mediaId);
            return mediaId;
        };
        /** What the transport was handed, newest last: the queued job's interactive block rides along. */
        const handed = [];
        before(() => {
            const rt = app.locals.runtimeFor(1);
            state = rt.runtimeFor(rt.channels.getDefault()).state;
            const send = transport.sendMessage.bind(transport);
            transport.sendMessage = (to, text, options = {}) => {
                handed.push({ to, text, interactive: options.interactive ?? null });
                return send(to, text, options);
            };
        });
        const lastJob = async (phone) => {
            await new Promise((r) => setTimeout(r, 300));
            return handed.filter((h) => h.to.endsWith(phone.slice(-10))).at(-1);
        };

        it('keeps several pictures per product in order, and reads an old single picture as the first', async () => {
            const [a, b, c] = [picture('a'), picture('b'), picture('c')];
            const made = await call('POST', '/api/shop/booking/products', { name: 'Facial', price: 800, images: [b, a, c] });
            assert.equal(made.status, 201);
            assert.deepEqual(made.body.product.images, [b, a, c]);
            const listed = (await call('GET', '/api/shop/booking')).body.products.find((p) => p.name === 'Facial');
            assert.deepEqual(listed.images, [b, a, c]);
            assert.equal((await call('POST', '/api/shop/booking/products', { name: 'X', images: [a, b, c, picture('d'), picture('e'), picture('f')] })).status, 400, 'up to 5');
            assert.equal((await call('POST', '/api/shop/booking/products', { name: 'X', images: [picture('doc', 'pdf')] })).status, 400, 'pictures only');
            db.db.prepare("UPDATE shop_items SET images = '[]', media_id = ? WHERE name = 'Facial'").run(c);
            assert.deepEqual(new ShopStore(db.forTenant(1)).products('booking').find((p) => p.name === 'Facial').images, [c]);
            await call('DELETE', `/api/shop/booking/products/${listed.id}`);
        });

        it('MENU with fewer than 2 pictured products is the plain list', async () => {
            const who = '919800000011';
            const { products } = (await call('GET', '/api/shop/order')).body;
            await call('PUT', `/api/shop/order/products/${products[0].id}`, { ...products[0], images: [picture('brownie')] });
            await say(who, 'MENU');
            const job = await lastJob(who);
            assert.match(job.text, /1\. Brownie/);
            assert.equal(job.interactive, null);
        });

        it('MENU with pictured products sends the list with a carousel; a tap adds that item', async () => {
            const who = '919800000012';
            for (const name of ['Muffin', 'Cookie', 'Tart', 'Pie', 'Donut']) {
                await call('POST', '/api/shop/order/products', { name, price: 50, images: [picture(name)] });
            }
            await say(who, 'menu');
            const job = await lastJob(who);
            assert.match(job.text, /1\. Brownie[\s\S]*2\. Cake[\s\S]*7\. Donut/, 'the numbered list is the message text');
            assert.equal(job.interactive?.type, 'carousel');
            const { cards } = job.interactive.carousel;
            assert.equal(cards.length, 5, 'Brownie and four of the five new ones; Cake has no picture');
            assert.deepEqual(cards.map((c) => c.buttons[0].id), ['SHOP_1', 'SHOP_3', 'SHOP_4', 'SHOP_5', 'SHOP_6']);
            assert.equal(cards[1].text, '3. Muffin - ₹50');
            assert.equal(cards[1].buttons[0].title, 'Add 3');
            assert.ok(cards.every((c) => c.media?.filePath), 'each card carries its file');

            await say(who, 'Add 3', { replyId: 'SHOP_3' });
            assert.match(last(who), /Added 1 x Muffin/);
            await say(who, 'Add 4');
            assert.match(last(who), /Added 1 x Cookie[\s\S]*Muffin/);
            await say('919800000013', 'Add 3', { replyId: 'SHOP_3' });
            assert.doesNotMatch(last('919800000013'), /Added/, 'no live cart, no pick');
        });
    });

    it('reads dates and times in the business time zone', () => {
        const now = new Date('2026-11-18T06:00:00Z'); // 11:30 in Kolkata
        assert.equal(parseWhen('25/11 4pm', 'Asia/Kolkata', now).toISOString(), '2026-11-25T10:30:00.000Z');
        assert.equal(parseWhen('tomorrow 11:30 am', 'Asia/Kolkata', now).toISOString(), '2026-11-19T06:00:00.000Z');
        assert.equal(parseWhen('1/2 10am', 'UTC', now).toISOString(), '2027-02-01T10:00:00.000Z', 'a passed date means next year');
        assert.equal(parseWhen('3', 'UTC', now), null);
        assert.equal(parseWhen('soon', 'UTC', now), null);
    });
});
