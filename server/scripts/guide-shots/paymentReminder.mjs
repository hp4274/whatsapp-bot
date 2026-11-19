/** Shot plan for the Payment Reminder guide (/payment-reminder). See ../guide-shots.mjs for the plan shape. */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import XLSX from 'xlsx';

const SHEET = path.join(os.tmpdir(), `guide-dues-${process.pid}.xlsx`);
const IMPORT = 'section[aria-labelledby=pr-import]';
const MESSAGE = 'Hi {name}, INR {amount} for invoice {invoice} was due on {due_date}. Tap to pay by UPI: {upi_link} - Sunrise Boutique';

/** A sheet with real-looking rows plus one bad row and one repeat, so the counts and issues show. */
function writeSheet() {
    const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
    const rows = [
        { name: 'Aarav Sharma', phone: '9810000101', remaining: 4500, due_date: day(5), invoice: 'INV-2026-1101' },
        { name: 'Priya Nair', phone: '9810000102', remaining: 1250, due_date: day(2), invoice: 'INV-2026-1102' },
        { name: 'Sneha Iyer', phone: '9810000104', remaining: 8900, due_date: day(-3), invoice: 'INV-2026-1103' },
        { name: 'Ananya Gupta', phone: '9810000106', remaining: 650, due_date: day(9), invoice: 'INV-2026-1104' },
        { name: 'Karthik Reddy', phone: '9810000107', remaining: 15200, due_date: day(-8), invoice: 'INV-2026-1105' },
        { name: 'Arjun Patel', phone: '', remaining: 2100, due_date: day(4), invoice: 'INV-2026-1106' },
        { name: 'Priya Nair', phone: '9810000102', remaining: 1250, due_date: day(2), invoice: 'INV-2026-1102' },
    ];
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Dues');
    fs.writeFileSync(SHEET, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }));
}

/** Pick the sheet in the Import Excel file box, as the file dialog would. */
const upload = async (h) => {
    const input = await h.page.$('#payment-file');
    await input?.uploadFile(SHEET);
    await h.settle(1800);
};
/** Type into a field the way the user would (the page listens to input events). */
const set = (h, selector, value) => h.page.evaluate((sel, v) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
}, selector, value).then(() => h.settle(300));
/** Shrink a full-width line to its text, so the ring hugs it and the shot stays 1:1. */
const fit = (h, selector) => h.page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.style.width = 'fit-content'; }, selector);
const fieldOf = (id) => ({ selector: `.s-field:has(#${id})` });
const filter = (label) => async (h) => {
    await h.page.evaluate((l) => [...document.querySelectorAll('.tools .s-seg button')].find((b) => b.textContent.trim() === l)?.click(), label);
    await h.settle(500);
};
const search = (h, text) => set(h, '.tools .search input', text);
/** Turn automatic reminders on, so their fields are live (shots after step 1 of that task). */
const autoOn = (h) => h.page.evaluate(() => {
    const sw = document.querySelector('section[aria-labelledby=pr-auto] .card-top ar-switch button');
    if (sw?.getAttribute('aria-checked') !== 'true') sw?.click();
}).then(() => h.settle(300));

