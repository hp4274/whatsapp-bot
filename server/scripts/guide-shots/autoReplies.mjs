/** Shot plan for the Auto-replies guide (key autoReplies). See ../guide-shots.mjs for the plan shape. */

const G = { selector: '[data-g]' };
const ED = 'ar-rule-editor form.editor';
const RL = 'ar-rule-list';

/** Tag the first visible `sel` whose text contains `text` as [data-g]. */
const mark = (h, sel, text) => h.page.evaluate((s, t) => {
    document.querySelectorAll('[data-g]').forEach((n) => delete n.dataset.g);
    const el = [...document.querySelectorAll(s)].find((n) => n.checkVisibility() && n.textContent.includes(t));
    if (el) el.dataset.g = '';
    return Boolean(el);
}, sel, text);
const clickMarked = async (h, sel, text) => { if (await mark(h, sel, text)) await h.click(G); };
/** Replace a field's text the way a person would: select all, type. */
const fill = async (h, sel, text) => {
    await h.page.click(sel).catch(() => {});
    await h.page.keyboard.down('Control'); await h.page.keyboard.press('a'); await h.page.keyboard.up('Control');
    await h.page.keyboard.type(text);
    await h.settle(300);
};
const press = async (h, key) => { await h.page.keyboard.press(key); await h.settle(300); };
const basics = async (h) => { await h.page.waitForSelector('ar-system-cards .tiles', { timeout: 8000 }).catch(() => {}); await h.settle(600); };
const rules = async (h) => { await h.page.waitForSelector(`${RL} ol.list`, { timeout: 8000 }).catch(() => {}); await h.settle(600); };
/** Open a system card's settings and make sure its Enabled switch is on. */
const configure = (n) => ({ ring: { selector: `ar-system-cards article.tile:nth-child(${n}) button.cfg` }, click: true, after: (h) => h.settle(600) });
const enable = (h) => h.page.evaluate(() => {
    const b = document.querySelector('#sc-panel header button[role=switch]');
    if (b && b.getAttribute('aria-checked') !== 'true') b.click();
});
const field = (id) => ({ selector: `#sc-panel .field:has(#${id})` });
const saveCard = { ring: { selector: '#sc-panel footer .btn.primary' }, click: false };
const openRule = async (h, name) => {
    await rules(h);
    await clickMarked(h, `${RL} li.item button.main`, name);
    await h.page.waitForSelector(ED, { timeout: 8000 }).catch(() => {});
    await h.settle(600);
};

