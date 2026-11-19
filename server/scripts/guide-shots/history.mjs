/** Shot plan for the History guide. See ../guide-shots.mjs for the plan shape. */

const FIRST = ['Rohan', 'Priya', 'Kabir', 'Ananya', 'Vikram', 'Meera', 'Arjun', 'Isha', 'Dev', 'Kavya', 'Nikhil', 'Pooja',
    'Rahul', 'Tara', 'Siddharth', 'Neha', 'Aditya', 'Riya', 'Karan', 'Simran', 'Varun', 'Nisha', 'Yash', 'Aisha'];
const LAST = ['Kapoor', 'Nair', 'Joshi', 'Reddy', 'Gupta', 'Shah', 'Mehta', 'Rao', 'Bose', 'Pillai', 'Desai', 'Malhotra'];
const ERRORS = ['Not on WhatsApp: this number has no WhatsApp account', 'Recipient phone number is invalid',
    'Message expired before it could be delivered'];
const STATUS_CYCLE = ['READ', 'READ', 'DELIVERED', 'READ', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'READ', 'DELIVERED'];

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/**
 * Real send history for the guides that read it (History, Analytics, Campaigns): campaigns sent through the sandbox
 * on earlier days, then given the receipts a real number would get (delivered, read, failed with a reason), button
 * taps, replies and auto-replies. Runs once per process (the campaign name is the marker).
 */
export async function seedActivity(h) {
    if (h.db.prepare("SELECT 1 FROM campaigns WHERE name = 'Weekend sale'").get()) return;
    const { contacts = [] } = await h.api('GET', '/api/contacts?limit=200');
    const people = contacts.filter((c) => c.phone).map((c) => ({ name: c.name, phone: c.phone }));
    for (let i = 0; people.length < 48; i++) {
        people.push({ name: `${FIRST[i % FIRST.length]} ${LAST[(i * 5) % LAST.length]}`, phone: `9198200${String(10000 + i * 37).slice(-5)}` });
    }
    const now = Date.now();
    const day = 86400000;
    const plans = [
        { name: 'New arrivals', daysAgo: 16, size: 30, body: 'Hi {name}, our new summer collection just landed. Drop by this week for first pick!' },
        { name: 'Festive preview', daysAgo: 9, size: 36, body: 'Hi {name}, get an early look at our festive range before it opens to everyone.' },
        {
            name: 'Weekend sale', daysAgo: 2, size: 48, body: 'Hi {name}, flat 25% off everything this weekend only. Tap below to shop.',
            options: { interactive: { type: 'buttons', buttons: [{ id: 'SHOP', title: 'Shop now' }, { id: 'PRICES', title: 'Show prices' }, { id: 'STOP', title: 'Not interested' }] } },
        },
    ];
    for (const p of plans) {
        const audience = people.slice(0, p.size).map((x) => ({ name: x.name, phone: x.phone }));
        const { campaign } = await h.api('POST', '/api/campaigns', { name: p.name, body: p.body, audience, options: p.options ?? {} });
        await h.api('POST', `/api/campaigns/${campaign.id}/start`, {});
        for (let t = 0; t < 40; t++) {
            const left = h.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND status IN ('QUEUED','SENDING')").get(`camp-${campaign.id}`).n;
            if (!left) break;
            await h.settle(500);
        }
        await h.api('GET', `/api/campaigns/${campaign.id}/stats`); // settles it as done
        const start = now - p.daysAgo * day - 3 * 3600000;
        const rows = h.db.prepare('SELECT message_id FROM messages WHERE campaign_id = ? ORDER BY rowid').all(`camp-${campaign.id}`);
        rows.forEach((r, i) => {
            const status = STATUS_CYCLE[(i + p.daysAgo) % STATUS_CYCLE.length];
            const sent = start + i * 20000;
            const updated = sent + (status === 'READ' ? 50 * 60000 : status === 'DELIVERED' ? 4000 : 1500);
            h.db.prepare(`UPDATE messages SET status = ?, error = ?, attempt = ?, created_at = ?, updated_at = ?, sent_at = ?
                          WHERE message_id = ?`).run(status, status === 'FAILED' ? ERRORS[i % ERRORS.length] : null,
                status === 'FAILED' ? 3 : 1, iso(sent - 60000), iso(updated), status === 'FAILED' ? null : iso(sent), r.message_id);
        });
        h.db.prepare('UPDATE campaigns SET created_at = ?, started_at = ?, finished_at = ?, updated_at = ? WHERE id = ?')
            .run(iso(start - 3600000), iso(start), iso(start + rows.length * 20000), iso(start + rows.length * 20000), campaign.id);
        await h.api('GET', `/api/campaigns/${campaign.id}/stats`); // refresh the cached counts
        if (p.options?.interactive) {
            const picks = [['SHOP', 'Shop now'], ['SHOP', 'Shop now'], ['PRICES', 'Show prices'], ['SHOP', 'Shop now'], ['STOP', 'Not interested']];
            people.slice(0, 18).forEach((x, i) => {
                const [id, title] = picks[i % picks.length];
                h.db.prepare(`INSERT INTO button_clicks (tenant_id, channel_id, campaign_id, recipient, option_id, option_title,
                              inbound_message_id, at) VALUES (1, 1, ?, ?, ?, ?, ?, ?)`)
                    .run(`camp-${campaign.id}`, x.phone, id, title, `clk-${campaign.id}-${i}`, iso(start + 3600000 + i * 60000));
            });
        }
    }
    // Earlier months' sends, so the monthly usage chart has a past (oldest rows, at the end of History).
    const insertOld = h.db.prepare(`INSERT INTO messages (tenant_id, channel_id, message_id, message_type, recipient, message,
                                    status, attempt, name, created_at, updated_at, sent_at) VALUES (1, 1, ?, 'campaign', ?, ?, 'READ', 1, ?, ?, ?, ?)`);
    [140, 210, 175, 260, 230].forEach((n, m) => {
        const base = new Date(now);
        base.setUTCMonth(base.getUTCMonth() - (5 - m), 4);
        for (let i = 0; i < n; i++) {
            const x = people[i % people.length];
            const at = iso(base.getTime() + (i % 20) * day + i * 61000);
            insertOld.run(`old-${m}-${i}`, x.phone, `Hi ${x.name}, thanks for shopping with Sunrise Boutique!`, x.name, at, at, at);
        }
    });
    // Inbound messages over the month, most answered by an auto-reply rule or a person at varying speed.
    const rules = ['Price enquiry', 'Opening hours', null, 'Store location', null, 'Order status', 'Price enquiry', null];
    const waits = [20, 45, 90, 200, 600, 1500, 4000, 9000, 30000, null];
    const insertIn = h.db.prepare(`INSERT INTO inbound_messages (tenant_id, channel_id, message_id, sender, sender_name, body,
                                   replied_rule, is_read, received_at) VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?)`);
    const insertOut = h.db.prepare(`INSERT INTO messages (tenant_id, channel_id, message_id, message_type, recipient, message,
                                    status, attempt, name, created_at, updated_at, sent_at) VALUES (1, 1, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`);
    for (let i = 0; i < 34; i++) {
        const x = people[(i * 7) % people.length];
        const at = now - ((i * 0.83) % 27) * day - (i % 9) * 3600000 - 600000;
        const rule = rules[i % rules.length];
        insertIn.run(`in-${i}`, x.phone, x.name, ['What is the price?', 'Are you open today?', 'Where is the shop?', 'Where is my order?', 'Hi, I need help'][i % 5],
            rule, i < 30 ? 1 : 0, iso(at));
        const wait = rule ? 3 + (i % 4) : waits[(i * 3) % waits.length];
        if (wait === null) continue;
        insertOut.run(`out-${i}`, rule ? 'auto_reply' : 'transactional', x.phone,
            rule ? `Thanks for writing to Sunrise Boutique! (${rule})` : 'Hi! Happy to help - let me check that for you.',
            i % 3 ? 'READ' : 'DELIVERED', x.name, iso(at + wait * 1000), iso(at + wait * 1000 + 30000), iso(at + wait * 1000));
    }
}

