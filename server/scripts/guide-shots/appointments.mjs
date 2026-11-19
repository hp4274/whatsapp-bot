/** Shot plan for the Appointments guide. See ../guide-shots.mjs for the plan shape; helpers live in ./orders.mjs. */

import os from 'node:os';
import path from 'node:path';

import { fill, localAt, markFields, onWhatsAppTab, openRow, pickCustomer, pickFirstCustomer, picture, recField, seedShop, setVal, tick } from './orders.mjs';

const listTab = { selector: '.views [role=tab]:last-child' };
const catalogCard = 'section[aria-labelledby=cat-h]';
const settingsForm = 'form.s-card.settings';
const bookingsCard = 'section[aria-labelledby=ord-h]';
const iso = (days, hour) => new Date(new Date(localAt(days, hour)).getTime()).toISOString();
const SERVICES = [
    { name: 'Haircut', price: 499, category: 'Hair', hue: 28, variants: [{ name: 'Short hair', price: 499 }, { name: 'Long hair', price: 699 }] },
    { name: 'Hair spa', price: 1200, category: 'Hair', hue: 300 },
    { name: 'Facial', price: 900, category: 'Skin', hue: 190 },
];
const WA_BOOKINGS = [
    { status: 'completed', data: { service: 'Facial', scheduledAt: iso(-1, 16), durationMinutes: 45 }, metadata: { source: 'whatsapp', phone: '919812345681', total: 900, payment: 'paid' } },
    { status: 'confirmed', data: { service: 'Hair spa', scheduledAt: iso(1, 12), durationMinutes: 60 }, metadata: { source: 'whatsapp', phone: '919812345682', total: 1200, payment: 'none' } },
    { status: 'scheduled', data: { service: 'Haircut (Long hair)', scheduledAt: iso(1, 11), durationMinutes: 30 }, metadata: { source: 'whatsapp', phone: '919812345683', total: 699, payment: 'claimed' } },
];

