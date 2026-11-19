/** Shot plan for the Leads guide. See ../guide-shots.mjs for the plan shape; helpers live in ./orders.mjs. */

import { fill, localAt, markFields, openRow, pickCustomer, pickFirstCustomer, recField } from './orders.mjs';

const LEAD1 = '.rec tbody tr[aria-label="Open Lead demo-lead-1"]';

export default {
    tasks: {
        // Make a lead from every new person who messages
        1: {
            steps: {
                1: { ring: { selector: 'a[href="/records/lead"]' }, click: false },
                2: { ring: { selector: '.rec section.capture ar-switch' }, click: true },
                3: { act: (h) => h.settle(800), ring: { selector: '.rec section.capture' }, click: false },
            },
        },
        // Add a lead by hand
        2: {
            steps: {
                1: { ring: { selector: '.rec .s-head button.primary' }, click: true },
                2: {
                    act: (h) => pickCustomer(h, 'Vikram'),
                    ring: { selector: '.drawer .field.customer' }, click: false,
                    after: pickFirstCustomer,
                },
                3: {
                    act: async (h) => {
                        await fill(h, 'Name', 'Vikram Singh');
                        await fill(h, 'Phone', '919810000105');
                        await fill(h, 'Source', 'Instagram');
                        await fill(h, 'Interest', 'Bulk kurtas for a wedding');
                        await fill(h, 'Value', 45000);
                        await fill(h, 'Assigned to', 'Fatima');
                        await fill(h, 'Follow up at', localAt(1, 11));
                    },
                    ring: recField('Interest'), click: false,
                },
                4: { act: markFields, ring: recField('Status'), click: false },
                5: { ring: { selector: '.drawer .actions button[type=submit]' }, click: true },
            },
        },
        // Move a lead along
        3: {
            steps: {
                1: { ring: { selector: LEAD1 }, click: true },
                2: { act: (h) => fill(h, 'Status', 'contacted'), ring: recField('Status'), click: false },
                3: {
                    act: async (h) => {
                        await fill(h, 'Follow up at', localAt(3, 16));
                        await fill(h, 'Notes', 'Wants a price list for 200 pieces. Call back Friday.');
                    },
                    ring: recField('Follow up at'), click: false,
                },
                4: { ring: { selector: '.drawer .actions button[type=submit]' }, click: true },
            },
        },
        // See what happened to a lead
        4: {
            steps: {
                1: { ring: { selector: LEAD1 }, click: true },
                2: { act: (h) => h.settle(800), ring: { selector: '.drawer section.timeline' }, click: false },
                3: { ring: { selector: '.drawer .timeline ol' }, click: false },
            },
        },
        // Find a lead
        5: {
            steps: {
                1: {
                    act: (h) => h.page.evaluate(() => [...document.querySelectorAll('.rec .chips .s-chip')].find((b) => b.textContent.includes('Contacted'))?.click()),
                    ring: { selector: '.rec .toolbar .chips' }, click: false,
                },
                2: {
                    act: async (h) => {
                        await h.page.evaluate(() => document.querySelector('.rec .chips .s-chip')?.click());
                        await h.type('.rec .toolbar .search input', 'wholesale');
                    },
                    ring: { selector: '.rec .toolbar .search' }, click: false,
                },
                3: {
                    act: (h) => h.type('.rec .toolbar .search input', 'franchise in Goa'),
                    ring: { selector: '.rec .tbl .s-empty button' }, click: true,
                },
            },
        },
        // Delete a lead
        6: {
            before: (h) => openRow(h, 'Open Lead demo-lead-5'),
            steps: {
                1: { ring: { selector: '.drawer .actions .danger-ghost' }, click: true },
                2: { act: (h) => h.page.mouse.move(5, 5), ring: { selector: '.drawer .actions .confirm' }, click: false },
            },
        },
    },
};
