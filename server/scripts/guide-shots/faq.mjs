/**
 * Shot plan for the FAQ guide. See ../guide-shots.mjs for the plan shape.
 * Gaps (unanswered questions, near misses) only come from real inbound chats, which the sandbox never gets: setup
 * writes a few into this run's own temp database, found by a marker category made through the API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** This run's database: the temp shots.db holding the marker category. */
function ownDb(marker) {
    const dirs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('wsender-shots-'))
        .map((d) => path.join(os.tmpdir(), d, 'shots.db')).filter((f) => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of dirs) {
        let db;
        try {
            db = new DatabaseSync(file);
            if (db.prepare('SELECT 1 FROM faq_categories WHERE name = ?').get(marker)) return db;
            db.close();
        } catch {
            db?.close();
        }
    }
    return null;
}

const tab = (label) => ({ selector: `nav[aria-label="Knowledge base sections"] [role=tab]:nth-child(${['Questions', 'Add many', 'Categories', 'Test', 'Gaps'].indexOf(label) + 1})` });
const field = (id) => ({ selector: `.field:has(#${id})` });
/** Pick an option by index (ngValue options carry Angular's own values). */
const choose = (h, selector, index) => h.page.evaluate((s, i) => {
    const el = document.querySelector(s);
    if (!el) return;
    el.selectedIndex = i;
    el.dispatchEvent(new Event('change', { bubbles: true }));
}, selector, index).then(() => h.settle(300));
const openTab = (label) => async (h) => {
    await h.click(tab(label));
};
const editFirst = async (h) => {
    await h.page.click('article.card.q footer button.btn.sm.ghost:not(.del):nth-of-type(2)').catch(() => {});
    await h.settle(500);
};

