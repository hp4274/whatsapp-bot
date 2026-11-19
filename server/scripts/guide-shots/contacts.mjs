/** Shot plan for the Contacts guide. See ../guide-shots.mjs for the plan shape. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const W = 'app-import-wizard';
const G = { selector: '[data-g]' };

/** Tag the first `sel` whose text contains `text` as [data-g], so a step can ring or click it. */
const mark = (h, sel, text) => h.page.evaluate((s, t) => {
    document.querySelectorAll('[data-g]').forEach((n) => delete n.dataset.g);
    const el = [...document.querySelectorAll(s)].find((n) => n.checkVisibility() && n.textContent.includes(t));
    if (el) el.dataset.g = '';
    return Boolean(el);
}, sel, text);
const clickMarked = async (h, sel, text) => { if (await mark(h, sel, text)) await h.click(G); };
const loaded = async (h) => { await h.page.waitForSelector('.table-wrap', { timeout: 8000 }).catch(() => {}); await h.settle(500); };
const press = async (h, key) => { await h.page.keyboard.press(key); await h.settle(400); };
const openImport = async (h) => { await loaded(h); await h.click({ selector: '.head-actions button:has(.ti-file-upload)' }); };
const openContact = async (h, name) => {
    await h.click({ selector: `tr[aria-label="${name}, open details"]` });
    await h.page.waitForSelector('aside.drawer #cd-consent', { timeout: 8000 }).catch(() => {});
    await h.settle(600);
};

const CSV = path.join(os.tmpdir(), 'diwali-customers.csv');
fs.writeFileSync(CSV, [
    'Phone,Name,Email,City,Birthday',
    '98250 11223,Hetal Shah,hetal@example.com,Surat,12/03',
    '98250 44556,Jignesh Patel,,Ahmedabad,25/07',
    '+91 99099 77881,Komal Desai,komal@example.com,Vadodara,',
    '98250 11223,Hetal Shah,hetal@example.com,Surat,12/03',
    '99,Wrong Number,,Rajkot,',
    'n/a,No number given,,Surat,',
    '022 2345 6789,Shop landline,,Mumbai,',
    '97240 66778,Nirav Mehta,nirav@example.com,Surat,01/11',
].join('\n'));

const GROUPS = {
    groups: [
        { id: 'c1@g.us', name: 'Sunrise Boutique Community', size: 240, isCommunity: true, community: null, hidden: 12, members: 228 },
        { id: 'g1@g.us', name: 'Sunrise VIP Customers', size: 86, isCommunity: false, community: 'c1@g.us', hidden: 0, members: 86 },
        { id: 'g2@g.us', name: 'Diwali Sale 2026', size: 131, isCommunity: false, community: 'c1@g.us', hidden: 4, members: 127 },
        { id: 'g3@g.us', name: 'Surat Shoppers', size: 54, isCommunity: false, community: null, hidden: 0, members: 54 },
        { id: 'g4@g.us', name: 'Wedding Collection Preview', size: 39, isCommunity: false, community: null, hidden: 0, members: 39 },
    ],
};
// The sandbox number has no groups: answer the groups listing with a sample so the dialog shows real rows.
const fakeGroups = (req) => {
    if (req.isInterceptResolutionHandled()) return;
    if (req.url().endsWith('/api/contacts/whatsapp-groups')) {
        req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(GROUPS) });
    } else req.continue();
};

