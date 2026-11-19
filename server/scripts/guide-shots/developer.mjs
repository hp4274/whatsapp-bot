/** Shot plan for the API & Webhooks guide. See ../guide-shots.mjs for the plan shape. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Tag the first visible `sel` whose text contains `text` (or `within` inside it) and return a selector for it. */
const tag = (h, sel, text, name, within = null) => h.page.evaluate((sel, text, name, within) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.checkVisibility() && n.textContent.includes(text));
    const t = el && within ? [...el.querySelectorAll(within)].find((n) => n.checkVisibility()) : el;
    if (t) t.dataset.g = name;
    return `[data-g="${name}"]`;
}, sel, text, name, within);
/** Tag, then click it. */
const press = async (h, sel, text, within) => h.click({ selector: await tag(h, sel, text, `p${Math.random().toString(36).slice(2)}`, within) });

const KEYS = 'section[aria-labelledby="dev-keys"]';
const HOOKS = 'section[aria-labelledby="dev-hooks"]';
const QUICK = 'section[aria-labelledby="dev-quick"]';
const ERP = 'https://erp.sunriseboutique.in/hooks/whatsapp';
const ZAP = 'https://hooks.zapier.com/hooks/catch/18342/sunrise';
const NEW = 'https://crm.sunriseboutique.in/webhooks/wuzie';

/**
 * This run's database: webhook deliveries only come from the job worker, which the shot server leaves off, so a
 * few finished ones are written straight in. Found by the prefix of a key minted here (prefixes are random).
 */
function openDb(prefix) {
    for (const dir of fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('wsender-shots-'))) {
        const file = path.join(os.tmpdir(), dir, 'shots.db');
        if (!fs.existsSync(file)) continue;
        try {
            const db = new DatabaseSync(file);
            if (db.prepare('SELECT 1 FROM api_keys WHERE prefix = ?').get(prefix)) return db;
            db.close();
        } catch { /* another run's file mid-write */ }
    }
    return null;
}

export default {
    async setup(h) {
        const soon = new Date(Date.now() + 6 * 86_400_000).toISOString();
        const old = (await h.api('POST', '/api/api-keys', { name: 'Old CRM sync', scopes: ['contacts:read', 'contacts:write'], expiresAt: soon })).key;
        const web = (await h.api('POST', '/api/api-keys', { name: 'Website orders', scopes: ['events:write', 'objects:write'] })).key;
        for (const k of [old, web]) await fetch(`${h.base}/api/v1/`, { headers: { authorization: `Bearer ${k?.key}` } }).catch(() => {});
        const erp = (await h.api('POST', '/api/webhook-endpoints', { url: ERP, events: ['message.received', 'message.failed', 'ticket.created'] })).endpoint;
        await h.api('POST', '/api/webhook-endpoints', { url: ZAP, events: ['workflow.completed'] });

        const db = old && erp && openDb(old.key.slice(0, 12));
        if (!db) return console.warn('developer plan: run database not found; deliveries left empty');
        const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
        const add = db.prepare(`INSERT INTO webhook_deliveries (tenant_id, endpoint_id, event_type, payload, status, attempt, response_code, error, created_at)
                                VALUES (1, ?, ?, '{}', ?, ?, ?, ?, ?)`);
        add.run(erp.id, 'message.received', 'failed', 5, 500, 'HTTP 500 Internal Server Error from your endpoint', ago(190));
        add.run(erp.id, 'ticket.created', 'failed', 3, null, 'connect ETIMEDOUT: no answer within 10 s', ago(95));
        add.run(erp.id, 'message.failed', 'delivered', 2, 200, null, ago(40));
        add.run(erp.id, 'message.received', 'delivered', 1, 200, null, ago(12));
        add.run(erp.id, 'message.received', 'delivered', 1, 204, null, ago(3));
        db.close();
    },
    tasks: {
        // Create an API key
        1: { steps: {
            1: { ring: { selector: '#dev-keys' } },
            2: { act: (h) => h.type(`${KEYS} input[name=keyName]`, 'ERP integration'), ring: { selector: `${KEYS} input[name=keyName]` }, click: false },
            3: { ring: { selector: `${KEYS} input[name=keyExpires]` }, click: false },
            4: {
                act: async (h) => {
                    await press(h, `${KEYS} form label.chk`, 'events:write');
                    await press(h, `${KEYS} form label.chk`, 'contacts:read');
                },
                ring: { selector: `${KEYS} form fieldset.checks` },
                click: false,
                after: (h) => h.click({ selector: `${KEYS} form button[type=submit]` }),
            },
            5: { ring: { selector: `${KEYS} .secret` }, click: false, after: (h) => press(h, `${KEYS} .secret button`, 'Done') },
        } },
        // Replace or revoke a key
        2: { steps: {
            1: { act: (h) => tag(h, `${KEYS} li.row`, 'Old CRM sync', 'old', '.meta'), ring: { selector: '[data-g="old"]' } },
            2: { act: (h) => tag(h, `${KEYS} li.row`, 'Old CRM sync', 'soon', '.tone-warn'), ring: { selector: '[data-g="soon"]' } },
            3: {
                act: (h) => press(h, `${KEYS} li.row`, 'Old CRM sync', '.row-actions button'),
                ring: { selector: `${KEYS} .row-actions .btn.danger` },
                click: true,
            },
        } },
        // Add a webhook endpoint
        3: { steps: {
            1: { act: (h) => h.type(`${HOOKS} input[name=hookUrl]`, NEW), ring: { selector: `${HOOKS} input[name=hookUrl]` }, click: false },
            2: {
                act: async (h) => {
                    await press(h, `${HOOKS} form label.chk`, 'message.received');
                    await press(h, `${HOOKS} form label.chk`, 'ticket.created');
                },
                ring: { selector: `${HOOKS} form fieldset.checks` },
                click: false,
            },
            3: { ring: { selector: `${HOOKS} form button[type=submit]` }, click: true },
            4: { ring: { selector: `${HOOKS} .secret` }, click: false, after: (h) => press(h, `${HOOKS} .secret button`, 'Done') },
        } },
        // Change, pause or delete a webhook
        4: { steps: {
            1: {
                act: (h) => press(h, `${HOOKS} li.row`, NEW, '.row-actions button:nth-child(2)'),
                ring: { selector: `${HOOKS} li.row fieldset.checks` },
                click: false,
                after: (h) => h.click({ selector: `${HOOKS} li.row .btn.primary` }),
            },
            2: { act: (h) => tag(h, `${HOOKS} li.row`, NEW, 'pause', '.row-actions button'), ring: { selector: '[data-g="pause"]' }, click: true },
            3: {
                act: (h) => press(h, `${HOOKS} li.row`, NEW, '.row-actions button:nth-child(3)'),
                ring: { selector: `${HOOKS} .row-actions .btn.danger` },
                click: true,
            },
        } },
        // Check webhook deliveries
        5: { steps: {
            1: { act: (h) => tag(h, `${HOOKS} li.row`, ERP, 'deliv', 'button.link'), ring: { selector: '[data-g="deliv"]' }, click: true },
            2: { act: (h) => h.settle(600), ring: { selector: `${HOOKS} .deliveries li:first-child` } },
            3: { act: (h) => tag(h, `${HOOKS} .deliveries li`, 'ETIMEDOUT', 'fail'), ring: { selector: '[data-g="fail"]' } },
        } },
        // Make your first API call
        6: { steps: {
            1: { ring: { selector: `${QUICK} .code .copy` }, click: false },
            2: { ring: { selector: `${QUICK} pre` } },
            3: { ring: { selector: `${QUICK} ul.routes` } },
        } },
    },
};
