/**
 * Shot plan for the Orders guide. See ../guide-shots.mjs for the plan shape.
 * Also exports the helpers the Appointments and Leads plans share (same Records page, same shop panel).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ------------------------------------------------------------ helpers --

/** Set an input / select / textarea the way a person would (Angular's ngModel hears `input` and `change`). */
export const setVal = (h, selector, value) => h.page.evaluate((sel, val) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.checkVisibility?.());
    if (!el) return false;
    el.scrollIntoView({ block: 'center' });
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
        : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(val));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}, selector, value);

/** Tick a checkbox (once). */
export const tick = (h, selector) => h.page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el && !el.checked) el.click();
}, selector);

/** Tag each Records drawer field with data-f="<its label>" (bound [name]s go to ngModel, not the DOM). */
export const markFields = (h) => h.page.evaluate(() => {
    for (const f of document.querySelectorAll('.drawer label.field')) {
        f.dataset.f = (f.querySelector('.lbl')?.textContent ?? '').replace('*', '').trim().toLowerCase();
    }
});
/** A field on the Records drawer, by its label: the whole labelled field (run markFields first). */
export const recField = (label) => ({ selector: `.drawer label.field[data-f="${label.toLowerCase()}"]` });
/** Fill a Records drawer field by its label. */
export const fill = async (h, label, value) => {
    await markFields(h);
    return setVal(h, `.drawer label.field[data-f="${label.toLowerCase()}"] :is(input, select)`, value);
};

/** "YYYY-MM-DDTHH:mm" some days from now, for datetime-local inputs. */
export const localAt = (days, hour = 11) => {
    const d = new Date(Date.now() + days * 864e5);
    d.setHours(hour, 0, 0, 0);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:00`;
};

/** Open a record row by its aria-label ("Open Order demo-order-2"). */
export const openRow = async (h, label) => {
    await h.page.evaluate((l) => document.querySelector(`.rec tbody tr[aria-label="${l}"]`)?.click(), label);
    await h.settle(1200);
};

/** Search the drawer's Customer box and pick the first match. */
export const pickCustomer = async (h, q) => {
    await h.type('.drawer input[name="customerSearch"]', q);
    await h.settle(1200);
};
export const pickFirstCustomer = async (h) => {
    await h.page.evaluate(() => document.querySelector('#cust-results li button')?.click());
    await h.settle(500);
};

export const onWhatsAppTab = async (h) => {
    await h.page.evaluate(() => [...document.querySelectorAll('.views [role=tab]')].at(-1)?.click());
    await h.settle(1500);
};

const token = (h) => h.page.evaluate(() => localStorage.getItem('wsender.token'));

/** A simple product picture (PNG) drawn in a spare tab, saved to disk; returns its path. */
export async function picture(h, label, hue) {
    const tab = await h.page.browser().newPage();
    await tab.setViewport({ width: 480, height: 480 });
    await tab.setContent(`<body style="margin:0;width:480px;height:480px;display:grid;place-items:center;font:600 34px system-ui;
        background:linear-gradient(135deg,hsl(${hue} 70% 82%),hsl(${hue + 40} 65% 62%));color:hsl(${hue} 45% 22%)">
        <div style="text-align:center"><div style="width:190px;height:190px;margin:0 auto 22px;border-radius:38px;
        background:hsl(${hue} 60% 96% / .75);box-shadow:0 18px 40px hsl(${hue} 50% 30% / .25)"></div>${label}</div></body>`);
    const file = path.join(os.tmpdir(), `guide-pic-${label.replace(/\W+/g, '-').toLowerCase()}.png`);
    await tab.screenshot({ path: file, type: 'png' });
    await tab.close();
    return file;
}

/** Upload a picture file the way the page does; returns its media id. */
export async function upload(h, file) {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)], { type: 'image/png' }), path.basename(file));
    const res = await fetch(`${h.base}/api/media/upload`, { method: 'POST', headers: { authorization: `Bearer ${await token(h)}` }, body: form });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) console.warn('upload', res.status, JSON.stringify(json).slice(0, 200));
    return json.mediaId;
}

