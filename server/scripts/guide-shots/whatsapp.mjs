/**
 * Shot plan for the WhatsApp guide. See ../guide-shots.mjs for the plan shape.
 *
 * The sandbox links at once and has no QR code, sending levels, questions, brakes, account type or catalog. Where a
 * step needs one of those, the browser's own API calls are answered with the real data plus that one field (fake()),
 * so the real page renders the state the step describes. Nothing is ever unlinked, paused or deleted.
 * Setup adds a third, linked number ("Support line") so there is a card to switch to, make main and delete.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import QRCode from 'qrcode';

/** This run's database: the temp shots.db holding the marker FAQ category. */
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

// ------------------------------------------------------------------ fakes --

/** name -> (url, req) => undefined (pass through) | body to answer with. */
const fakes = new Map();
let installed = false;

async function fake(h, name, answer) {
    fakes.set(name, answer);
    if (installed) return;
    installed = true;
    await h.page.setRequestInterception(true);
    h.page.on('request', async (req) => {
        if (req.isInterceptResolutionHandled?.()) return;
        const url = new URL(req.url());
        try {
            for (const answer of fakes.values()) {
                const body = await answer(url, req);
                if (body === undefined) continue;
                if (typeof body === 'string') return req.respond({ status: 200, contentType: 'text/event-stream', body });
                return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            }
        } catch {
            // the real call
        }
        return req.continue();
    });
}

function unfake(name) {
    fakes.delete(name);
}

/** /api/channels with `patch(channel)` applied to each channel. */
const channels = (h, patch) => async (url, req) => {
    if (req.method() !== 'GET' || url.pathname !== '/api/channels') return undefined;
    const real = await h.api('GET', '/api/channels');
    for (const ch of real.channels ?? []) patch(ch);
    return real;
};

/** The selected number's connection, as /api/connection and the event stream's hello carry it. */
const connection = (state) => (url, req) => {
    if (req.method() !== 'GET') return undefined;
    const full = {
        connected: false, connecting: false, transport: 'baileys', name: null, account: '', detail: '', error: null,
        code: null, paused: null, realDelivery: true, supportsReceipts: true, qr: null, qrExpiresAt: null, ...state,
    };
    if (url.pathname === '/api/connection') return full;
    // retry: the stream is answered once and ends; keep the browser from asking again during the step.
    if (url.pathname === '/api/events') return `retry: 600000\nevent: hello\ndata: ${JSON.stringify(full)}\n\n`;
    return undefined;
};

const questions = (url, req) => {
    if (url.pathname !== '/api/channels/1/start') return undefined;
    if (req.method() === 'POST') return { todayLimit: 60, planLimit: 250 };
    return {
        asked: false, skipped: false, todayLimit: 0, planLimit: 250, suggested: null,
        skipWarning: { version: 1, text: ['Skipping starts this number at your plan\'s full day.'] },
    };
};

const PRODUCTS = [
    ['Cotton kurti - indigo', 1299, 'Hand block printed, sizes S to XXL'],
    ['Silk dupatta - maroon', 899, 'Pure silk with zari border'],
    ['Linen saree - ivory', 2499, 'Lightweight, with blouse piece'],
    ['Embroidered potli bag', 549, 'Mirror work, drawstring'],
    ['Kids lehenga set', 1899, 'Ages 2 to 10'],
    ['Block print bedsheet', 1199, 'King size, 2 pillow covers'],
];
const catalog = (url, req) => {
    if (req.method() !== 'GET' || url.pathname !== '/api/channels/1/catalog') return undefined;
    return {
        products: PRODUCTS.map(([name, price, description], i) => ({
            id: `p${i + 1}`, name, description, price, currency: 'INR', image: null, images: [], url: '',
            retailerId: `SB-${100 + i}`, hidden: false, status: 'APPROVED',
        })),
        collections: [
            { id: 'c1', name: 'Women', productIds: ['p1', 'p2', 'p3', 'p4'] },
            { id: 'c2', name: 'Kids', productIds: ['p5'] },
            { id: 'c3', name: 'Home', productIds: ['p6'] },
        ],
        fetchedAt: new Date().toISOString(),
    };
};

// ---------------------------------------------------------------- helpers --

let qrImage = null;

const main = 'app-channel-card:has(.ribbon)';
const support = '[data-shot-card="Support line"]';
const linkOther = '[data-shot-card="Sunrise Boutique"]';

