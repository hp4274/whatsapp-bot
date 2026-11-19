/**
 * Shot plan for the Tickets guide. See ../guide-shots.mjs for the plan shape.
 * A WhatsApp chat on a ticket and an overdue SLA need inbound messages and time to pass, which the sandbox never
 * gives: setup writes them into this run's own temp database, found by a marker FAQ category made through the API.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** This run's database: the temp shots.db holding the marker category. */
function ownDb(marker) {
    const files = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('wsender-shots-'))
        .map((d) => path.join(os.tmpdir(), d, 'shots.db')).filter((f) => fs.existsSync(f))
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    for (const file of files) {
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

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString().replace(/\.\d+Z$/, '+00:00');
const row = (ref) => ({ selector: `button[aria-label="Open ticket ${ref}"]` });
const stat = (n) => ({ selector: `section.stats > :nth-child(${n})` });
const openTicket = (ref) => async (h) => {
    await h.page.click(row(ref).selector).catch(() => {});
    await h.settle(1200);
};
const settings = async (h) => {
    await h.page.click('.head-actions button[aria-controls=wa-settings]').catch(() => {});
    await h.settle(600);
};

export default {
    async setup(h) {
        const marker = `shots-${Date.now()}`;
        const made = await h.api('POST', '/api/faq/categories', { name: marker });
        const db = ownDb(marker);
        if (db) {
            // TKT-0001: a short chat with Aarav, and an SLA that ran out an hour ago.
            const event = db.prepare(`INSERT INTO ticket_events (tenant_id, ticket_id, user_id, kind, body, created_at)
                VALUES (1, (SELECT id FROM tickets WHERE tenant_id = 1 AND reference = ?), ?, ?, ?, ?)`);
            event.run('TKT-0001', null, 'inbound', 'Hi, my order #1042 still has not arrived. It has been 7 days.', ago(560));
            event.run('TKT-0001', 1, 'message', 'Sorry about that! Let me check with the courier and get back to you.', ago(550));
            event.run('TKT-0001', null, 'inbound', 'Please hurry, it is a gift for Saturday.', ago(530));
            db.prepare("UPDATE tickets SET created_at = ?, sla_due_at = ? WHERE tenant_id = 1 AND reference = 'TKT-0001'")
                .run(ago(600), ago(60));
            db.prepare("UPDATE tickets SET created_at = ?, resolved_at = ? WHERE tenant_id = 1 AND reference IN ('TKT-0004', 'TKT-0005')")
                .run(ago(60 * 30), ago(60 * 4));
            db.close();
        } else {
            console.warn('tickets plan: run database not found, no chat or overdue ticket');
        }
        const id = made.category?.id ?? made.id;
        if (id) await h.api('DELETE', `/api/faq/categories/${id}`);
    },
    tasks: {
        1: {
            steps: {
                1: { ring: { selector: '.head-actions button.btn.primary' }, click: true },
                2: {
                    act: async (h) => {
                        await h.type('#t-subject', 'Order #1042 arrived damaged');
                        await h.type('#t-category', 'Delivery');
                    },
                    ring: { selector: 'form.create .form-grid' },
                    click: false,
                },
                3: {
                    act: async (h) => {
                        await h.page.select('#t-priority', 'high').catch(() => {});
                        await h.settle(200);
                    },
                    ring: { selector: '.s-field:has(#t-priority)' },
                    click: false,
                },
                4: { ring: { selector: '.s-field:has(#t-assignee)' }, click: false },
                5: {
                    act: async (h) => {
                        await h.type('#t-contact', 'Aarav');
                        await h.settle(800);
                    },
                    ring: { selector: '.s-field.picker' },
                    click: false,
                    after: async (h) => {
                        await h.page.click('#t-contact-list button').catch(() => {});
                        await h.settle(400);
                    },
                },
                6: { ring: { selector: 'form.create .actions button[type=submit]' }, click: false },
            },
        },
        2: {
            steps: {
                1: { ring: { selector: '.head-actions button[aria-controls=wa-settings]' }, click: true },
                2: {
                    act: async (h) => {
                        if (await h.page.$eval('button[aria-labelledby=set-auto]', (b) => b.getAttribute('aria-checked') !== 'true').catch(() => false)) {
                            await h.page.click('button[aria-labelledby=set-auto]').catch(() => {});
                            await h.settle(600);
                        }
                    },
                    ring: { selector: '.wa-settings .setting:has(#set-auto)' },
                    click: false,
                },
                3: {
                    act: (h) => h.type('#set-words', 'complaint, refund, not working'),
                    ring: { selector: 'form.keywords' },
                    click: false,
                },
                4: { ring: { selector: 'section.wa-settings' }, click: false },
            },
        },
        3: {
            steps: {
                1: { ring: { selector: '.head-actions button[aria-controls=wa-settings]' }, click: true },
                2: { ring: { selector: '.wa-settings .setting:has(#set-alerts)' }, click: false },
                3: { ring: { selector: '.wa-settings .setting:has(#set-alerts)' }, click: false },
            },
        },
        4: {
            steps: {
                1: { act: (h) => h.type('section.filters input[type=search]', 'refund'), ring: { selector: 'section.filters label.search' }, click: false },
                2: {
                    act: async (h) => {
                        await h.type('section.filters input[type=search]', '');
                        await h.page.keyboard.press('Backspace');
                        await h.page.select('section.filters select[aria-label=Priority]', 'high').catch(() => {});
                        await h.settle(400);
                    },
                    ring: { selector: 'section.filters' },
                    click: false,
                    after: async (h) => {
                        await h.page.select('section.filters select[aria-label=Priority]', '').catch(() => {});
                        await h.settle(300);
                    },
                },
                3: { ring: stat(2), click: true },
                4: { ring: { selector: 'section.filters button.btn.ghost' }, click: false },
            },
        },
        5: {
            steps: {
                1: { ring: row('TKT-0002'), click: true, after: (h) => h.settle(800) },
                2: { ring: { selector: 'aside.s-drawer .sla-bar' }, click: false },
                3: { ring: { selector: 'aside.s-drawer .d-grid' }, click: false },
                4: {
                    act: async (h) => {
                        await h.page.select('#d-status', 'RESOLVED').catch(() => {});
                        await h.settle(500);
                        await h.page.click('aside.s-drawer .confirm label.check input').catch(() => {});
                        await h.settle(200);
                    },
                    ring: { selector: 'aside.s-drawer .confirm' },
                    click: false,
                },
            },
        },
        6: {
            steps: {
                1: { ring: row('TKT-0001'), click: true, after: (h) => h.settle(800) },
                2: { ring: { selector: 'aside.s-drawer section.chat-wrap ol.chat' }, click: false },
                3: {
                    act: (h) => h.type('#d-reply', 'Good news - it is out for delivery today.'),
                    ring: { selector: 'form.composer:has(#d-reply)' },
                    click: false,
                },
            },
        },
        7: {
            steps: {
                1: { ring: row('TKT-0003'), click: true, after: (h) => h.settle(800) },
                2: {
                    act: (h) => h.type('#d-note', 'Promised a refund within 2 days; finance is checking.'),
                    ring: { selector: 'form.composer:has(#d-note)' },
                    click: false,
                },
                3: {
                    ring: { selector: 'form.composer:has(#d-note) button[type=submit]' },
                    click: true,
                    after: (h) => h.settle(800),
                },
                4: { ring: { selector: 'aside.s-drawer section[aria-label=Timeline]' }, click: false },
            },
        },
        8: {
            steps: {
                1: { ring: row('TKT-0004'), click: true, after: (h) => h.settle(800) },
                2: { ring: { selector: 'aside.s-drawer .csat' }, click: false },
            },
        },
        9: {
            steps: {
                1: { ring: stat(1), click: false },
                2: { ring: stat(2), click: false },
                3: { ring: stat(3), click: false },
                4: { ring: stat(4), click: false },
            },
        },
    },
};
