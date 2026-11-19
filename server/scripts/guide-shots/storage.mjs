/** Shot plan for the Storage guide. See ../guide-shots.mjs for the plan shape. */

/** Upload a contact list the way the campaign wizard does, so Storage has sheets beside the seeded attachments. */
async function uploadSheet(h, name, rows) {
    const token = await h.page.evaluate(() => localStorage.getItem('wsender.token'));
    const csv = ['phone,name,city', ...rows].join('\n');
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), name);
    form.append('countryCode', '91');
    const res = await fetch(`${h.base}/api/campaign/import/preview`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    if (!res.ok) console.warn('storage upload', name, res.status, (await res.text()).slice(0, 200));
}

const loaded = async (h) => { await h.page.waitForSelector('.summary', { timeout: 8000 }).catch(() => {}); await h.settle(600); };
const setSearch = (h, value) => h.page.evaluate((v) => {
    const input = document.querySelector('input[aria-label="Search files"]');
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}, value);

export default {
    async setup(h) {
        await uploadSheet(h, 'diwali-customers.csv', ['9876543210,Riya Shah,Surat', '9876500011,Amit Patel,Pune', '9898012345,Neha Joshi,Mumbai']);
        await uploadSheet(h, 'vip-list-november.csv', ['9812345678,Kabir Rao,Delhi', '9822334455,Sara Khan,Jaipur']);
    },
    tasks: {
        1: {
            before: loaded,
            steps: {
                1: { ring: { selector: 'a[href="/storage"]' }, click: false },
                2: { ring: { selector: '.summary .figures' } },
                3: { ring: { selector: '.summary .mix' } },
            },
        },
        2: {
            before: loaded,
            steps: {
                1: { ring: { selector: '.chips' }, click: false },
                2: {
                    act: async (h) => { await setSearch(h, 'customers'); await h.settle(400); },
                    ring: { selector: 'label.search' },
                    after: async (h) => { await setSearch(h, ''); await h.settle(400); },
                },
                3: { ring: { selector: '.pager-btns' }, click: false },
            },
        },
        3: {
            before: async (h) => { await loaded(h); await h.click({ selector: '.chips button:nth-child(2)' }); },
            steps: {
                1: { ring: { selector: 'article.file:has(button[aria-label^="Use "])' }, click: false },
                2: { ring: { selector: 'button[aria-label^="Use "]' }, click: true, after: async (h) => { await h.settle(1500); } },
                3: { act: async (h) => { await h.page.waitForSelector('.drop.has', { timeout: 8000 }).catch(() => {}); await h.settle(500); }, ring: { selector: '.drop.has' } },
            },
        },
        4: { before: loaded, steps: { 1: { ring: { selector: 'button[aria-label^="Download "]' }, click: false } } },
        5: {
            before: loaded,
            steps: {
                1: { ring: { selector: 'button[aria-label^="Delete "]' }, click: true },
                2: { ring: { selector: 'button[aria-label^="Confirm delete"]' }, click: false },
            },
        },
        6: { before: loaded, steps: { 1: { ring: { selector: 'button[aria-label="Refresh storage"]' }, click: false } } },
    },
};