/** Mark each number card with its name, so a step can point at "the Support line card". */
const tagCards = (h) => h.page.evaluate(() => {
    for (const card of document.querySelectorAll('app-channel-card')) {
        const name = card.querySelector('.title')?.textContent?.trim();
        if (name) card.dataset.shotCard = name;
    }
});
const openAdvanced = (card) => async (h) => {
    await tagCards(h);
    await h.page.evaluate((s) => document.querySelector(`${s} > details.advanced`)?.setAttribute('open', ''), card);
    await h.settle(400);
};
const click = (selector, ms = 500) => async (h) => {
    await h.page.click(selector).catch(() => {});
    await h.settle(ms);
};
const useNumber = async (h, id) => {
    await h.page.evaluate((n) => localStorage.setItem('wsender.channel', String(n)), id);
    await h.goto('/whatsapp');
    await tagCards(h);
};

export default {
    async setup(h) {
        // A third number, linked, so there is another card to use, make main, pause and delete.
        const made = await h.api('POST', '/api/channels', {
            displayName: 'Support line', phoneNumber: '919810000222', settings: { transport: 'sandbox' },
        });
        const id = made.channel?.id ?? made.id;
        if (id) {
            await h.page.evaluate(async (n) => {
                await fetch('/api/connection/connect', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-channel-id': String(n), authorization: `Bearer ${localStorage.getItem('wsender.token')}` },
                    body: '{}',
                });
            }, id);
        }
        qrImage = await QRCode.toDataURL('Wuzie guide example - not a real WhatsApp code', { margin: 1, width: 220 });
        // "Change limits" shows only when the platform admin allows own limits (tenant limits.allowCustomSafety),
        // which no business-facing API sets: write it into this run's own temp database.
        const marker = `shots-${Date.now()}`;
        const cat = await h.api('POST', '/api/faq/categories', { name: marker });
        const db = ownDb(marker);
        if (db) {
            const row = db.prepare('SELECT limits FROM tenants WHERE id = 1').get();
            const limits = { ...JSON.parse(row?.limits || '{}'), allowCustomSafety: true };
            db.prepare('UPDATE tenants SET limits = ? WHERE id = 1').run(JSON.stringify(limits));
            db.close();
        } else {
            console.warn('whatsapp plan: run database not found, Change limits stays hidden');
        }
        const catId = cat.category?.id ?? cat.id;
        if (catId) await h.api('DELETE', `/api/faq/categories/${catId}`);
    },
    tasks: {
        // ------------------------------------------------ 1. link by QR (on the unlinked Sunrise Boutique number)
        1: {
            async before(h) {
                await useNumber(h, 2);
            },
            steps: {
                1: { ring: { selector: `${main} section.link .link-actions .btn.primary` }, click: false },
                2: {
                    act: async (h) => {
                        await fake(h, 'conn', connection({ qr: qrImage, qrExpiresAt: new Date(Date.now() + 50_000).toISOString() }));
                        await useNumber(h, 2);
                    },
                    ring: { selector: `${main} section.link ol.steps` },
                    click: false,
                },
                3: { ring: { selector: `${main} section.link .phone` }, click: false },
                4: {
                    act: async (h) => {
                        await fake(h, 'conn', connection({ code: 'QR_EXPIRED' }));
                        await useNumber(h, 2);
                    },
                    ring: { selector: `${main} section.link .link-actions .btn.primary` },
                    click: false,
                },
                5: {
                    act: async (h) => {
                        unfake('conn');
                        await useNumber(h, 1);
                    },
                    ring: { selector: `${main} section.link .link-copy` },
                    click: false,
                },
            },
        },
        // ------------------------------------------------ 2. the 2 questions
        2: {
            async before(h) {
                await fake(h, 'channels', channels(h, (ch) => {
                    if (ch.id === 1) ch.health.usage = { ...ch.health.usage, todayLimit: 0, asked: false };
                }));
                await fake(h, 'questions', questions);
                await useNumber(h, 1);
            },
            steps: {
                1: { ring: { selector: `${main} button.answer` }, click: true, after: (h) => h.settle(800) },
                2: {
                    act: async (h) => {
                        await h.page.click('dialog.ask fieldset:nth-of-type(1) label.opt:nth-child(3)').catch(() => {});
                        await h.page.click('dialog.ask fieldset:nth-of-type(2) label.opt:nth-child(3)').catch(() => {});
                        await h.settle(300);
                    },
                    ring: { selector: 'dialog.ask form.nq' },
                    click: false,
                },
                3: { ring: { selector: 'dialog.ask button[type=submit]' }, click: false },
                4: {
                    act: async (h) => {
                        unfake('questions');
                        await fake(h, 'channels', channels(h, (ch) => {
                            if (ch.id === 1) ch.health.usage = { ...ch.health.usage, todayLimit: 60, planLimit: 250, growing: true, asked: true };
                        }));
                        await useNumber(h, 1);
                    },
                    ring: { selector: `${main} section.meter` },
                    click: false,
                    after: () => unfake('channels'),
                },
            },
        },
        // ------------------------------------------------ 3. add a number
        3: {
            steps: {
                1: { ring: { selector: 'header.s-head button.add' }, click: true },
                2: {
                    act: (h) => h.type('#c-name', 'Sales line'),
                    ring: { selector: 'form#add-number .grid' },
                    click: false,
                },
                3: { ring: { selector: 'form#add-number p.zone' }, click: false },
                4: { ring: { selector: 'form#add-number .new-foot button[type=submit]' }, click: false },
            },
        },
        // ------------------------------------------------ 4. switch numbers
        4: {
            before: tagCards,
            steps: {
                1: { ring: { selector: 'ul.stats' }, click: false },
                2: { ring: { selector: `${main} .ribbon` }, click: false },
                3: { ring: { selector: `${support} .actions button` }, click: false },
                4: { ring: { selector: '.badge.recommended' }, click: false },
            },
        },
        // ------------------------------------------------ 5. today and health
        5: {
            steps: {
                1: { ring: { selector: `${main} section.meter` }, click: false },
                2: { ring: { selector: `${main} .badge.score` }, click: false },
                3: {
                    act: async (h) => {
                        await fake(h, 'health', async (url, req) => {
                            if (req.method() !== 'GET' || url.pathname !== '/api/safety/health') return undefined;
                            const real = await h.api('GET', '/api/safety/health');
                            const brakes = [{ code: 'reply_rate', until: null, text: 'Few people replied to the last messages, so daily sending rises more slowly until more of them reply.' }];
                            if (real && typeof real === 'object' && 'brakes' in real) return { ...real, brakes };
                            if (real?.safety) return { ...real, safety: { ...real.safety, brakes } };
                            return { ...real, brakes };
                        });
                        await h.goto('/whatsapp');
                    },
                    ring: { selector: 'app-sending-health .band' },
                    click: false,
                    after: () => unfake('health'),
                },
                4: {
                    act: async (h) => {
                        await h.goto('/whatsapp');
                        await h.page.evaluate(() => document.querySelector('app-sending-health details.advanced')?.setAttribute('open', ''));
                        await h.settle(400);
                    },
                    ring: { selector: 'app-sending-health details.advanced > summary' },
                    click: false,
                },
                5: { ring: { selector: 'app-sending-health header.card-head button' }, click: false },
            },
        },
        // ------------------------------------------------ 6. sending hours
        6: {
            before: openAdvanced(main),
            steps: {
                1: { ring: { selector: `${main} section.block:has(app-send-window)` }, click: false },
                2: {
                    act: async (h) => {
                        await click(`${main} app-send-window .mode button:nth-child(2)`)(h);
                        await click(`${main} app-send-window .presets button:nth-child(1)`)(h);
                    },
                    ring: { selector: `${main} app-send-window fieldset.days` },
                    click: false,
                },
                3: {
                    act: async (h) => {
                        const from = await h.page.$(`${main} app-send-window .times input`);
                        if (from) {
                            await from.click();
                            await h.page.keyboard.type('0900AM');
                        }
                        await h.settle(300);
                    },
                    ring: { selector: `${main} app-send-window .times` },
                    click: false,
                },
                4: { ring: { selector: `${main} app-send-window .foot button[type=submit]` }, click: true, after: (h) => h.settle(1000) },
                5: {
                    act: openAdvanced(main),
                    ring: { selector: `${main} app-send-window .foot button.btn.small:not([type=submit])` },
                    // Back to any time, as the number was.
                    click: true,
                    after: (h) => h.settle(800),
                },
            },
        },
        // ------------------------------------------------ 7. what a number can send
        7: {
            steps: {
                1: { ring: { selector: `${main} > details.advanced > summary` }, click: true },
                2: { ring: { selector: `${main} ul.switches` }, click: false },
                3: { ring: { selector: `${main} app-channel-settings .bulk` }, click: false },
            },
        },
        // ------------------------------------------------ 8. rename, main number, pause, delete
        8: {
            before: tagCards,
            steps: {
                1: {
                    act: click(`${main} .names h3 button.pencil`),
                    ring: { selector: `${main} .names form.inline` },
                    click: false,
                    after: click(`${main} .names form.inline button:not([type=submit])`),
                },
                2: {
                    act: openAdvanced(support),
                    ring: { selector: `${support} .manage button:first-child` },
                    click: false,
                },
                3: { ring: { selector: `${support} .manage > button:nth-of-type(2)` }, click: false },
                4: {
                    act: click(`${support} .manage button.ghost-danger`),
                    ring: { selector: `${support} .manage .confirm.danger-zone` },
                    click: false,
                },
            },
        },
        // ------------------------------------------------ 9. unlink / link again
        9: {
            steps: {
                1: { ring: { selector: `${main} section.link .link-actions button.danger` }, click: false },
                2: {
                    act: async (h) => {
                        await fake(h, 'channels', channels(h, (ch) => {
                            if (ch.id === 2) {
                                ch.health = { ...ch.health, connected: false, error: 'Connection Closed', transport: 'baileys' };
                            }
                        }));
                        await useNumber(h, 1);
                    },
                    ring: { selector: `${linkOther} p.alert` },
                    click: false,
                },
                3: { ring: { selector: `${linkOther} .actions button.cta` }, click: false, after: () => unfake('channels') },
            },
        },
        // ------------------------------------------------ 10. catalog
        10: {
            async before(h) {
                await fake(h, 'channels', channels(h, (ch) => {
                    if (ch.id === 1) ch.health = { ...ch.health, accountType: 'business' };
                }));
                await fake(h, 'catalog', catalog);
                await useNumber(h, 1);
            },
            steps: {
                1: { ring: { selector: `${main} button.catalog` }, click: true, after: (h) => h.settle(800) },
                2: { ring: { selector: 'aside.drawer .toolbar' }, click: false },
                3: {
                    act: async (h) => {
                        await click('aside.drawer ul.grid li:nth-child(1) input.pick', 200)(h);
                        await click('aside.drawer ul.grid li:nth-child(3) input.pick', 200)(h);
                    },
                    ring: { selector: 'aside.drawer button.btn.primary' },
                    click: false,
                },
                4: {
                    act: async (h) => {
                        unfake('catalog');
                        await fake(h, 'channels', channels(h, (ch) => {
                            if (ch.id === 1) ch.health = { ...ch.health, accountType: 'personal' };
                        }));
                        await useNumber(h, 1);
                        await click(`${main} button.catalog`, 700)(h);
                    },
                    // Never clicked: it would unlink the number to show a new code.
                    ring: { selector: '.dialog .dialog-actions .btn.primary' },
                    click: false,
                    after: async (h) => {
                        unfake('channels');
                        await h.page.keyboard.press('Escape');
                    },
                },
            },
        },
        // ------------------------------------------------ 11. sending limits
        11: {
            steps: {
                1: { ring: { selector: 'section.safety details.limits > summary' }, click: true },
                2: {
                    act: async (h) => {
                        await click('app-safety-controls .sc-actions button', 800)(h);
                        await click('aside.sc-drawer .sc-check input', 200)(h);
                        await h.type('#sc-name', 'Asha Verma');
                        await h.type('#sc-confirm', 'I ACCEPT');
                    },
                    ring: { selector: 'aside.sc-drawer footer .btn.danger' },
                    click: true,
                    after: (h) => h.settle(1000),
                },
                3: {
                    act: async (h) => {
                        const input = await h.page.$('aside.sc-drawer .sc-group input[type=number]');
                        if (input) {
                            await input.click({ clickCount: 3 });
                            await h.page.keyboard.type('5000');
                            await h.settle(400);
                        }
                    },
                    ring: { selector: 'aside.sc-drawer footer .btn.primary' },
                    click: false,
                },
                4: { ring: { selector: 'aside.sc-drawer footer > .btn:first-child' }, click: false },
            },
        },
        // ------------------------------------------------ 12. ban checklist
        12: {
            steps: {
                1: { ring: { selector: 'section.recover summary' }, click: true },
                2: { ring: { selector: 'ol.recover-steps li:nth-child(1)' }, click: false },
                3: { ring: { selector: 'ol.recover-steps li:nth-child(2)' }, click: false },
                4: { ring: { selector: 'ol.recover-steps li:nth-child(3)' }, click: false },
            },
        },
    },
};