export default {
    async setup(h) {
        const marker = `shots-${Date.now()}`;
        const made = await h.api('POST', '/api/faq/categories', { name: marker });
        const db = ownDb(marker);
        if (db) {
            const now = new Date().toISOString();
            const add = db.prepare('INSERT INTO faq_misses (tenant_id, text, count, last_seen_at) VALUES (1, ?, ?, ?)');
            add.run('do you have this kurti in xl size', 7, now);
            add.run('are you open on sunday', 4, now);
            add.run('can i pick up from the shop', 2, now);
            db.prepare('UPDATE faq_items SET miss_count = ? WHERE tenant_id = 1 AND question = ?').run(3, 'How long does delivery take?');
            db.prepare('UPDATE faq_items SET miss_count = ? WHERE tenant_id = 1 AND question = ?').run(1, 'How do I get a refund?');
            db.close();
        } else {
            console.warn('faq plan: run database not found, Gaps stays empty');
        }
        const id = made.category?.id ?? made.id;
        if (id) await h.api('DELETE', `/api/faq/categories/${id}`);
    },
    tasks: {
        1: {
            steps: {
                1: { ring: { selector: 'header.s-head button.btn.primary' }, click: true },
                2: { act: (h) => h.type('#kb-question', 'What are your opening hours?'), ring: field('kb-question'), click: false },
                3: { act: (h) => h.type('#kb-keywords', 'timings, open today, hours, sunday'), ring: field('kb-keywords'), click: false },
                4: { act: (h) => h.type('#kb-answer', 'We are open 10am to 8pm, Monday to Saturday, and 11am to 5pm on Sunday.'), ring: field('kb-answer'), click: false },
                5: {
                    act: (h) => choose(h, '#kb-cat', 1),
                    ring: { selector: 'form.editor button[type=submit]' },
                    // Saved, so the Test task has an answer to match.
                    click: true,
                },
            },
        },
        2: {
            steps: {
                1: { ring: tab('Add many'), click: true },
                2: { ring: { selector: '.packs button.pack' }, click: true },
                3: {
                    act: async (h) => {
                        await h.page.click('ul.preview li:nth-child(2) input[type=checkbox]').catch(() => {});
                        await h.settle(300);
                    },
                    ring: { selector: '[role=tabpanel] .card.pad .ed-head' },
                    click: false,
                },
                4: { ring: { selector: '[role=tabpanel] .row.end button.primary' }, click: false },
            },
        },
        3: {
            steps: {
                1: { ring: tab('Add many'), click: true },
                2: {
                    act: (h) => h.type('#kb-paste', 'Do you gift wrap? | Yes, free on every order | Orders & Delivery\nWhere is your shop? | 12 MG Road, Pune'),
                    ring: field('kb-paste'),
                    click: false,
                },
                3: { ring: { selector: 'label.btn.upload' }, click: false },
                4: {
                    act: async (h) => {
                        await h.page.click('form.card.pad button[type=submit]').catch(() => {});
                        await h.settle(500);
                    },
                    ring: { selector: '[role=tabpanel] .card.pad:has(ul.preview)' },
                    click: false,
                },
            },
        },
        4: {
            steps: {
                1: { act: (h) => h.type('label.search input', 'delivery'), ring: { selector: 'label.search' }, click: false },
                2: { ring: { selector: 'article.card.q button[role=switch]' }, click: false },
                3: {
                    ring: { selector: 'article.card.q footer button.btn.sm.ghost:not(.del):nth-of-type(2)' },
                    click: true,
                    after: async (h) => {
                        await h.page.click('form.editor button[aria-label="Close editor"]').catch(() => {});
                        await h.settle(400);
                    },
                },
                4: {
                    act: async (h) => {
                        await h.page.click('article.card.q button.del').catch(() => {});
                        await h.settle(300);
                    },
                    ring: { selector: 'article.card.q .confirm' },
                    click: false,
                },
            },
        },
        5: {
            before: (h) => h.page.mouse.move(5, 5),
            steps: {
                1: { ring: { selector: 'article.card.q footer button.btn.sm.ghost:not(.del):nth-of-type(2)' }, click: true },
                2: { act: (h) => choose(h, '#kb-type', 2), ring: { selector: 'form.editor .field:has(#kb-type)' }, click: false },
                3: { act: (h) => h.type('#kb-prio', '5'), ring: field('kb-prio'), click: false },
                4: {
                    act: async (h) => {
                        await h.page.click('form.editor input[name=ooh]').catch(() => {});
                        await h.settle(300);
                    },
                    ring: { selector: 'form.editor label.check:has(input[name=ooh])' },
                    click: false,
                },
                5: { ring: { selector: 'form.editor button[type=submit]' }, click: false },
            },
        },
        6: {
            steps: {
                1: { ring: tab('Categories'), click: true },
                2: { act: (h) => h.type('#kb-newcat', 'Pricing'), ring: { selector: 'form.row-form' }, click: false },
                3: { ring: { selector: 'ol.cats li.cat .acts' }, click: false },
                4: { ring: { selector: 'ol.cats li.cat button.cat-name' }, click: false },
            },
        },
        7: {
            steps: {
                1: { ring: tab('Test'), click: true },
                2: { act: (h) => h.type('#kb-test', 'what time do you open on sunday?'), ring: field('kb-test'), click: false },
                3: {
                    ring: { selector: '[role=tabpanel].test form .row' },
                    click: false,
                },
                4: {
                    act: async (h) => {
                        await h.page.click('[role=tabpanel].test form button[type=submit]').catch(() => {});
                        await h.settle(900);
                    },
                    ring: { selector: '.verdict' },
                    click: false,
                },
            },
        },
        8: {
            steps: {
                1: { ring: tab('Gaps'), click: true },
                2: { ring: { selector: '[role=tabpanel] .card.pad:has(ul.misses)' }, click: false },
                3: { ring: { selector: '[role=tabpanel] .card.pad:has(ul.misses) li' }, click: false },
                4: { ring: { selector: '[role=tabpanel] .card.pad:has(.ti-navigation) li' }, click: false },
            },
        },
        9: {
            before: openTab('Gaps'),
            steps: {
                1: { ring: { selector: 'form.card.pad:has(#kb-miss-reply) h3' }, click: false },
                2: { act: (h) => h.type('#kb-miss-reply', 'Thanks! We will get back to you shortly.'), ring: field('kb-miss-reply'), click: false },
                3: {
                    act: async (h) => {
                        await h.page.click('input[name=alertOwner]').catch(() => {});
                        await h.settle(200);
                    },
                    ring: { selector: 'label.check:has(input[name=alertOwner])' },
                    click: false,
                },
                4: { ring: { selector: 'form.card.pad:has(#kb-miss-reply) button[type=submit]' }, click: false },
            },
        },
    },
};