/** Products (or services) with pictures, plus a few orders that "came in on WhatsApp". */
export async function seedShop(h, mode, items, orders) {
    const made = [];
    for (const [i, it] of items.entries()) {
        const images = it.hue === undefined ? [] : [await upload(h, await picture(h, it.name, it.hue))];
        const { product } = await h.api('POST', `/api/shop/${mode}/products`, {
            name: it.name, price: it.price, category: it.category ?? '', description: it.description ?? '',
            variants: it.variants ?? [], images, active: true,
        });
        made.push(product);
        void i;
    }
    for (const o of orders) await h.api('POST', `/api/objects/${mode === 'booking' ? 'appointment' : 'order'}`, o);
    return made;
}

// --------------------------------------------------------------- plan --

const ordersTab = { selector: '.views [role=tab]:last-child' };
const catalogCard = 'section[aria-labelledby=cat-h]';
const settingsForm = 'form.s-card.settings';
const ordersCard = 'section[aria-labelledby=ord-h]';
const PRODUCTS = [
    { name: 'Cotton kurta', price: 1299, category: 'Kurtas', hue: 18, variants: [{ name: 'M', price: 1299 }, { name: 'XL', price: 1399 }] },
    { name: 'Silk saree', price: 3290, category: 'Sarees', hue: 330 },
    { name: 'Printed dupatta', price: 449, category: 'Dupattas', hue: 200 },
];
const WA_ORDERS = [
    { status: 'delivered', data: { amount: 449, currency: 'INR', items: '1 x Printed dupatta' }, metadata: { source: 'whatsapp', phone: '919812345671', total: 449, payment: 'paid' } },
    { status: 'confirmed', data: { amount: 3290, currency: 'INR', items: '1 x Silk saree' }, metadata: { source: 'whatsapp', phone: '919812345672', total: 3290, payment: 'none' } },
    { status: 'placed', data: { amount: 2598, currency: 'INR', items: '2 x Cotton kurta (M)' }, metadata: { source: 'whatsapp', phone: '919812345673', total: 2598, payment: 'claimed' } },
];

/** WhatsApp Catalog needs a WhatsApp Business number; the sandbox number is neither, so the catalog is faked in the browser. */
async function fakeCatalog(h, products) {
    const page = h.page;
    const auth = { authorization: `Bearer ${await token(h)}` };
    const listener = async (req) => {
        const url = new URL(req.url());
        try {
            if (url.pathname === '/api/channels' && req.method() === 'GET') {
                const res = await fetch(req.url(), { headers: { ...req.headers(), ...auth } });
                const body = await res.json();
                for (const ch of body.channels ?? []) ch.health = { ...(ch.health ?? {}), connected: true, accountType: 'business' };
                return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            }
            if (/^\/api\/channels\/\d+\/catalog$/.test(url.pathname)) {
                return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({
                    fetchedAt: new Date().toISOString(), collections: [],
                    products: products.map((p, i) => ({
                        id: `wa-${i + 1}`, name: p.name, description: p.category, price: p.price, currency: 'INR',
                        image: p.images?.[0] ? `/api/media/${p.images[0]}` : null, images: [], url: '', retailerId: '', hidden: false, status: 'APPROVED',
                    })),
                }) });
            }
            if (/^\/api\/channels\/\d+\/catalog\/import$/.test(url.pathname)) {
                const ids = JSON.parse(req.postData() ?? '{}').ids ?? [];
                return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ created: ids.length, skipped: 0 }) });
            }
        } catch { /* fall through */ }
        return req.continue();
    };
    await page.setRequestInterception(true);
    page.on('request', listener);
    return async () => { page.off('request', listener); await page.setRequestInterception(false); };
}
let unfake = null;
let made = [];

