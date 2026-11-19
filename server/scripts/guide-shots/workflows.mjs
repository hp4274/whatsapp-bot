/** Shot plan for the Workflows guide (/workflows). See ../guide-shots.mjs for the plan shape. */

const ACTIVE = 'li.row:has(.s-pill.st-active)';
const DRAFT = 'li.row:has(.s-pill.st-draft)';
/** Shrink a full-width strip (the chips row) to its content, so the ring hugs the chips and the shot stays 1:1. */
const fit = (h, selector) => h.page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.style.width = 'fit-content'; }, selector);
const FAILED = '.run-list > li:has(.run > button.btn)'; // only a failed run has a Retry button beside it

export default {
    async setup(h) {
        // An active workflow with runs to show: one that went through, one that failed (no contact to tag).
        const { workflow } = await h.api('POST', '/api/workflows', {
            name: 'Thank new buyers',
            status: 'active',
            trigger: { type: 'order.created' },
            steps: [
                { id: 'tag', action: 'add_tag', params: { tag: 'buyer' }, next: 'thanks' },
                { id: 'thanks', action: 'send_message', params: { text: 'Thank you for your order, {name}! We will message you when it ships.' }, next: null },
            ],
        });
        if (workflow) {
            await h.api('POST', '/api/events', { type: 'order.created', data: { phone: '919810000101', amount: 1499 } });
            await h.api('POST', '/api/events', { type: 'order.created', data: { amount: 899 } });
        }
        // A paused one, so every filter chip has something.
        const { workflows = [] } = await h.api('GET', '/api/workflows');
        const draft = workflows.find((w) => w.status === 'draft');
        if (draft) await h.api('PUT', `/api/workflows/${draft.id}`, { status: 'paused' });
    },
    tasks: {
        1: {
            steps: {
                1: { ring: { selector: '#wf-tab-gallery' }, click: true },
                2: { ring: { selector: 'article.recipe' }, click: false },
                3: { ring: { selector: 'article.recipe .install-btn' }, click: true },
                4: {
                    act: async (h) => {
                        await h.type('form.install input[name=name]', 'Appointment reminders - main branch');
                        await h.click({ selector: 'form.install button[role=switch]' });
                    },
                    ring: { selector: 'form.install' },
                    click: false,
                },
                5: { ring: { selector: 'form.install button[type=submit]' }, click: false },
            },
        },
        2: {
            steps: {
                1: { ring: { selector: '#wf-tab-mine' }, click: false },
                2: { ring: { selector: `${DRAFT} .actions button.btn.primary` }, click: false },
                3: { ring: { selector: `${ACTIVE} .actions > button.btn.sm:not(.icon)` }, click: false },
            },
        },
        3: {
            steps: {
                1: { ring: { selector: `${ACTIVE} button[aria-label^="Details and runs"]` }, click: true },
                2: { ring: { selector: 'li.row.open .detail .flow' }, click: false },
                3: { ring: { selector: 'li.row.open .row-text' }, click: false },
            },
        },
        4: {
            steps: {
                1: { ring: { selector: `${ACTIVE} button[aria-label^="Details and runs"]` }, click: true },
                2: { ring: { selector: 'li.row.open .runs' }, click: false },
                3: { ring: { selector: `${FAILED} .run-btn` }, click: true },
                4: { ring: { selector: `${FAILED} .run > button.btn` }, click: false },
            },
        },
        5: {
            steps: {
                1: { act: async (h) => { await h.click({ selector: '.chips button.s-chip:nth-child(2)' }); await fit(h, '#wf-panel > .chips'); }, ring: { selector: '#wf-panel > .chips' }, click: false },
                2: { act: async (h) => { await h.click({ selector: '.chips button.s-chip:first-child' }); await fit(h, '#wf-panel > .chips'); }, ring: { selector: '#wf-panel > .chips' }, click: false },
            },
        },
        6: {
            steps: {
                1: { ring: { selector: `${DRAFT} button[aria-label^="Delete"]` }, click: true },
                2: { ring: { selector: 'li.row .confirm' }, click: false },
            },
        },
    },
};
