/** Shot plan for the Subscriptions guide (/records/subscription). See ../guide-shots.mjs for the plan shape. */

const D = 'aside.drawer';
const REF = 'demo-subscription-1'; // the one the edit/activity/delete tasks open: setup gives it a few edits for its Activity

/**
 * Name every drawer field by its label (data-g="Plan"), and set the ones in `values` the way typing would so
 * ngModel sees them. The inputs carry no name attribute (ngModel takes [name]), so the label is the handle.
 */
const fill = (h, values = {}) => h.page.evaluate((drawer, vals) => {
    for (const field of document.querySelectorAll(`${drawer} label.field`)) {
        const label = (field.querySelector('.lbl')?.textContent ?? '').replace('*', '').trim();
        field.dataset.g = label;
        if (!(label in vals)) continue;
        const el = field.querySelector('input, select, textarea');
        if (el.type === 'checkbox') { if (el.checked !== vals[label]) el.click(); continue; }
        const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, vals[label]);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }
}, D, values).then(() => h.settle(300));
const field = (label) => ({ selector: `${D} label.field[data-g="${label}"]` });
const row = { selector: `tbody tr[aria-label$=" ${REF}"]` };
const openRow = async (h) => { await h.click(row); await h.settle(900); };
const ahead = (days) => `${new Date(Date.now() + days * 86400000).toISOString().slice(0, 10)}T10:00`;

export default {
    async setup(h) {
        const { objects = [] } = await h.api('GET', '/api/objects/subscription?limit=50');
        const sub = objects.find((o) => o.reference === REF);
        if (!sub) return;
        await h.api('PUT', `/api/objects/subscription/${sub.id}`, { data: { amount: 1199 } });
        await h.api('PUT', `/api/objects/subscription/${sub.id}`, { status: 'past_due' });
        await h.api('PUT', `/api/objects/subscription/${sub.id}`, { status: 'active', data: { expiresAt: new Date(Date.now() + 40 * 86400000).toISOString() } });
    },
    tasks: {
        1: {
            steps: {
                1: { ring: { selector: 'section.rec .s-head button.btn.primary' }, click: true },
                2: {
                    act: async (h) => { await h.type(`${D} .field.customer input`, 'Priya'); await h.settle(900); },
                    ring: { selector: `${D} .field.customer` },
                    click: false,
                    after: async (h) => { await h.click({ selector: `${D} #cust-results li button` }); },
                },
                3: {
                    act: (h) => fill(h, { Plan: 'Gold - Monthly', 'Expires at': ahead(30), Amount: '999', Currency: 'INR', 'Starts at': ahead(0) }),
                    ring: field('Plan'),
                    click: false,
                },
                4: { act: (h) => fill(h), ring: field('Auto renew'), click: true },
                5: {
                    act: (h) => fill(h, { Status: 'active' }),
                    ring: { selector: `${D} button[type=submit]` },
                    click: false,
                },
            },
        },
        2: {
            steps: {
                1: { ring: row, click: true },
                2: {
                    act: (h) => fill(h, { 'Expires at': ahead(70) }),
                    ring: field('Expires at'),
                    click: false,
                },
                3: { act: (h) => fill(h), ring: field('Status'), click: false },
                4: { ring: { selector: `${D} button[type=submit]` }, click: false },
            },
        },
        3: {
            steps: {
                1: { ring: row, click: true },
                2: { ring: { selector: `${D} #rec-activity` }, click: false },
                3: { ring: { selector: `${D} section.timeline ol` }, click: false },
            },
        },
        4: {
            steps: {
                1: {
                    act: async (h) => { await h.click({ selector: '.chips button.s-chip:nth-child(3)' }); },
                    ring: { selector: '.toolbar .chips' },
                    click: false,
                },
                2: {
                    act: async (h) => {
                        await h.click({ selector: '.chips button.s-chip:first-child' });
                        await h.type('.toolbar .search input', 'Gold');
                    },
                    ring: { selector: '.toolbar label.search' },
                    click: false,
                },
                3: {
                    act: async (h) => { await h.type('.toolbar .search input', 'Platinum weekly'); },
                    ring: { selector: '.card.tbl .s-empty button' },
                    click: false,
                },
            },
        },
        5: {
            steps: {
                1: { act: openRow, ring: { selector: `${D} button.danger-ghost` }, click: true },
                2: { ring: { selector: `${D} .confirm` }, click: false },
            },
        },
    },
};
