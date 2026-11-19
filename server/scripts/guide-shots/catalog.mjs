/**
 * Shot plan for the WhatsApp Catalog guide (/catalog). See ../guide-shots.mjs for the plan shape.
 *
 * The sandbox number has no WhatsApp Business app, so the catalog can never be read for real here. The browser's
 * calls for the number list, the catalog, its pictures and the import are answered in the page (request
 * interception) with a believable catalog: the screens are the real ones, only the data WhatsApp would send is
 * stood in. `mode` picks which numbers the list shows for the task at hand.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const LANDING = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'public', 'assets', 'landing');
const D = 'aside.drawer';

/** [id, name, description, price, picture: [file, left, top, width, height], hidden] */
const PRODUCTS = [
    ['p1', 'Indigo block-print bedsheet', 'Double bed, 100% cotton, with two pillow covers.', 2499, ['hero-shop.jpg', 1110, 630, 430, 300]],
    ['p2', 'Chikankari cotton kurta', 'Hand-embroidered, relaxed fit. Sizes S to XXL.', 1899, ['hero-shop.jpg', 690, 430, 360, 360]],
    ['p3', 'Hand-block printed shirt', 'Soft mul cotton, full sleeves.', 1499, ['hero-shop.jpg', 1495, 220, 177, 330]],
    ['p4', 'Handloom cotton saree', 'Woven in Bengal, with blouse piece.', 3290, ['hero-shop.jpg', 985, 290, 190, 200]],
    ['p5', 'Terracotta tumbler set of 4', 'Hand-thrown, food safe. 250 ml each.', 799, ['clay-studio.jpg', 105, 810, 390, 260]],
    ['p6', 'Ceramic flower vase', 'Matte glaze, 22 cm tall.', 1150, ['clay-studio.jpg', 790, 0, 210, 210]],
    ['p7', 'Brass planter pot', 'Hand-beaten brass, 30 cm across.', 3450, ['hero-music.jpg', 0, 610, 125, 220], true],
    ['p8', 'Metal pendant lamp', 'Matte black shade, 35 cm, bulb included.', 2199, ['hero-studio.jpg', 1235, 40, 160, 160]],
];
const COLLECTIONS = [
    { id: 'c1', name: 'Clothing', productIds: ['p1', 'p2', 'p3', 'p4'] },
    { id: 'c2', name: 'Home & decor', productIds: ['p5', 'p6', 'p7', 'p8'] },
];

let mode = 'main'; // main: Business + regular number; fix: offline + unknown; none: no active number
let real = null; // the sandbox channel as the server lists it
const pictures = new Map();

/** The numbers the page should see in this mode, built on the real sandbox channel. */
function channels() {
    const like = (id, displayName, phoneNumber, health) => ({
        ...real, id, displayName, phoneNumber, health: { ...real.health, account: phoneNumber, ...health },
    });
    // The shell's link-a-number gate opens when no number is connected: keep the real one, just not active (the page lists active ones).
    if (mode === 'none') return [{ ...real, status: 'paused' }];
    if (mode === 'fix') {
        return [
            like(9002, 'Sunrise Warehouse', '919810000260', { connected: false, accountType: null }),
            like(9003, 'Sunrise Pop-up', '919810000270', { connected: true, accountType: null }),
        ];
    }
    return [
        { ...real, health: { ...real.health, connected: true, accountType: 'business' } },
        like(9001, 'Sunrise Outlet', '919810000250', { connected: true, accountType: 'personal' }),
    ];
}

const catalog = (channelId) => ({
    fetchedAt: new Date().toISOString(),
    collections: COLLECTIONS,
    products: PRODUCTS.map(([id, name, description, price, , hidden]) => {
        const image = `/api/channels/${channelId}/catalog/image?p=${id}&i=0`;
        return { id, name, description, price, currency: 'INR', image, images: [image], url: '', retailerId: id.toUpperCase(), hidden: Boolean(hidden), status: 'APPROVED' };
    }),
});

