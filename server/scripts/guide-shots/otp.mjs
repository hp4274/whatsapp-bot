/** Shot plan for the WhatsApp OTP guide. See ../guide-shots.mjs for the plan shape. */

/** Tag the first visible `sel` whose text contains `text` (or the row holding it) and return a selector for it. */
const tag = (h, sel, text, name, within = null) => h.page.evaluate((sel, text, name, within) => {
    const el = [...document.querySelectorAll(sel)].find((n) => n.checkVisibility() && n.textContent.includes(text));
    const t = el && within ? el.querySelector(within) : el;
    if (t) t.dataset.g = name;
    return `[data-g="${name}"]`;
}, sel, text, name, within);

const sec = (id) => `section[aria-labelledby="${id}"]`;

/** Call the public OTP API as an outside app would. */
const v1 = (h, key, path, body, headers = {}) => fetch(h.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...headers },
    body: JSON.stringify(body),
}).then((r) => r.json()).catch(() => ({}));

export default {
    async setup(h) {
        await h.api('PUT', '/api/otp/settings', { brand: 'Sunrise Boutique' });
        const store = (await h.api('POST', '/api/otp/keys', { name: 'Online store' })).key?.key;
        const app = (await h.api('POST', '/api/otp/keys', { name: 'Mobile app' })).key?.key;
        const server = { 'user-agent': 'node-fetch/3.3' };
        const web = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/130.0', origin: 'https://shop.sunriseboutique.in' };
        const mobile = { 'user-agent': 'okhttp/4.12.0' };
        // Verified, waiting, wrong tries, and one from a web page (so the warning shows).
        const a = await v1(h, store, '/api/v1/otp/send', { phone: '9876500011', purpose: 'login', code: '482913' }, server);
        await v1(h, store, '/api/v1/otp/verify', { id: a.id, code: '482913' }, server);
        const b = await v1(h, store, '/api/v1/otp/send', { phone: '9876500012', purpose: 'checkout', code: '771204' }, server);
        await v1(h, store, '/api/v1/otp/verify', { id: b.id, code: '111111' }, server);
        await v1(h, store, '/api/v1/otp/verify', { id: b.id, code: '771204' }, server);
        await v1(h, app, '/api/v1/otp/send', { phone: '9876500013', purpose: 'signup', code: '305581' }, mobile);
        const c = await v1(h, app, '/api/v1/otp/send', { phone: '9876500014', purpose: 'login', code: '640027' }, mobile);
        await v1(h, app, '/api/v1/otp/verify', { id: c.id, code: '640027' }, mobile);
        const d = await v1(h, store, '/api/v1/otp/send', { phone: '9876500015', purpose: 'login', code: '918274' }, web);
        await v1(h, store, '/api/v1/otp/verify', { id: d.id, code: '000000' }, web);
    },
    tasks: {
        // Get started
        1: { steps: {
            1: { ring: { selector: sec('otp-start') } },
            2: { ring: { selector: `${sec('otp-start')} ol.steps li:nth-child(1)` }, click: false },
            3: { ring: { selector: `${sec('otp-start')} ol.steps li:nth-child(2)` } },
            4: { ring: { selector: '#otp-code' } },
        } },
        // Create an API key
        2: { steps: {
            1: { act: (h) => h.type('#otp-key-name', 'Website login'), ring: { selector: '#otp-key-name' }, click: false },
            2: { ring: { selector: `${sec('otp-keys')} form button[type=submit]` }, click: true },
            3: { ring: { selector: `${sec('otp-keys')} .secret` }, click: false },
        } },
        // Stop a key from working
        3: { steps: {
            1: { act: (h) => tag(h, `${sec('otp-keys')} .rows li`, 'Website login', 'rev', 'button'), ring: { selector: '[data-g="rev"]' }, click: true },
            2: { ring: { selector: 'app-confirm .dialog-actions button:last-child' }, click: true },
        } },
        // Where your API is used
        4: { steps: {
            1: { ring: { selector: sec('otp-where') } },
            2: { ring: { selector: `${sec('otp-where')} .where li:first-child` } },
            3: { act: (h) => tag(h, `${sec('otp-keys')} .rows li`, 'Online store', 'rev2', 'button'), ring: { selector: '[data-g="rev2"]' }, click: false },
        } },
        // Write the code message
        5: { steps: {
            1: { act: (h) => h.type('#otp-brand', 'Sunrise Boutique Store'), ring: { selector: 'form.message .fields' } },
            2: { ring: { selector: '.chips[aria-label="Insert a placeholder"]' }, click: false },
            3: { ring: { selector: 'form.message .row2' }, click: false },
            4: { ring: { selector: 'form.message' }, click: false, after: (h) => h.click({ selector: 'form.message .actions button[type=submit]' }) },
        } },
        // Hand the setup to your developer
        6: { steps: {
            1: { ring: { selector: '#otp-code' } },
            2: { act: (h) => h.click({ selector: '#otp-tab-node' }), ring: { selector: `${sec('otp-code')} .s-seg` }, click: false },
            3: { ring: { selector: '#otp-sample' }, click: false },
            4: { ring: { selector: `${sec('otp-code')} .s-table` } },
        } },
        // Send yourself a test code
        7: {
            // The sent-messages toast sits over the Verify button.
            before: (h) => h.page.addStyleTag({ content: 'app-send-island { display: none !important; }' }),
            steps: {
            1: {
                act: (h) => h.type('#otp-test-phone', '9876543210'),
                ring: { selector: `${sec('otp-test')} form.inline` },
                click: false,
                after: (h) => h.click({ selector: `${sec('otp-test')} form.inline button[type=submit]` }),
            },
            2: {
                act: async (h) => {
                    // The sandbox number "receives" the code: read it back from the sent message.
                    const hist = JSON.stringify(await h.api('GET', '/api/history?recipient=919876543210'));
                    const queue = JSON.stringify(await h.api('GET', '/api/queue')).split('919876543210').slice(1).join(' ');
                    const codes = [...`${hist} ${queue}`.matchAll(/(\d{4,8}) is your/g)].map((m) => m[1]);
                    console.log('otp test code candidates', codes);
                    await h.type('#otp-test-code', codes.at(-1) ?? '123456');
                },
                ring: { selector: `${sec('otp-test')} form.verify` },
                click: false,
                after: (h) => h.click({ selector: `${sec('otp-test')} form.verify button[type=submit]` }),
            },
            3: { act: (h) => h.settle(800), ring: { selector: `${sec('otp-test')} .verify-note` } },
        } },
        // Recent codes
        8: { steps: {
            1: { ring: { selector: `${sec('otp-recent')} table` } },
            2: { ring: { selector: `${sec('otp-recent')} table tbody tr:first-child td:nth-child(2) .s-pill` } },
            3: { ring: { selector: `${sec('otp-recent')} table tbody tr:nth-child(2) td.num` } },
        } },
    },
};