export default {
    async setup(h) {
        writeSheet();
        // The seeded dues carry no customer: give them one, a few reminders sent, and one customer who replied PAID.
        const people = [['Rohan Mehta', '919810000103'], ['Vikram Singh', '919810000105'], ['Meera Joshi', '919810000108'],
            ['Divya Menon', '919810000110'], ['Arjun Patel', '919810000109'], ['Siddharth Rao', '919810000111']];
        const { dues = [] } = await h.api('GET', '/api/payment-reminders/dues');
        const claimed = dues.filter((d) => d.status === 'pending' || d.status === 'overdue')[1];
        for (const [i, due] of dues.entries()) {
            const [name, phone] = people[i % people.length];
            const metadata = { ...due.metadata, name, phone, reminders: [1, 0, 3, 2, 1, 4][i % 6] };
            if (due === claimed) Object.assign(metadata, { payment: 'claimed', claimedAt: new Date().toISOString() });
            await h.api('PUT', `/api/objects/payment/${due.id}`, { metadata });
        }
    },
    tasks: {
        1: {
            steps: {
                1: { act: (h) => fit(h, `${IMPORT} #pr-import`), ring: { selector: `${IMPORT} #pr-import` }, click: false },
                2: { ring: { selector: `${IMPORT} label[for=payment-file]` }, click: false, after: upload },
                3: { act: (h) => fit(h, `${IMPORT} .help span:first-child`), ring: { selector: `${IMPORT} .help span:first-child` }, click: false },
                4: { act: (h) => fit(h, `${IMPORT} .help span:last-child`), ring: { selector: `${IMPORT} .help span:last-child` }, click: false },
                5: { ring: { selector: `${IMPORT} details.import-errors` }, click: false },
            },
        },
        2: {
            steps: {
                1: { ring: { selector: `${IMPORT} label[for=payment-file]` }, click: false, after: upload },
                2: { ring: { selector: '.preview.first' }, click: false },
                3: { ring: { selector: `${IMPORT} .plan` }, click: false },
                4: { ring: { selector: `${IMPORT} .controls button.primary` }, click: false },
            },
        },
        3: {
            steps: {
                1: { act: (h) => set(h, '#pr-template', MESSAGE), ring: fieldOf('pr-template'), click: false },
                2: { ring: { selector: '.s-field:has(#pr-template) .hint' }, click: false },
                3: { ring: { selector: '.form .preview' }, click: false },
                4: { ring: { selector: '.save-bar button.primary' }, click: false },
            },
        },
        4: {
            steps: {
                1: { act: (h) => set(h, '#pr-upi', 'sunriseboutique@okaxis'), ring: fieldOf('pr-upi'), click: false },
                2: { act: (h) => set(h, '#pr-payee', 'Sunrise Boutique'), ring: fieldOf('pr-payee'), click: false },
                3: { act: (h) => set(h, '#pr-template', MESSAGE), ring: fieldOf('pr-template'), click: false },
                4: { ring: { selector: '.save-bar button.primary' }, click: false },
            },
        },
        5: {
            steps: {
                1: { ring: { selector: 'section[aria-labelledby=pr-auto] .card-top ar-switch' }, click: false, after: autoOn },
                2: { act: (h) => set(h, '#pr-before', '2'), ring: fieldOf('pr-before'), click: false },
                3: { ring: { selector: 'section[aria-labelledby=pr-auto] .auto .s-field:nth-child(2)' }, click: false },
                4: {
                    act: async (h) => { await set(h, '#pr-every', '3'); await set(h, '#pr-max', '4'); },
                    ring: { selector: 'section[aria-labelledby=pr-auto] .auto' },
                    click: false,
                },
                5: { ring: { selector: '.save-bar button.primary' }, click: false },
            },
        },
        6: {
            steps: {
                1: { act: (h) => search(h, 'Mehta'), ring: { selector: '.tools .search' }, click: false },
                2: {
                    act: async (h) => { await search(h, ''); await filter('Overdue')(h); },
                    ring: { selector: '.tools .s-seg' },
                    click: false,
                },
                3: { act: filter('All'), ring: { selector: '.s-table thead th:nth-child(6)' }, click: false },
            },
        },
        7: {
            steps: {
                1: { act: (h) => search(h, 'Rohan'), ring: { selector: '.s-table tbody tr:first-child' }, click: false },
                2: { ring: { selector: '.s-table tbody tr:first-child td.actions button' }, click: false },
                3: {
                    act: async (h) => { await search(h, ''); await filter('Says paid')(h); },
                    ring: { selector: '.s-table tbody tr:first-child button[aria-label^="Not received"]' },
                    click: false,
                },
            },
        },
    },
};
