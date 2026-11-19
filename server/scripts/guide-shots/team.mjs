/** Shot plan for the Team guide. See ../guide-shots.mjs for the plan shape. */

const loaded = async (h) => { await h.page.waitForSelector('.people table', { timeout: 8000 }).catch(() => {}); await h.settle(500); };
/** Tag `inner` inside the People row that mentions `who`, so a step can ring it as [data-g]. */
const pick = (h, who, inner) => h.page.evaluate((w, sel) => {
    document.querySelectorAll('[data-g]').forEach((n) => delete n.dataset.g);
    const row = [...document.querySelectorAll('.people tbody tr')].find((tr) => tr.textContent.includes(w));
    const el = row && (sel ? row.querySelector(sel) : row);
    if (el) el.dataset.g = '';
}, who, inner);
const G = { selector: '[data-g]' };

export default {
    async setup(h) {
        const add = (name, email, role) => h.api('POST', '/api/users', { name, email, role, password: 'Sunrise#2026' });
        await add('Ravi Shah', 'ravi@sunriseboutique.in', 'admin');
        await add('Priya Nair', 'priya@sunriseboutique.in', 'agent');
        const karan = await add('Karan Mehta', 'karan@sunriseboutique.in', 'agent');
        if (karan?.user?.id) await h.api('PATCH', `/api/users/${karan.user.id}`, { disabled: true });
    },
    tasks: {
        1: {
            before: loaded,
            steps: {
                1: { ring: { selector: 'form.invite' } },
                2: {
                    act: async (h) => {
                        await h.type('#u-name', 'Meera Desai');
                        await h.type('#u-email', 'meera@sunriseboutique.in');
                        await h.type('#u-pass', 'Welcome#2026');
                    },
                    ring: { selector: 'form.invite' },
                },
                3: { act: async (h) => { await h.page.select('#u-role', 'agent'); }, ring: { selector: '#u-role' }, click: false },
                4: { ring: { selector: 'form.invite button[type=submit]' }, click: false },
            },
        },
        2: {
            before: loaded,
            steps: {
                1: { ring: { selector: '.people .s-table' } },
                2: { ring: { selector: '#u-role' }, click: false },
                3: { act: (h) => pick(h, 'Priya Nair', '.row-acts'), ring: G, click: false },
            },
        },
        3: {
            before: loaded,
            steps: {
                1: { ring: { selector: 'button[aria-label="Change email or password for Priya Nair"]' }, click: true },
                2: { act: async (h) => { await h.type('#e-pass', 'NewPass#2026'); }, ring: { selector: '.dialog .fields' }, click: false },
                3: { ring: { selector: '.dialog button[type=submit]' }, click: false },
            },
        },
        4: {
            before: loaded,
            steps: {
                1: { act: (h) => pick(h, 'Priya Nair', 'button[title^="They can"]'), ring: G, click: false },
                2: { act: (h) => pick(h, 'Karan Mehta', 'button'), ring: G, click: false },
            },
        },
        5: {
            before: loaded,
            steps: {
                1: { ring: { selector: 'button[aria-label="Remove Priya Nair"]' }, click: true },
                2: { ring: { selector: 'app-confirm .dialog-actions button:last-child' }, click: true, after: async (h) => { await h.settle(800); } },
                3: { ring: { selector: '.people .s-table' } },
            },
        },
    },
};
