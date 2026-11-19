/** Shot plan for the Templates guide. See ../guide-shots.mjs for the plan shape. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PHOTO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'public', 'assets', 'landing', 'hero-shop-m.jpg');
const sel = (selector) => ({ selector });
const card = (name) => `article.tcard:has(h3[title="${name}"])`;
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/** Open a template's editor from its card and wait for the drawer. */
const edit = (name) => async (h) => {
    await h.click(sel(`button[aria-label="Edit ${name}"]`));
    await h.settle(800);
};
/** Replace a field's text the way a person types it. */
const fill = async (h, selector, text) => {
    await h.page.$eval(selector, (n) => { n.focus(); n.select?.(); });
    await h.page.keyboard.press('Backspace');
    await h.page.type(selector, text);
    await h.page.evaluate(() => document.activeElement?.blur()); // no focus outline next to the ring
    await h.settle(300);
};

export default {
    async setup(h) {
        if (h.db.prepare("SELECT 1 FROM templates WHERE name = 'festive_sale'").get()) return;
        const made = {};
        const add = async (body) => { made[body.name] = (await h.api('POST', '/api/templates', body)).template; };
        await add({
            name: 'festive_sale', category: 'marketing', templateType: 'interactive',
            body: 'Hi {name}, our festive sale is live! Flat 25% off the new collection till Sunday.',
            interactive: { type: 'buttons', buttons: [{ id: 'SHOP', title: 'Shop now' }, { id: 'LATER', title: 'Remind me later' }] },
        });
        await add({
            name: 'store_location', category: 'utility', templateType: 'notification',
            body: 'Hi {name|there}, we are at 14 MG Road, open 10 am to 9 pm every day.',
            interactive: { type: 'cta', cta: [{ kind: 'url', title: 'Open in Maps', value: 'https://maps.google.com/?q=Sunrise+Boutique' }] },
        });
        await add({ name: 'login_code', category: 'authentication', body: 'Your Sunrise Boutique login code is {code}. It expires in 10 minutes.' });
        await add({ name: 'weekend_offer', category: 'marketing', body: 'Hi {name}, this weekend only: buy 2 get 1 free on all kurtas!' });
        await add({ name: 'flash_sale', category: 'marketing', body: 'HURRY!!! 90% OFF EVERYTHING!!! Click now before it is gone!!!' });
        // Older wording for order_update, so History has versions to go back to.
        const orderUpdate = (await h.api('GET', '/api/templates')).templates.find((t) => t.name === 'order_update');
        await h.api('PUT', `/api/templates/${orderUpdate.id}`, { body: 'Hi {name}, your order {reference} is {status}.' });
        await h.api('PUT', `/api/templates/${orderUpdate.id}`, { body: 'Hi {name}, your order {reference} is now {status}. Track it here: {trackingLink}', category: 'utility' });
        await h.api('PUT', `/api/templates/${(await h.api('GET', '/api/templates')).templates.find((t) => t.name === 'payment_reminder').id}`, { category: 'utility' });
        const set = h.db.prepare('UPDATE templates SET use_count = ?, last_used_at = ?, review_status = ?, review_note = ? WHERE name = ? AND tenant_id = 1');
        set.run(248, ago(2), '', '', 'festive_sale');
        set.run(86, ago(1), '', '', 'order_update');
        set.run(31, ago(6), '', '', 'welcome_message');
        set.run(17, ago(3), '', '', 'store_location');
        set.run(0, null, 'pending', '', 'weekend_offer');
        set.run(0, null, 'rejected', 'Too promotional: drop the capital letters and the 90% claim.', 'flash_sale');
    },
    tasks: {
        1: {
            steps: {
                1: { ring: sel('.s-head .hacts .btn.primary'), click: true },
                2: { act: (h) => fill(h, '#tp-name', 'order_shipped'), ring: sel('#tp-name') },
                3: {
                    act: (h) => fill(h, '#tp-body', 'Hi , your order *#4521* has been shipped and reaches you in 2 days.'),
                    ring: sel('[role=toolbar][aria-label="Formatting"]'),
                },
                4: {
                    // The cursor after "Hi " is where the field goes.
                    act: (h) => h.page.$eval('#tp-body', (n) => { n.focus(); n.setSelectionRange(3, 3); }),
                    ring: sel('[aria-label="Formatting"] button.var'),
                    click: true,
                },
                5: { act: (h) => h.settle(600), ring: sel('.side app-template-preview'), click: false },
            },
        },
        2: {
            steps: {
                1: { ring: sel('.s-head .hacts .btn:not(.primary)'), click: true },
                2: { act: (h) => h.settle(800), ring: sel('button[aria-label="Copy Order update into my templates"]'), click: true },
                3: {
                    act: async (h) => {
                        await h.settle(800);
                        await h.click(sel('.s-drawer .dhead button[aria-label="Close"]'));
                        await fill(h, '.bar .search input', 'Order update'); // the copy is on page 2 otherwise
                    },
                    ring: sel('button[aria-label="Edit Order update"]'),
                    click: false,
                },
            },
        },
        3: {
            before: edit('welcome_message'),
            steps: {
                1: { ring: sel('.mediapick label.drop'), click: false },
                2: {
                    act: async (h) => {
                        const input = await h.page.$('.mediapick input[type=file]');
                        await input?.uploadFile(PHOTO);
                        await h.settle(2500);
                    },
                    ring: sel('.side app-template-preview'),
                },
                3: { ring: sel('.mediarow button'), click: false },
            },
        },
        4: {
            before: edit('welcome_message'),
            steps: {
                1: { ring: sel('[role=radiogroup][aria-label="Buttons under the message"]'), click: false },
                2: {
                    act: async (h) => {
                        await h.click(sel('[aria-label="Buttons under the message"] button:nth-of-type(2)'));
                        await fill(h, 'input[aria-label="Button 1 title"]', 'Yes, show me');
                        await h.click(sel('app-buttons-editor button.add'));
                        await fill(h, 'input[aria-label="Button 2 title"]', 'Not now');
                        await fill(h, 'input[aria-label="Button 3 title"]', 'Talk to us');
                    },
                    ring: sel('app-buttons-editor button.add'),
                    click: false,
                },
                3: {
                    act: async (h) => {
                        await h.click(sel('[aria-label="Buttons under the message"] button:nth-of-type(3)'));
                        await fill(h, 'input[aria-label="Action 1 title"]', 'Visit our shop');
                        await fill(h, 'input[aria-label="Action 1 Visit website"]', 'https://sunrise.shop');
                        await h.click(sel('app-buttons-editor button.add'));
                        await fill(h, 'input[aria-label="Action 2 Call number"]', '+919876543210');
                    },
                    ring: sel('select[aria-label="Action 2 kind"]'),
                    click: false,
                },
                4: {
                    act: async (h) => {
                        await h.click(sel('[aria-label="Buttons under the message"] button:nth-of-type(4)'));
                        await fill(h, 'input[placeholder="View options"]', 'See our menu');
                        await fill(h, 'input[aria-label="Option 1 title"]', 'New arrivals');
                        await h.click(sel('app-buttons-editor button.add'));
                        await fill(h, 'input[aria-label="Option 2 title"]', 'Store timings');
                    },
                    ring: sel('app-buttons-editor label.fld:has(input[placeholder="View options"])'),
                    click: false,
                },
                5: { ring: sel('app-buttons-editor ol.items li:nth-of-type(2) .tools'), click: false },
            },
        },
        5: {
            before: edit('order_update'),
            steps: {
                1: { ring: sel('.as-contact'), click: false },
                2: {
                    act: async (h) => { await h.page.type('#tp-as', 'Aarav'); await h.settle(1200); },
                    ring: sel('.as-matches'),
                    click: false,
                },
                3: {
                    act: async (h) => { await h.click(sel('.as-matches li:first-child button')); await h.settle(1200); },
                    ring: sel('.s-drawer app-template-preview .bubble'),
                },
                4: { ring: sel('button[aria-label="Back to the example values"]'), click: false },
            },
        },
        6: {
            before: edit('order_update'),
            steps: {
                1: { ring: sel('details.advanced summary'), click: true },
                2: {
                    act: async (h) => { await h.page.select('#tp-type', 'notification'); await h.settle(300); },
                    ring: sel('fieldset.catpick'),
                    after: (h) => h.click(sel('fieldset.catpick [role=radio]:nth-of-type(2)')),
                },
                3: { ring: sel('.foot button[type=submit]'), click: false },
            },
        },
        7: {
            steps: {
                1: { ring: sel('.cats'), after: (h) => h.click(sel('.cats button:nth-of-type(2)')) },
                2: {
                    act: async (h) => { await h.click(sel('.cats button:nth-of-type(1)')); await fill(h, '.bar .search input', 'order'); },
                    ring: sel('.bar .search'),
                },
                3: { act: (h) => fill(h, '.bar .search input', ''), ring: sel('.chips[aria-label="Filter by type"]'), click: false },
                4: { act: (h) => fill(h, '.bar .search input', 'gift card'), ring: sel('.s-empty button'), click: false },
            },
        },
        8: {
            // No "Continue where you left off?" from a campaign guide run before this one.
            before: (h) => h.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('wsender.campaignDraft')).forEach((k) => localStorage.removeItem(k))),
            steps: {
                1: { ring: sel('button[aria-label="Use festive_sale in a campaign"]'), click: true },
                2: { act: (h) => h.settle(1500), ring: sel('.sources') },
            },
        },
        9: {
            steps: {
                1: { ring: sel('button[aria-label="Edit order_update"]'), click: true },
                2: {
                    act: (h) => fill(h, '#tp-body', 'Hi {name}, good news! Your order {reference} is now {status}. Track it here: {trackingLink}'),
                    ring: sel('.foot button[type=submit]'),
                    click: true,
                },
                3: {
                    act: async (h) => { await h.settle(800); await h.click(sel('button[aria-label="Version history for order_update"]')); await h.settle(800); },
                    ring: sel('ol.timeline'),
                },
            },
        },
        10: {
            steps: {
                1: { ring: sel('button[aria-label="Version history for order_update"]'), click: true },
                2: { act: (h) => h.settle(600), ring: sel('ol.timeline li:not(.now) button'), click: false },
            },
        },
        11: {
            steps: {
                1: { act: (h) => fill(h, '.bar .search input', 'offer'), ring: sel(`${card('weekend_offer')} .tags .s-pill`) },
                2: { act: (h) => fill(h, '.bar .search input', 'sale'), ring: sel(`${card('flash_sale')} .rnote`) },
                3: { ring: sel('button[aria-label="Edit flash_sale"]'), click: true, after: (h) => h.settle(600) },
            },
        },
        12: {
            steps: {
                1: { act: (h) => fill(h, '.bar .search input', 'reminder'), ring: sel('button[aria-label="Delete payment_reminder"]'), click: true },
                2: { ring: sel(`${card('payment_reminder')} .acts`), click: false },
            },
        },
    },
};