const statusSelect = { selector: 'select[aria-label="Filter by status"]' };
const pickStatus = (value) => async (h) => {
    await h.page.select('select[aria-label="Filter by status"]', value);
    await h.settle(900);
};

export default {
    setup: seedActivity,
    tasks: {
        1: {
            steps: {
                1: { act: (h) => h.goto('/home'), ring: { selector: 'a[href="/history"]' }, click: true },
                2: {
                    act: async (h) => {
                        await h.type('input[aria-label^="Filter by recipient"]', '919820010037');
                        await h.page.keyboard.press('Enter');
                        await h.settle(900);
                    },
                    ring: { selector: 'input[aria-label^="Filter by recipient"]' },
                },
                3: { act: (h) => h.goto('/history'), ring: { selector: 'table td.st' } },
                4: { ring: { selector: 'table td.when' } },
            },
        },
        2: {
            steps: {
                1: { act: pickStatus('FAILED'), ring: statusSelect, click: false },
                2: { ring: { selector: 'table td.error' } },
                3: { ring: { selector: 'table td.num' } },
            },
        },
        3: {
            steps: {
                1: { act: pickStatus('DELIVERED'), ring: statusSelect, click: false },
                2: { act: pickStatus('ALL'), ring: { selector: '.filters .counts' } },
                3: {
                    act: async (h) => {
                        await h.type('input[aria-label^="Filter by recipient"]', '910000000000');
                        await h.page.keyboard.press('Enter');
                        await h.settle(900);
                    },
                    ring: 'Clear filters',
                    click: false,
                },
            },
        },
        4: {
            steps: {
                1: { ring: { selector: '.s-head button' }, click: false },
                2: { act: (h) => h.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)), ring: { selector: 'app-pager .btns' } },
            },
        },
    },
};