export default {
    async setup(h) {
        // A menu rule (for "tap a button" in Try it) and a rule that asks questions (for "where customers left").
        const help = await h.api('POST', '/api/auto-replies', {
            name: 'Help menu', matchType: 'EXACT', keywords: ['help', 'menu'], isActive: true,
            replyBody: 'Hi {first_name|there}! How can {business_name|we} help you today?',
            variants: ['Hi {first_name|there}! How can {business_name|we} help you today?'],
            interactive: { type: 'list', list: { button: 'Options', sections: [{ title: 'Help', rows: [
                { id: 'PRICES', title: 'Prices' }, { id: 'HOURS', title: 'Opening hours' }, { id: 'PERSON', title: 'Talk to a person' },
            ] }] } },
            menu: {
                PRICES: { replyBody: 'Sarees start at Rs 1,499 and kurtis at Rs 699. Reply with a product name for its price.' },
                HOURS: { replyBody: 'We are open Mon-Sat, 10 am - 8 pm.' },
                PERSON: { replyBody: 'Connecting you to a team member. Someone will reply here shortly.', actions: { escalate: true } },
            },
        });
        const callback = await h.api('POST', '/api/auto-replies', {
            name: 'Callback request', matchType: 'ANY_OF', keywords: ['call me', 'callback'], isActive: true,
            replyBody: 'Sure, we will call you.', variants: ['Sure, we will call you.'],
            collect: {
                questions: [
                    { key: 'name', question: 'May I have your name?', type: 'name' },
                    { key: 'callback_phone', question: 'Which number should we call?', type: 'phone' },
                ],
                doneReply: 'Thanks {name}! We will call you on {callback_phone} soon.',
            },
            actions: { addTag: 'callback', setField: null, escalate: false, stop: false },
        });

        // A week of customer messages, so Reports and Activity show real numbers (sandbox rows, nothing is sent).
        const db = h.db;
        try {
            const channel = db.prepare('SELECT id FROM whatsapp_channels WHERE tenant_id = 1 ORDER BY id LIMIT 1').get()?.id ?? 1;
            const ago = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
            const people = ['919810000101', '919810000102', '919810000103', '919810000104', '919811122233', '919822233344', '919844455566'];
            const inbound = db.prepare(`INSERT INTO inbound_messages (tenant_id, channel_id, message_id, sender, sender_name, body, replied_rule, received_at)
                VALUES (1, ?, ?, ?, '', ?, ?, ?)`);
            const log = db.prepare(`INSERT INTO autoreply_log (tenant_id, channel_id, phone, inbound, outcome, rule, detail, at) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`);
            const hit = db.prepare('INSERT INTO autoreply_hits (tenant_id, channel_id, rule_key, phone, at) VALUES (1, ?, ?, ?, ?)');
            const said = [
                ['price', 'price', 'Our latest rate card is here: https://example.com/rates. Reply with the product name for a quote.'],
                ['saree price?', 'price', 'Our latest rate card is here: https://example.com/rates. Reply with the product name for a quote.'],
                ['what are your hours', 'hours', 'We are open Monday to Saturday, 10:00 AM to 8:00 PM, and Sunday 11:00 AM to 5:00 PM.'],
                ['location', 'location', 'Find us at Shop 12, MG Road, near the City Mall signal.'],
                ['hi', 'welcome', 'Welcome to Sunrise Boutique! Reply MENU to see what we can help with.'],
                ['menu', 'help', 'Hi there! How can Sunrise Boutique help you today?'],
            ];
            const missed = ['do you have cash on delivery', 'exchange policy?', 'do you have cash on delivery', 'bridal lehenga on rent?', 'do you have cash on delivery', 'exchange policy?'];
            let n = 0;
            for (let i = 0; i < 42; i++) {
                const at = ago(2 + i * 3.7);
                const who = people[i % people.length];
                if (i % 7 === 3) {
                    const text = missed[(i / 7) | 0] ?? 'is the red kurti back in stock';
                    inbound.run(channel, `shot-ar-${n++}`, who, text, null, at);
                    log.run(channel, who, text, 'none', '', 'Nothing matched', at);
                    hit.run(channel, 'miss', who, at);
                } else {
                    const [text, key, reply] = said[i % said.length];
                    inbound.run(channel, `shot-ar-${n++}`, who, text, key, at);
                    log.run(channel, who, text, 'replied', key === 'welcome' ? 'Welcome' : key === 'help' ? 'Help menu' : key, reply, at);
                    hit.run(channel, key, who, at);
                }
            }
            log.run(channel, '919810000103', 'price', 'skipped', 'price', 'This contact already got the most automatic replies allowed this hour', ago(1.5));
            log.run(channel, '919810000104', 'hours', 'failed', 'hours', 'The WhatsApp number was not connected', ago(1.2));
            log.run(channel, '919811122233', 'hii', 'replied', 'Welcome', 'Welcome to Sunrise Boutique! Reply MENU to see what we can help with.', ago(0.4));
            // Customers who stopped part-way through the callback questions and the help menu.
            const session = db.prepare(`INSERT INTO autoreply_sessions (tenant_id, channel_id, phone, rule_id, path, expires_at) VALUES (1, ?, ?, ?, ?, ?)`);
            if (callback?.rule?.id) {
                session.run(channel, '919810000101', callback.rule.id, JSON.stringify({ flow: { step: 1, answers: { name: 'Aarav' } } }), ago(20));
                session.run(channel, '919810000102', callback.rule.id, JSON.stringify({ flow: { step: 1, answers: { name: 'Priya' } } }), ago(44));
            }
            if (help?.rule?.id) session.run(channel, '919822233344', help.rule.id, JSON.stringify([]), ago(30));
        } catch (err) { console.warn('auto-replies report rows:', err.message); }
    },
    tasks: {
        1: {
            before: basics,
            steps: {
                1: { ring: { selector: '#tab-basics' }, click: false },
                2: { ring: { selector: 'ar-system-cards .general[aria-label="Settings"] ar-switch' }, click: false },
                3: { act: (h) => fill(h, '#sc-biz', 'Sunrise Boutique'), ring: { selector: 'ar-system-cards .bar .biz' } },
            },
        },
        2: {
            before: basics,
            steps: {
                1: configure(1),
                2: {
                    act: async (h) => { await enable(h); await fill(h, '#sc-text-welcome', 'Welcome to {business_name}! Reply MENU to see our latest collection, prices and timings.'); },
                    ring: field('sc-text-welcome'),
                },
                // The Welcome card has no "once every ... hours" box (only Away does): show its settings as they are.
                3: { ring: { selector: '#sc-panel header' } },
                4: saveCard,
            },
        },
        3: {
            before: basics,
            steps: {
                1: configure(2),
                2: {
                    act: async (h) => { await enable(h); await fill(h, '#sc-text-away', 'Thanks for your message! We are closed right now and will reply when we open at 10 am.'); },
                    ring: field('sc-text-away'),
                },
                3: { ring: { selector: '#sc-panel .hours' } },
                4: {
                    act: async (h) => {
                        // A date box commits on change, so set the whole date at once (typing it commits the first valid part).
                        for (const d of ['2026-11-08', '2026-12-25']) {
                            await h.page.evaluate((v) => { const i = document.querySelector('#sc-hol'); i.value = v; i.dispatchEvent(new Event('change', { bubbles: true })); }, d);
                            await h.settle(300);
                        }
                        await h.page.focus('#sc-hol');
                    },
                    ring: field('sc-hol'),
                },
                5: saveCard,
            },
        },
        4: {
            before: basics,
            steps: {
                1: configure(3),
                2: {
                    act: async (h) => { await enable(h); await fill(h, '#sc-text-fallback', 'Sorry, I did not get that. Reply MENU for options or call us on 98765 43210.'); },
                    ring: field('sc-text-fallback'),
                },
                3: { act: (h) => fill(h, '#sc-fthr', '12'), ring: field('sc-fthr') },
                4: { act: (h) => fill(h, '#sc-fho', '2'), ring: field('sc-fho') },
                5: saveCard,
            },
        },
        5: {
            before: basics,
            steps: {
                1: { ...configure(4), after: async (h) => { await h.settle(600); await enable(h); await h.settle(300); } },
                2: {
                    act: async (h) => {
                        await h.page.click('#sc-hk').catch(() => {});
                        for (const k of ['agent', 'talk to someone']) { await h.page.keyboard.type(k); await press(h, 'Enter'); }
                    },
                    ring: field('sc-hk'),
                },
                3: { act: (h) => fill(h, '#sc-text-handoff', 'Sure! A team member will reply here shortly.'), ring: field('sc-text-handoff') },
                4: { act: (h) => fill(h, '#sc-hp', '6'), ring: field('sc-hp') },
            },
        },
        6: {
            before: basics,
            steps: {
                1: { ring: { selector: 'ar-system-cards details.advanced > summary' }, click: true },
                2: { ring: { selector: 'ar-system-cards .general[aria-label="Reply speed"]' } },
                3: { ring: { selector: 'select[aria-label="How replies pick a language"]' }, click: false },
                4: { act: (h) => mark(h, 'ar-system-cards .lang label', 'Hinglish / Gujlish'), ring: G, click: false },
            },
        },
        7: {
            path: '/auto-replies?tab=rules',
            before: rules,
            steps: {
                1: { ring: { selector: `${RL} .top .actions button:first-child` }, click: true },
                2: { ring: { selector: `${RL} ul.templates[aria-label="Rule sets"]` }, click: false, after: (h) => clickMarked(h, `${RL} button.tpl`, 'Store info') },
                3: { ring: { selector: `${RL} .pack > .btn.primary` }, click: true, after: (h) => h.settle(1200) },
                4: { ring: { selector: `${RL} li.item.off` }, click: false },
            },
        },
        8: {
            path: '/auto-replies?tab=rules',
            before: rules,
            steps: {
                1: { ring: { selector: `${RL} .top .btn.primary` }, click: true, after: (h) => h.settle(600) },
                2: {
                    act: async (h) => {
                        await fill(h, 'input[aria-label="Rule name"]', 'Saree prices');
                        await clickMarked(h, `${ED} .mtypes label.mt`, 'Contains');
                        await h.page.click('#re-kw').catch(() => {});
                        for (const k of ['saree price', 'saree cost']) { await h.page.keyboard.type(k); await press(h, 'Enter'); }
                    },
                    ring: { selector: `${ED} section.sec:has(.mtypes)` },
                },
                3: {
                    act: (h) => fill(h, `${ED} ar-variants textarea`, 'Our silk sarees start at Rs 2,499 and cotton sarees at Rs 899. Reply with a colour to see photos.'),
                    ring: { selector: `${ED} section.sec:has(ar-variants)` },
                },
                4: { ring: { selector: `${ED} section.sec:has(app-interactive-editor)` } },
                5: { ring: { selector: `${ED} section.sec:has(ar-schedule-editor)` } },
                6: { ring: { selector: `${ED} footer.foot button[type=submit]` }, click: false },
            },
        },
        9: {
            path: '/auto-replies?tab=rules',
            before: (h) => openRule(h, 'price'),
            steps: {
                1: { ring: { selector: `${ED} button.add-q` }, click: true },
                2: {
                    act: async (h) => {
                        await fill(h, 'input[aria-label="Question 1"]', 'May I have your name?');
                        await h.page.select('select[aria-label="Answer type for question 1"]', 'name').catch(() => {});
                        await fill(h, 'input[aria-label="Save answer 1 to contact field"]', 'name');
                    },
                    ring: { selector: `${ED} .ask` },
                },
                3: { act: (h) => fill(h, '#re-done', 'Thanks {name}! Our team will send you the full price list shortly.'), ring: { selector: `${ED} .field:has(#re-done)` } },
                4: { ring: { selector: `${ED} footer.foot button[type=submit]` }, click: false },
            },
        },
        10: {
            path: '/auto-replies?tab=rules',
            before: (h) => openRule(h, 'price'),
            steps: {
                1: { ring: { selector: `${ED} section.sec:has(#re-tag) h3` } },
                2: {
                    act: async (h) => {
                        await fill(h, '#re-tag', 'price-enquiry');
                        await fill(h, 'input[aria-label="Field key"]', 'interest');
                        await fill(h, 'input[aria-label="Field value"]', 'sarees');
                    },
                    ring: { selector: `${ED} section.sec:has(#re-tag) .grid2` },
                },
                3: {
                    act: (h) => h.page.evaluate((sel) => { const c = document.querySelector(sel); if (c && !c.checked) c.click(); }, `${ED} section.sec:has(#re-tag) label.check input`),
                    ring: { selector: `${ED} section.sec:has(#re-tag) label.check` },
                    click: false,
                },
                4: { ring: { selector: `${ED} footer.foot button[type=submit]` }, click: false },
            },
        },
        11: {
            path: '/auto-replies?tab=rules',
            before: rules,
            steps: {
                1: { ring: { selector: `${RL} li.item:nth-child(2) .arrows` }, click: false },
                2: { ring: { selector: `${RL} li.item:nth-child(2) .side ar-switch` }, click: false },
                3: {
                    act: async (h) => {
                        await h.click({ selector: `${RL} li.item:nth-child(2) button.main` });
                        await h.page.waitForSelector(ED, { timeout: 8000 }).catch(() => {});
                        await clickMarked(h, `${ED} footer.foot button.btn.ghost`, 'Delete');
                    },
                    ring: { selector: `${ED} footer.foot .confirm` },
                    click: false,
                },
            },
        },
        12: {
            path: '/auto-replies?tab=test',
            before: async (h) => { await h.page.waitForSelector('#tc-body', { timeout: 8000 }).catch(() => {}); await h.settle(500); },
            steps: {
                1: { ring: { selector: '#tab-test' }, click: false },
                2: {
                    act: async (h) => { await fill(h, '#tc-body', 'menu'); await fill(h, '#tc-nm', 'Riya'); await h.page.select('#tc-first', 'yes').catch(() => {}); },
                    ring: { selector: 'ar-test-console form.form' },
                },
                3: {
                    act: async (h) => { await h.click({ selector: 'button[aria-label="Run test"]' }); await h.settle(1500); },
                    ring: { selector: 'ar-test-console ar-wa-preview' },
                },
                4: { ring: { selector: 'ar-test-console .taps' }, click: false },
            },
        },
        13: {
            path: '/auto-replies?tab=report',
            before: async (h) => { await h.page.waitForSelector('ar-report .stats', { timeout: 8000 }).catch(() => {}); await h.settle(800); },
            steps: {
                1: { ring: { selector: 'ar-report .s-seg[aria-label="Report range"]' }, click: false },
                2: { ring: { selector: 'section[aria-labelledby="rp-hot"]' } },
                3: { ring: { selector: 'section[aria-labelledby="rp-miss"] button' }, click: false },
                4: { ring: { selector: 'section[aria-labelledby="rp-left"]' } },
            },
        },
        14: {
            path: '/auto-replies?tab=log',
            before: async (h) => { await h.page.waitForSelector('ar-activity-log ol.lines', { timeout: 8000 }).catch(() => {}); await h.settle(600); },
            steps: {
                1: { ring: { selector: '#tab-log' }, click: false },
                2: { ring: { selector: 'ar-activity-log .filters' }, click: false },
                3: { ring: { selector: 'ar-activity-log ol.lines li:first-child' } },
            },
        },
    },
};