export default {
    async setup(h) {
        const add = (body) => h.api('POST', '/api/contacts', body);
        await add({ phone: '+91 98111 22233', name: 'Riya Shah', email: 'riya@example.com', tags: ['vip', 'diwali'], customFields: { city: 'Surat', birthday: '18/11/1990' } });
        await add({ phone: '+91 91 98111 22233', name: 'Riya S', tags: ['walk-in'] });
        await add({ phone: '+91 98222 33344', name: 'Kabir Rao', tags: ['vip'], customFields: { city: 'Pune', birthday: '02/02' } });
        await add({ phone: '+91 91 98222 33344', name: 'Kabir', customFields: { city: 'Pune' } });
        await add({ phone: '+91 98444 55566', name: 'Sara Khan', tags: ['vip'], customFields: { city: 'Pune', birthday: '1992-11-25' } });
        const meena = await add({ phone: '+91 98333 44455', name: 'Meena Joshi', tags: ['lead'] });
        // More than one page (50), so "Select all ... matching" shows.
        const first = ['Aditi', 'Bhavin', 'Chirag', 'Deepa', 'Esha', 'Farhan', 'Gauri', 'Harsh', 'Isha', 'Jay', 'Kavya', 'Lalit', 'Mitali', 'Nikhil', 'Ojas', 'Pooja', 'Rahul', 'Sejal', 'Tanvi', 'Uday'];
        for (const [i, n] of first.entries()) await add({ phone: `+91 97000 ${10100 + i}`, name: `${n} Trivedi`, tags: ['walk-in'] });
        // Riya's timeline: what she was sent and what she wrote back (sandbox rows, nothing is sent).
        try {
            const ago = (m) => new Date(Date.now() - m * 60_000).toISOString();
            const out = h.db.prepare(`INSERT INTO messages (tenant_id, message_id, message_type, recipient, message, status, created_at, updated_at, sent_at)
                VALUES (1, ?, ?, '919811122233', ?, ?, ?, ?, ?)`);
            out.run('shot-riya-1', 'campaign', 'Diwali Sale is live! Flat 30% off on all sarees till Sunday.', 'read', ago(2900), ago(2900), ago(2900));
            h.db.prepare(`INSERT INTO inbound_messages (tenant_id, message_id, sender, sender_name, body, received_at)
                VALUES (1, 'shot-riya-in', '919811122233', 'Riya Shah', 'Is the red Banarasi saree still available?', ?)`).run(ago(2880));
            out.run('shot-riya-2', 'auto_reply', 'Yes! The red Banarasi is in stock in sizes S-XL. Visit us or reply ORDER.', 'delivered', ago(2879), ago(2879), ago(2879));
        } catch (err) { console.warn('contacts timeline rows:', err.message); }
        if (meena?.contact?.id) await h.api('POST', `/api/contacts/${meena.contact.id}/consent`, { optedOut: true, reason: 'replied STOP' });
    },
    tasks: {
        1: {
            before: loaded,
            steps: {
                1: { ring: { selector: '.head-actions .btn.primary' }, click: true },
                2: {
                    act: async (h) => {
                        await h.type('#n-phone', '98765 43210');
                        await h.type('#n-name', 'Anjali Verma');
                        await h.type('#n-email', 'anjali@example.com');
                    },
                    ring: { selector: 'form.new .grid' },
                },
                3: { act: (h) => h.type('#n-tags', 'vip, follow-up'), ring: { selector: 'form.new .field:has(#n-tags)' } },
                4: {
                    act: async (h) => { await h.click({ selector: 'form.new details.advanced summary' }); await h.type('#n-fields', 'doctor=Mehta'); },
                    ring: { selector: 'form.new details.advanced' },
                    click: false,
                },
                5: { ring: { selector: 'form.new .form-actions button[type=submit]' }, click: false },
            },
        },
        2: {
            before: loaded,
            steps: {
                1: { ring: { selector: '.head-actions button:has(.ti-file-upload)' }, click: true },
                2: {
                    ring: { selector: `${W} label.drop` },
                    click: false,
                    after: async (h) => {
                        const input = await h.page.$('#iw-file');
                        await input?.uploadFile(CSV);
                        await h.page.waitForSelector(`${W} .map`, { timeout: 8000 }).catch(() => {});
                        await h.settle(800);
                    },
                },
                3: { ring: { selector: `${W} .map` } },
                4: {
                    ring: { selector: `${W} .check` },
                    click: false,
                    after: (h) => h.click({ selector: `${W} .foot .btn.primary` }),
                },
                5: {
                    act: async (h) => { await h.type(`${W} input[aria-label="Add a tag"]`, 'diwali-2026'); await press(h, 'Enter'); },
                    ring: { selector: `${W} .tag-editor` },
                    after: async (h) => {
                        await h.click({ selector: `${W} .foot .btn.primary` });
                        await h.page.waitForSelector(`${W} .result`, { timeout: 8000 }).catch(() => {});
                        await h.settle(800);
                    },
                },
                6: { act: (h) => h.click({ selector: `${W} details.problems summary` }), ring: { selector: `${W} .result` }, click: false },
            },
        },
        3: {
            before: openImport,
            steps: {
                1: { ring: { selector: `${W} .s-seg.mode button:nth-child(2)` }, click: true },
                2: {
                    act: (h) => h.type('#iw-paste', '[18/11, 10:02] Hetal: my number is 98250 11223\n[18/11, 10:05] Jignesh: call +91 98250 44556\nNirav - 97240 66778, Komal 99099 77881'),
                    ring: { selector: '#iw-paste' },
                },
                3: { act: (h) => h.type('#iw-paste-tag', 'expo-2026'), ring: { selector: `${W} .foot .btn.primary` }, click: true, after: (h) => h.settle(800) },
                4: { ring: { selector: `${W} .check` }, click: false },
            },
        },
        4: {
            before: async (h) => {
                await h.page.setRequestInterception(true);
                h.page.on('request', fakeGroups);
                await openImport(h);
            },
            steps: {
                1: {
                    act: (h) => h.click({ selector: `${W} details.advanced summary` }),
                    ring: { selector: `${W} details.advanced .advanced-body button` },
                    click: true,
                    after: async (h) => { await h.page.waitForSelector('app-groups-dialog .list', { timeout: 8000 }).catch(() => {}); await h.settle(600); },
                },
                2: {
                    act: async (h) => {
                        await clickMarked(h, 'app-groups-dialog .list label.row', 'Sunrise VIP Customers');
                        await clickMarked(h, 'app-groups-dialog .list label.row', 'Diwali Sale 2026');
                    },
                    ring: { selector: 'app-groups-dialog .strip' },
                    click: false,
                },
                3: { ring: { selector: 'app-groups-dialog .foot .btn.primary' }, click: false },
                4: {
                    ring: { selector: 'app-groups-dialog .foot .acts .btn:not(.primary)' },
                    click: false,
                    after: async (h) => { h.page.off('request', fakeGroups); await h.page.setRequestInterception(false); },
                },
            },
        },
        5: {
            before: loaded,
            steps: {
                1: {
                    act: async (h) => { await h.type('input[aria-label="Search contacts"]', 'Riya'); await h.settle(800); },
                    ring: { selector: '.list .toolbar .search' },
                    after: async (h) => { await h.page.focus('input[aria-label="Search contacts"]'); await press(h, 'Escape'); await h.settle(600); },
                },
                2: { ring: { selector: '.s-seg.consent' }, click: false },
                3: { act: (h) => mark(h, '.tagcloud .s-chip', 'vip'), ring: G, click: true },
                4: {
                    act: async (h) => { await h.page.select('select[aria-label="Contact detail"]', 'city'); await h.type('input[aria-label="Detail value"]', 'Pune'); },
                    ring: { selector: 'form.field-filter' },
                    click: false,
                    after: (h) => h.click({ selector: 'form.field-filter button[type=submit]' }),
                },
                5: { ring: { selector: '.list .toolbar > button' }, click: false },
            },
        },
        6: {
            before: loaded,
            steps: {
                1: { act: async (h) => { await clickMarked(h, '.tagcloud .s-chip', 'vip'); }, ring: { selector: '.active-filters' } },
                2: {
                    act: (h) => h.type('input[aria-label="Segment name"]', 'VIP buyers'),
                    ring: { selector: 'form.save-seg' },
                    click: false,
                    after: async (h) => { await h.click({ selector: 'form.save-seg button[type=submit]' }); await h.settle(600); },
                },
                3: { act: (h) => mark(h, '.segments .seg-item', 'VIP buyers'), ring: G, click: false },
                4: { act: (h) => h.click({ selector: 'button[aria-label="Delete segment VIP buyers"]' }), ring: { selector: '.seg-confirm' }, click: false },
            },
        },
        7: {
            before: loaded,
            steps: {
                1: { ring: { selector: 'tr[aria-label="Riya Shah, open details"]' }, click: true, after: (h) => h.settle(800) },
                2: {
                    act: (h) => h.click({ selector: 'aside.drawer .edit-btn' }),
                    ring: { selector: 'aside.drawer form:has(#cd-name)' },
                    click: false,
                    after: (h) => h.click({ selector: 'aside.drawer form:has(#cd-name) button[type=button]' }),
                },
                3: { act: (h) => h.type('aside.drawer input[aria-label="Add a tag"]', 'follow-up'), ring: { selector: 'aside.drawer section:has(#cd-tags)' } },
                4: {
                    act: async (h) => {
                        await clickMarked(h, 'aside.drawer section:has(#cd-fields) button', 'Add detail');
                        const keys = await h.page.$$('aside.drawer input[aria-label^="Field name"]');
                        const vals = await h.page.$$('aside.drawer input[aria-label^="Value for"]');
                        await keys.at(-1)?.type('anniversary');
                        await vals.at(-1)?.type('14/02');
                        await h.settle(300);
                    },
                    ring: { selector: 'aside.drawer section:has(#cd-fields)' },
                    click: false,
                },
                5: { ring: { selector: 'aside.drawer section:has(#cd-history)' } },
            },
        },
        8: {
            before: async (h) => { await loaded(h); await openContact(h, 'Riya Shah'); },
            steps: {
                1: { ring: { selector: 'aside.drawer .consent-row' }, click: false, after: (h) => h.click({ selector: 'aside.drawer button[role=switch]' }) },
                2: {
                    act: (h) => h.type('#cd-reason', 'replied STOP'),
                    ring: { selector: 'aside.drawer section.consent' },
                    after: async (h) => { await h.click({ selector: 'aside.drawer section.consent button.danger' }); await h.settle(800); },
                },
                3: {
                    act: async (h) => { await h.click({ selector: 'aside.drawer button[role=switch]' }); await h.type('#cd-in-reason', 'asked by phone to hear offers again'); },
                    ring: { selector: 'aside.drawer section.consent' },
                    click: false,
                },
            },
        },
        9: {
            before: loaded,
            steps: {
                1: { act: (h) => h.click({ selector: 'input[aria-label="Select every contact on this page"]' }), ring: { selector: 'thead th.pick' }, click: false },
                2: { ring: { selector: 'app-bulk-bar .count button.link' }, click: true },
                3: { ring: { selector: 'app-bulk-bar .actions' }, click: false },
                4: { act: (h) => h.click({ selector: 'app-bulk-bar .actions button.danger-ghost' }), ring: { selector: 'app-bulk-bar .step.bad' }, click: false },
            },
        },
        10: {
            before: loaded,
            steps: {
                1: { ring: { selector: '.dupe-banner .btn.primary' }, click: true, after: (h) => h.settle(800) },
                2: { ring: { selector: 'app-merge-dialog fieldset.group .options' }, click: false },
                3: { ring: { selector: 'app-merge-dialog fieldset.group .row-end .btn.primary' }, click: false },
                4: { ring: { selector: 'app-merge-dialog fieldset.group .row-end .btn:not(.primary)' }, click: false },
            },
        },
        11: {
            before: loaded,
            steps: {
                1: { ring: { selector: '.head-actions button:has(.ti-cake)' }, click: true, after: (h) => h.settle(800) },
                2: { ring: { selector: '#greet-on' }, click: false, after: (h) => h.click({ selector: '#greet-on' }) },
                3: { act: async (h) => { await h.page.select('#greet-field', 'birthday'); await h.settle(300); }, ring: { selector: 'app-greetings-card .field:has(#greet-field)' } },
                4: {
                    act: (h) => h.type('#greet-msg', 'Happy birthday {name}! Enjoy 20% off at Sunrise Boutique this week.'),
                    ring: { selector: 'app-greetings-card .field:has(#greet-msg)' },
                    click: false,
                },
            },
        },
        12: {
            before: loaded,
            steps: {
                1: { act: (h) => clickMarked(h, '.tagcloud .s-chip', 'vip'), ring: { selector: '.active-filters' } },
                2: { ring: { selector: '.head-actions button:has(.ti-download)' }, click: false },
                3: {
                    act: async (h) => {
                        const boxes = await h.page.$$('tbody td.pick input');
                        for (const b of boxes.slice(0, 2)) await b.click();
                        await h.settle(500);
                    },
                    ring: { selector: 'app-bulk-bar .actions button:has(.ti-download)' },
                    click: false,
                },
            },
        },
    },
};