export default {
    async setup(h) {
        made = await seedShop(h, 'order', PRODUCTS, WA_ORDERS);
        await picture(h, 'Linen shirt', 140); // the file the "Add picture" step uploads
    },
    tasks: {
        // Add an order by hand
        1: {
            steps: {
                1: { ring: { selector: '.rec .s-head button.primary' }, click: true },
                2: {
                    act: (h) => pickCustomer(h, 'Rohan'),
                    ring: { selector: '.drawer .field.customer' }, click: false,
                    after: pickFirstCustomer,
                },
                3: {
                    act: async (h) => {
                        await fill(h, 'Amount', 2598);
                        await fill(h, 'Currency', 'INR');
                        await fill(h, 'Items', 'Cotton kurta x2');
                        await fill(h, 'Delivery at', localAt(3, 17));
                    },
                    ring: recField('Amount'), click: false,
                },
                4: { act: markFields, ring: recField('Status'), click: false },
                5: { ring: { selector: '.drawer .actions button[type=submit]' }, click: true },
            },
        },
        // Move an order along
        2: {
            steps: {
                1: { ring: { selector: '.rec tbody tr[aria-label="Open Order demo-order-2"]' }, click: true },
                2: { act: (h) => fill(h, 'Status', 'shipped'), ring: recField('Status'), click: false },
                3: {
                    act: async (h) => {
                        await fill(h, 'Tracking id', 'DTDC7731299');
                        await fill(h, 'Delivery at', localAt(2, 18));
                    },
                    ring: recField('Tracking id'), click: false,
                },
                4: {
                    act: async (h) => { await h.page.click('.drawer .actions button[type=submit]'); await h.settle(1500); },
                    ring: { selector: '.drawer .saved' }, click: false,
                },
            },
        },
        // See what happened to an order
        3: {
            steps: {
                1: { ring: { selector: '.rec tbody tr[aria-label="Open Order demo-order-2"]' }, click: true },
                2: { act: (h) => h.settle(800), ring: { selector: '.drawer section.timeline' }, click: false },
                3: { ring: { selector: '.drawer .timeline ol' }, click: false },
            },
        },
        // Find an order
        4: {
            steps: {
                1: {
                    act: (h) => h.page.evaluate(() => [...document.querySelectorAll('.rec .chips .s-chip')].find((b) => b.textContent.includes('Shipped'))?.click()),
                    ring: { selector: '.rec .toolbar .chips' }, click: false,
                },
                2: {
                    act: async (h) => {
                        await h.page.evaluate(() => document.querySelector('.rec .chips .s-chip')?.click());
                        await h.type('.rec .toolbar .search input', 'saree');
                    },
                    ring: { selector: '.rec .toolbar .search' }, click: false,
                },
                3: {
                    act: (h) => h.type('.rec .toolbar .search input', 'wedding cake'),
                    ring: { selector: '.rec .tbl .s-empty button' }, click: true,
                },
            },
        },
        // Delete an order
        5: {
            before: (h) => openRow(h, 'Open Order demo-order-5'),
            steps: {
                1: { ring: { selector: '.drawer .actions .danger-ghost' }, click: true },
                2: { act: (h) => h.page.mouse.move(5, 5), ring: { selector: '.drawer .actions .confirm' }, click: false },
            },
        },
        // Take orders on WhatsApp
        6: {
            steps: {
                1: { ring: ordersTab, click: true },
                2: { act: (h) => h.settle(800), ring: { selector: `${catalogCard} .card-head button` }, click: false },
                3: { ring: { selector: '.hero .hero-top ar-switch' }, click: true },
                4: { ring: { selector: '.hero ol.flow' }, click: false },
                5: { ring: { selector: '.hero ol.flow li:first-child' }, click: false },
            },
        },
        // Add or edit a product
        7: {
            before: onWhatsAppTab,
            steps: {
                1: { ring: { selector: `${catalogCard} .card-head button` }, click: true },
                2: {
                    act: async (h) => {
                        await setVal(h, '#p-name', 'Linen shirt');
                        await setVal(h, '#p-price', 999);
                        await setVal(h, '#p-cat', 'Shirts');
                        await setVal(h, '#p-desc', 'Breathable, summer fit');
                    },
                    ring: { selector: 'form.editor .row2' }, click: false,
                },
                3: {
                    act: async (h) => {
                        const input = await h.page.$('form.editor .pics input[type=file]');
                        await input?.uploadFile(path.join(os.tmpdir(), 'guide-pic-linen-shirt.png'));
                        await h.settle(2000);
                    },
                    ring: { selector: 'form.editor fieldset.pics' }, click: false,
                },
                4: {
                    act: async (h) => {
                        await h.page.evaluate(() => [...document.querySelectorAll('form.editor .variants button')].at(-1)?.click());
                        await h.settle(300);
                        await setVal(h, 'form.editor input[aria-label="Option 1 name"]', 'M');
                        await setVal(h, 'form.editor input[aria-label="Option 1 price"]', 999);
                        await h.page.evaluate(() => [...document.querySelectorAll('form.editor .variants button')].at(-1)?.click());
                        await h.settle(300);
                        await setVal(h, 'form.editor input[aria-label="Option 2 name"]', 'XL');
                        await setVal(h, 'form.editor input[aria-label="Option 2 price"]', 1099);
                    },
                    ring: { selector: 'form.editor fieldset.variants' }, click: false,
                },
                5: { ring: { selector: 'form.editor .actions button[type=submit]' }, click: true },
            },
        },
        // Hide or delete a product
        8: {
            before: onWhatsAppTab,
            steps: {
                1: { ring: { selector: `${catalogCard} ol.items li ar-switch` }, click: false },
                2: {
                    act: async (h) => { await h.page.click(`${catalogCard} ol.items li button[aria-label^="Delete"]`); await h.settle(600); },
                    ring: { selector: 'app-confirm .dialog' }, click: false,
                    after: async (h) => { await h.page.evaluate(() => document.querySelector('app-confirm .dialog-actions .btn')?.click()); await h.settle(400); },
                },
                3: { ring: { selector: `${ordersCard} .s-table` }, click: false },
            },
        },
        // Take UPI payment for orders
        9: {
            before: onWhatsAppTab,
            steps: {
                1: {
                    act: async (h) => {
                        await setVal(h, '#s-upi', 'sunriseboutique@okhdfc');
                        await setVal(h, '#s-payee', 'Sunrise Boutique');
                    },
                    ring: { selector: `${settingsForm} .row2` }, click: false,
                },
                2: { ring: { selector: `${settingsForm} .qr label.btn` }, click: false },
                3: { ring: { selector: `${settingsForm} label.check:has([name=payNow])` }, click: false, after: (h) => tick(h, `${settingsForm} input[name=payNow]`) },
                4: { ring: { selector: `${settingsForm} .actions button[type=submit]` }, click: true },
            },
        },
        // Set delivery, alerts and business info
        10: {
            before: onWhatsAppTab,
            steps: {
                1: {
                    act: async (h) => { await tick(h, `${settingsForm} input[name=askAddress]`); await setVal(h, '#s-fee', 40); },
                    ring: { selector: `${settingsForm} label.check:has([name=askAddress])` }, click: false,
                },
                2: { act: (h) => tick(h, `${settingsForm} input[name=alertOwner]`), ring: { selector: `${settingsForm} label.check:has([name=alertOwner])` }, click: false },
                3: {
                    act: async (h) => {
                        await setVal(h, '#s-note', 'Delivery in 2 days. Cash on delivery also OK.');
                        await setVal(h, '#s-info', 'Open 10am-8pm, Mon-Sat\nShop 4, MG Road, Pune\nCall 98xxxxxx10');
                    },
                    ring: { selector: `${settingsForm} .s-field:has(#s-info)` }, click: false,
                },
                4: {
                    act: (h) => h.page.evaluate(() => { const d = document.querySelector('details.advanced'); if (d) d.open = true; }),
                    ring: { selector: `${settingsForm} details.advanced` }, click: false,
                },
                5: { ring: { selector: `${settingsForm} .actions button[type=submit]` }, click: true },
            },
        },
        // Handle orders that came in on WhatsApp
        11: {
            before: onWhatsAppTab,
            steps: {
                1: { ring: { selector: `${ordersCard} .card-head` }, click: false },
                2: { ring: { selector: `${ordersCard} tbody tr:first-child select` }, click: false },
                3: { ring: { selector: `${ordersCard} tbody td:has(> button)` }, click: false },
                4: {
                    act: async (h) => {
                        await h.page.click(`${ordersCard} tbody td:has(> button) button`);
                        await h.settle(1500);
                        await h.page.evaluate(() => document.querySelectorAll('*').forEach((n) => { if (n.scrollTop) n.scrollTop = 0; }));
                        await h.settle(300);
                    },
                    ring: { selector: 'app-shop p.s-banner.notice' }, click: false,
                },
            },
        },
        // Bring in products from your WhatsApp catalog
        12: {
            path: '/catalog',
            async before(h) {
                unfake = await fakeCatalog(h, made);
                await h.goto('/catalog');
            },
            steps: {
                1: { ring: { selector: '.list .row .state button.primary' }, click: true },
                2: {
                    act: async (h) => {
                        await h.settle(1000);
                        await h.page.evaluate(() => [...document.querySelectorAll('.drawer input.pick')].slice(0, 2).forEach((c) => c.click()));
                        await h.settle(400);
                    },
                    ring: { selector: '.drawer-foot .foot-actions .btn.primary' }, click: true,
                },
                3: {
                    act: async (h) => {
                        await unfake?.();
                        unfake = null;
                        await h.goto('/records/order');
                        await onWhatsAppTab(h);
                    },
                    ring: { selector: `${catalogCard} ol.items` }, click: false,
                },
            },
        },
    },
};
