/** Shot plan for the Analytics guide. See ../guide-shots.mjs for the plan shape. */
import { seedActivity } from './history.mjs';

/** Scroll an element to the middle of the screen first, so the shot around it is not clipped. */
const into = (selector) => async (h) => {
    await h.page.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: 'center' }), selector);
    await h.settle(900);
};
const sel = (selector) => ({ selector });
/** The subscription row task 7 replaced, put back after it. */
let saved = null;

export default {
    setup: seedActivity,
    tasks: {
        1: {
            steps: {
                1: { ring: sel('header.s-head h1') }, // not in the menu while Analytics is "coming soon": the page itself
                2: { act: (h) => h.settle(1500), ring: sel('.segmented[aria-label="Date range"]'), click: false },
                3: { act: (h) => h.click({ selector: '.segmented button:nth-of-type(1)' }).then(() => h.settle(1200)), ring: sel('section.kpis') },
                4: { ring: sel('button[aria-label="Refresh analytics"]'), click: false },
            },
        },
        2: {
            before: (h) => h.settle(1500),
            steps: {
                1: { ring: sel('section.kpis') },
                2: { ring: sel('section.kpis article:nth-of-type(1) svg.spark') },
                3: { ring: sel('section.kpis article:nth-of-type(4)') },
            },
        },
        3: {
            before: (h) => h.settle(1500),
            steps: {
                1: { act: into('#t-trend'), ring: sel('section[aria-labelledby="t-trend"]') },
                2: {
                    act: async (h) => {
                        await into('app-trend-chart .plot')(h);
                        // The keyboard picks a day the same way the pointer does, and survives the screenshot.
                        await h.page.focus('app-trend-chart .plot');
                        await h.page.keyboard.press('ArrowLeft');
                        await h.page.keyboard.press('ArrowLeft');
                        await h.settle(500);
                    },
                    ring: sel('app-trend-chart .plot'),
                    after: (h) => h.page.evaluate(() => document.activeElement?.blur()),
                },
                3: { act: (h) => h.click({ selector: 'app-trend-chart .lg.k-failed' }), ring: sel('app-trend-chart .legend'), click: false },
                4: { ring: sel('button[aria-label="Export the daily series as CSV"]'), click: false },
            },
        },
        4: {
            before: (h) => h.settle(1500),
            steps: {
                1: { act: into('#t-campaigns'), ring: sel('app-campaign-table') },
                2: { act: (h) => h.click({ selector: 'app-campaign-table th:nth-of-type(4) button.sort' }), ring: sel('app-campaign-table thead tr'), click: false },
                3: { ring: sel('app-campaign-table tbody th.name a'), click: false },
                4: { ring: sel('button[aria-label="Export the campaign table as CSV"]'), click: false },
            },
        },
        5: {
            before: (h) => h.settle(1500),
            steps: {
                1: { act: into('#t-response'), ring: sel('app-response-times') },
                2: { ring: sel('app-response-times .hero') },
                3: { ring: sel('app-response-times .mini div:nth-of-type(3)') },
                4: { act: into('app-response-times .dist'), ring: sel('app-response-times .dist') },
            },
        },
        6: {
            before: (h) => h.settle(1500),
            steps: {
                1: { act: into('#t-auto'), ring: sel('section[aria-labelledby="t-auto"] dl.facts') },
                2: { ring: sel('section[aria-labelledby="t-auto"] ul.hbars') },
                3: { ring: sel('section[aria-labelledby="t-auto"] a.link'), click: false },
            },
        },
        7: {
            // The ring needs a plan with a monthly quota: a subscription and a quota of 400 for this task only.
            async before(h) {
                saved = h.db.prepare('SELECT * FROM subscriptions WHERE tenant_id = 1').get() ?? null;
                const now = new Date().toISOString();
                h.db.prepare("INSERT OR REPLACE INTO subscriptions (tenant_id, plan_key, status, starts_at, current_period_end, created_at, updated_at) VALUES (1, 'business', 'active', ?1, ?2, ?1, ?1)")
                    .run(now, new Date(Date.now() + 20 * 86400000).toISOString());
                const { limits } = h.db.prepare('SELECT limits FROM tenants WHERE id = 1').get();
                h.db.prepare('UPDATE tenants SET limits = ? WHERE id = 1').run(JSON.stringify({ ...JSON.parse(limits || '{}'), messagesPerMonth: 400 }));
                await h.goto('/analytics');
                await h.settle(1500);
            },
            steps: {
                1: { act: into('app-monthly-usage'), ring: sel('app-monthly-usage .mchart') },
                2: {
                    ring: sel('app-monthly-usage .ring'),
                    after: (h) => {
                        h.db.prepare('DELETE FROM subscriptions WHERE tenant_id = 1').run();
                        if (saved) h.db.prepare(`INSERT INTO subscriptions (${Object.keys(saved)}) VALUES (${Object.keys(saved).map(() => '?')})`).run(...Object.values(saved));
                    },
                },
            },
        },
        8: {
            before: (h) => h.settle(1500),
            steps: {
                1: { act: into('h2.section-h'), ring: sel('h2.section-h') },
                2: { act: into('#t-camp'), ring: sel('section[aria-labelledby="t-camp"]') },
                3: { act: into('#t-support'), ring: sel('section[aria-labelledby="t-support"] ul.hbars') },
                4: {
                    act: (h) => h.page.evaluate(() => [...document.querySelectorAll('section[aria-labelledby="t-rec"] .rbars > li')]
                        .find((li) => li.querySelector('strong')?.textContent.trim() === 'Order')?.setAttribute('data-g', 'order')),
                    ring: sel('[data-g="order"]'),
                },
            },
        },
    },
};