export default {
    async setup(h) {
        await seedShop(h, 'booking', SERVICES, WA_BOOKINGS);
        await picture(h, 'Beard trim', 100); // the file the "Add picture" step uploads
    },
    tasks: {
        // Add an appointment by hand
        1: {
            steps: {
                1: { ring: { selector: '.rec .s-head button.primary' }, click: true },
                2: {
                    act: (h) => pickCustomer(h, 'Meera'),
                    ring: { selector: '.drawer .field.customer' }, click: false,
                    after: pickFirstCustomer,
                },
                3: {
                    act: async (h) => {
                        await fill(h, 'Service', 'Hair spa');
                        await fill(h, 'Scheduled at', localAt(2, 15));
                        await fill(h, 'Duration minutes', 60);
                        await fill(h, 'Staff id', 'Sunita');
                        await fill(h, 'Location', 'Main branch');
                    },
                    ring: recField('Service'), click: false,
                },
                4: { act: markFields, ring: recField('Status'), click: false },
                5: { ring: { selector: '.drawer .actions button[type=submit]' }, click: true },
            },
        },
        // Change, confirm or cancel an appointment
        2: {
            steps: {
                1: { ring: { selector: '.rec tbody tr[aria-label="Open Appointment demo-appointment-1"]' }, click: true },
                2: {
                    act: async (h) => { await fill(h, 'Status', 'confirmed'); await fill(h, 'Notes', 'Asked for Dr. Kavita'); },
                    ring: recField('Status'), click: false,
                },
                3: { ring: { selector: '.drawer .actions button[type=submit]' }, click: true },
                4: { act: (h) => h.settle(800), ring: { selector: '.drawer .saved' }, click: false },
            },
        },
        // See what happened to an appointment
        3: {
            steps: {
                1: { ring: { selector: '.rec tbody tr[aria-label="Open Appointment demo-appointment-1"]' }, click: true },
                2: { act: (h) => h.settle(800), ring: { selector: '.drawer section.timeline' }, click: false },
                3: { ring: { selector: '.drawer .timeline ol' }, click: false },
            },
        },
        // Find an appointment
        4: {
            steps: {
                1: {
                    act: (h) => h.page.evaluate(() => [...document.querySelectorAll('.rec .chips .s-chip')].find((b) => b.textContent.includes('Confirmed'))?.click()),
                    ring: { selector: '.rec .toolbar .chips' }, click: false,
                },
                2: {
                    act: async (h) => {
                        await h.page.evaluate(() => document.querySelector('.rec .chips .s-chip')?.click());
                        await h.type('.rec .toolbar .search input', 'hair');
                    },
                    ring: { selector: '.rec .toolbar .search' }, click: false,
                },
                3: {
                    act: (h) => h.type('.rec .toolbar .search input', 'yoga class'),
                    ring: { selector: '.rec .tbl .s-empty button' }, click: true,
                },
            },
        },
        // Delete an appointment
        5: {
            before: (h) => openRow(h, 'Open Appointment demo-appointment-5'),
            steps: {
                1: { ring: { selector: '.drawer .actions .danger-ghost' }, click: true },
                2: { act: (h) => h.page.mouse.move(5, 5), ring: { selector: '.drawer .actions .confirm' }, click: false },
            },
        },
        // Take bookings on WhatsApp
        6: {
            steps: {
                1: { ring: listTab, click: true },
                2: { act: (h) => h.settle(800), ring: { selector: `${catalogCard} .card-head button` }, click: false },
                3: { ring: { selector: '.hero .hero-top ar-switch' }, click: true },
                4: { ring: { selector: '.hero ol.flow' }, click: false },
                5: { ring: { selector: '.hero ol.flow li:first-child' }, click: false },
            },
        },
        // Add or edit a service
        7: {
            before: onWhatsAppTab,
            steps: {
                1: { ring: { selector: `${catalogCard} .card-head button` }, click: true },
                2: {
                    act: async (h) => {
                        await setVal(h, '#p-name', 'Beard trim');
                        await setVal(h, '#p-price', 199);
                        await setVal(h, '#p-cat', 'Hair');
                        await setVal(h, '#p-desc', '20 min');
                    },
                    ring: { selector: 'form.editor .row2' }, click: false,
                },
                3: {
                    act: async (h) => {
                        const input = await h.page.$('form.editor .pics input[type=file]');
                        await input?.uploadFile(path.join(os.tmpdir(), 'guide-pic-beard-trim.png'));
                        await h.settle(2000);
                    },
                    ring: { selector: 'form.editor fieldset.pics' }, click: false,
                },
                4: {
                    act: async (h) => {
                        await h.page.evaluate(() => [...document.querySelectorAll('form.editor .variants button')].at(-1)?.click());
                        await h.settle(300);
                        await setVal(h, 'form.editor input[aria-label="Option 1 name"]', '20 min');
                        await setVal(h, 'form.editor input[aria-label="Option 1 price"]', 199);
                        await h.page.evaluate(() => [...document.querySelectorAll('form.editor .variants button')].at(-1)?.click());
                        await h.settle(300);
                        await setVal(h, 'form.editor input[aria-label="Option 2 name"]', 'With shave, 40 min');
                        await setVal(h, 'form.editor input[aria-label="Option 2 price"]', 349);
                    },
                    ring: { selector: 'form.editor fieldset.variants' }, click: false,
                },
                5: { ring: { selector: 'form.editor .actions button[type=submit]' }, click: true },
            },
        },
        // Hide or delete a service
        8: {
            before: onWhatsAppTab,
            steps: {
                1: { ring: { selector: `${catalogCard} ol.items li ar-switch` }, click: false },
                2: {
                    act: async (h) => { await h.page.click(`${catalogCard} ol.items li button[aria-label^="Delete"]`); await h.settle(600); },
                    ring: { selector: 'app-confirm .dialog' }, click: false,
                    after: async (h) => { await h.page.evaluate(() => document.querySelector('app-confirm .dialog-actions .btn')?.click()); await h.settle(400); },
                },
                3: { ring: { selector: `${bookingsCard} .s-table` }, click: false },
            },
        },
        // Take UPI payment for bookings
        9: {
            before: onWhatsAppTab,
            steps: {
                1: {
                    act: async (h) => {
                        await setVal(h, '#s-upi', 'glowsalon@okicici');
                        await setVal(h, '#s-payee', 'Glow Salon');
                    },
                    ring: { selector: `${settingsForm} .row2` }, click: false,
                },
                2: { ring: { selector: `${settingsForm} .qr label.btn` }, click: false },
                3: { ring: { selector: `${settingsForm} label.check:has([name=payNow])` }, click: false, after: (h) => tick(h, `${settingsForm} input[name=payNow]`) },
                4: { ring: { selector: `${settingsForm} .actions button[type=submit]` }, click: true },
            },
        },
        // Set reminders, alerts and business info
        10: {
            before: onWhatsAppTab,
            steps: {
                1: { act: (h) => setVal(h, '#s-remind', 24), ring: { selector: `${settingsForm} .s-field:has(#s-remind)` }, click: false },
                2: { act: (h) => tick(h, `${settingsForm} input[name=alertOwner]`), ring: { selector: `${settingsForm} label.check:has([name=alertOwner])` }, click: false },
                3: {
                    act: async (h) => {
                        await setVal(h, '#s-note', 'Please come 5 minutes early.');
                        await setVal(h, '#s-info', 'Open 10am-8pm, Tue-Sun\nShop 4, MG Road, Pune\nCall 98xxxxxx10');
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
        // Handle bookings that came in on WhatsApp
        11: {
            before: onWhatsAppTab,
            steps: {
                1: { ring: { selector: `${bookingsCard} .card-head` }, click: false },
                2: { ring: { selector: `${bookingsCard} tbody tr:first-child select` }, click: false },
                3: { ring: { selector: `${bookingsCard} tbody td:has(> button)` }, click: false },
                4: {
                    act: async (h) => {
                        await h.page.click(`${bookingsCard} tbody td:has(> button) button`);
                        await h.settle(1500);
                        await h.page.evaluate(() => document.querySelectorAll('*').forEach((n) => { if (n.scrollTop) n.scrollTop = 0; }));
                        await h.settle(300);
                    },
                    ring: { selector: 'app-shop p.s-banner.notice' }, click: false,
                },
            },
        },
    },
};