async function answer(req) {
    if (req.isInterceptResolutionHandled()) return;
    const url = new URL(req.url());
    const p = url.pathname;
    const json = (body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (req.method() === 'GET' && p === '/api/channels' && real) return json({ channels: channels() });
    let m = p.match(/^\/api\/channels\/(\d+)\/catalog$/);
    if (m && req.method() === 'GET') return json(catalog(m[1]));
    if (/^\/api\/channels\/\d+\/catalog\/image$/.test(p) && pictures.has(url.searchParams.get('p'))) {
        return req.respond({ status: 200, contentType: 'image/jpeg', body: pictures.get(url.searchParams.get('p')) });
    }
    m = p.match(/^\/api\/channels\/(\d+)\/catalog\/import$/);
    if (m && req.method() === 'POST') {
        const ids = JSON.parse(req.postData() ?? '{}').ids ?? [];
        return json({ created: ids.length, skipped: 0 });
    }
    return req.continue();
}

const start = async (h) => {
    await h.page.setRequestInterception(true);
    h.page.on('request', answer);
};
const stop = async (h) => {
    h.page.off('request', answer);
    await h.page.setRequestInterception(false);
};
/** Open the Business number's catalog drawer and let the pictures arrive. */
const openCatalog = async (h) => {
    await h.click({ selector: 'li.row:not(.locked) .state button.primary' });
    await h.settle(1200);
};
const type = (h, value) => h.page.evaluate((sel, v) => {
    const el = document.querySelector(sel);
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}, `${D} .toolbar input[type=search]`, value).then(() => h.settle(400));

export default {
    async setup(h) {
        for (const [id, , , , [file, left, top, width, height]] of PRODUCTS) {
            pictures.set(id, await sharp(path.join(LANDING, file)).extract({ left, top, width, height })
                .resize(400, 400, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer());
        }
        const { channels: list = [] } = await h.api('GET', '/api/channels');
        real = list.find((c) => c.status === 'active') ?? list[0] ?? null;
        // Two orders customers sent from their WhatsApp cart, the way the catalog route records them.
        const carts = [
            ['919810000102', [['Chikankari cotton kurta', 1, 1899], ['Hand-block printed shirt', 2, 1499]]],
            ['919810000104', [['Terracotta tumbler set of 4', 1, 799]]],
        ];
        for (const [i, [phone, lines]] of carts.entries()) {
            const total = lines.reduce((s, [, qty, price]) => s + qty * price, 0);
            await h.api('POST', '/api/objects/order', {
                reference: `WA-${['K7Q2M', 'R4T9X'][i]}`, status: 'placed',
                metadata: { source: 'whatsapp', phone, lines: lines.map(([name, qty, price]) => ({ name, qty, price })), total, payment: 'none', catalogOrderId: `guide-${i}` },
                data: { amount: total, currency: 'INR', items: lines.map(([name, qty, price]) => `${qty} x ${name} - ₹${(qty * price).toLocaleString('en-IN')}`).join('\n') },
            });
        }
        await start(h);
    },
    tasks: {
        1: {
            before: async (h) => { mode = 'main'; await h.goto('/catalog'); },
            steps: {
                1: { ring: { selector: 'ul.list[aria-label="Your numbers"]' }, click: false },
                2: { ring: { selector: 'li.row:not(.locked) .state button.primary' }, click: true },
                3: { act: (h) => h.settle(1200), ring: { selector: `${D} label.product:has(.hidden-pill)` }, click: false },
            },
        },
        2: {
            before: openCatalog,
            steps: {
                1: { act: (h) => type(h, 'kurta'), ring: { selector: `${D} .toolbar label.search` }, click: false },
                2: {
                    act: async (h) => { await type(h, ''); await h.click({ selector: `${D} .chips button.s-chip:nth-child(2)` }); await h.settle(800); },
                    ring: { selector: `${D} .chips` },
                    click: false,
                },
                3: { ring: { selector: `${D} .toolbar > button.btn` }, click: false },
            },
        },
        3: {
            before: openCatalog,
            steps: {
                1: {
                    act: async (h) => {
                        for (const id of ['p2', 'p5']) {
                            await h.page.evaluate((n) => document.querySelector(`aside.drawer input.pick[aria-label="Pick ${n}"]`)?.click(), PRODUCTS.find((p) => p[0] === id)[1]);
                        }
                        await h.settle(400);
                    },
                    ring: { selector: `${D} .foot-actions button.btn:not(.primary)` },
                    click: true,
                },
                2: { ring: { selector: `${D} .foot-actions button.primary` }, click: true },
                3: { act: (h) => h.settle(600), ring: { selector: `${D} .drawer-foot .ok a` }, click: false },
            },
        },
        4: {
            steps: {
                1: { ring: { selector: '.perks li:nth-child(2)' }, click: false },
                2: {
                    act: async (h) => {
                        await h.goto('/records/order');
                        await h.click({ selector: '.views button[role=tab]:nth-child(2)' });
                        await h.settle(1000);
                    },
                    ring: { selector: 'section[aria-labelledby=ord-h]' },
                    click: false,
                },
            },
        },
        5: {
            steps: {
                1: { ring: { selector: 'li.row.locked .state button' }, click: true },
                2: { ring: { selector: '.dialog ol.steps' }, click: false },
                3: { ring: { selector: '.dialog .dialog-actions button.primary' }, click: false },
            },
        },
        6: {
            before: async (h) => { mode = 'fix'; await h.goto('/catalog'); },
            steps: {
                1: { ring: { selector: 'ul.list > li:nth-child(1) .state a.btn' }, click: false },
                2: { ring: { selector: 'ul.list > li:nth-child(2) .state a.btn' }, click: false },
                3: {
                    act: async (h) => { mode = 'none'; await h.goto('/catalog'); },
                    ring: { selector: '.s-empty a.btn.primary' },
                    click: false,
                    after: async (h) => { mode = 'main'; await stop(h); },
                },
            },
        },
    },
};
