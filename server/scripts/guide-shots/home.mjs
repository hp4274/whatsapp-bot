/**
 * Shot plan for the Home guide. See ../guide-shots.mjs for the plan shape.
 * The sandbox number has no sending levels, so it is never asked its 2 questions: tasks 1-2 answer the browser's
 * /channels calls with the real data plus `asked: false` (and `skipped` for task 2) so the real card shows.
 */

/** Answer the page's channel and start calls as a QR number whose questions wait (or were skipped). */
async function askQuestions(h, skipped) {
    const { page } = h;
    await page.setRequestInterception(true);
    page.removeAllListeners('request');
    page.on('request', async (req) => {
        const url = new URL(req.url());
        const json = (body) => req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
        try {
            if (req.method() === 'GET' && url.pathname === '/api/channels') {
                const real = await h.api('GET', '/api/channels');
                for (const ch of real.channels ?? []) {
                    if (ch.id !== 1) continue;
                    ch.health.usage = { ...ch.health.usage, asked: skipped, ...(skipped ? { skipped: true } : {}), todayLimit: skipped ? 250 : 0 };
                }
                return json(real);
            }
            if (req.method() === 'GET' && url.pathname === '/api/channels/1/start') {
                return json({
                    asked: skipped, skipped, todayLimit: 250, planLimit: 250, suggested: null,
                    skipWarning: { version: 1, text: ['Skipping starts this number at your plan\'s full day.'] },
                });
            }
            if (req.method() === 'POST' && url.pathname === '/api/channels/1/start') return json({ todayLimit: 60, planLimit: 250 });
        } catch {
            // fall through to the real call
        }
        return req.continue();
    });
}

async function stopFaking(h) {
    h.page.removeAllListeners('request');
    await h.page.setRequestInterception(false);
}

const ask = 'section.ask';
const pick = (fieldset, n) => async (h) => {
    await h.page.click(`${ask} fieldset:nth-of-type(${fieldset}) label.opt:nth-child(${n})`).catch(() => {});
    await h.settle(300);
};

export default {
    tasks: {
        1: {
            async before(h) {
                await askQuestions(h, false);
                await h.goto('/home');
            },
            steps: {
                1: { ring: { selector: `${ask} fieldset:nth-of-type(1)` }, click: false, after: pick(1, 3) },
                2: { ring: { selector: `${ask} fieldset:nth-of-type(2)` }, click: false, after: pick(2, 3) },
                3: { ring: { selector: `${ask} button[type=submit]` }, click: true, after: (h) => h.settle(800) },
                4: { ring: { selector: `${ask} > button.btn.sm` }, click: false },
            },
        },
        2: {
            async before(h) {
                await askQuestions(h, true);
                await h.goto('/home');
            },
            steps: {
                1: { ring: { selector: `${ask} .nq-head` }, click: false },
                2: {
                    act: async (h) => {
                        await pick(1, 2)(h);
                        await pick(2, 2)(h);
                    },
                    ring: { selector: `${ask} button[type=submit]` },
                    click: false,
                    after: stopFaking,
                },
            },
        },
        3: {
            steps: {
                1: { ring: { selector: 'app-plan-usage .card-head' } },
                2: { ring: { selector: 'app-plan-usage ul.meters.main' } },
                3: {
                    act: async (h) => {
                        await h.page.evaluate(() => document.querySelector('app-plan-usage details.advanced')?.setAttribute('open', ''));
                        await h.settle(300);
                    },
                    ring: { selector: 'app-plan-usage details.advanced' },
                    click: false,
                },
            },
        },
        4: {
            steps: {
                1: { ring: { selector: 'section.stats' } },
                2: { ring: { selector: 'section.stats' } },
            },
        },
        5: {
            steps: {
                1: { ring: { selector: 'ul.recent li a' }, click: false },
                2: { ring: { selector: 'section[aria-labelledby=recent-title] .card-head a' }, click: false },
            },
        },
        6: {
            steps: {
                1: { ring: { selector: 'header.s-head a.btn.primary' }, click: true, after: (h) => h.settle(800) },
                2: { ring: { selector: 'nav[aria-label="Campaign steps"]' } },
            },
        },
    },
};
