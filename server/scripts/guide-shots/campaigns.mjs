/** Shot plan for the Campaigns guide. See ../guide-shots.mjs for the plan shape. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { seedActivity } from './history.mjs';

const sel = (selector) => ({ selector });
/** The list link to a campaign setup made (its id is known only once setup ran). */
const link = (name) => ({ get selector() { return `td.name a[href="/campaigns/${ids[name]}"]`; } });
/** Ids of the campaigns setup made, by name. */
const ids = {};
let csvFile = '';
let tag = { any: '', not: '' };

/** A sheet the way a shop keeps one: numbers without the country code, two rows that are not numbers. */
function writeCsv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guide-shots-campaigns-'));
    const names = ['Rohan Kapoor', 'Priya Nair', 'Kabir Joshi', 'Ananya Reddy', 'Vikram Gupta', 'Meera Shah', 'Arjun Mehta',
        'Isha Rao', 'Dev Bose', 'Kavya Pillai', 'Nikhil Desai', 'Pooja Malhotra', 'Rahul Kapoor', 'Tara Nair', 'Neha Joshi',
        'Aditya Reddy', 'Riya Gupta', 'Karan Shah', 'Simran Mehta', 'Varun Rao', 'Nisha Bose', 'Yash Pillai'];
    const rows = names.map((n, i) => [n, `98${String(30000000 + i * 4711).slice(0, 8)}`, ['Pune', 'Mumbai', 'Delhi'][i % 3]]);
    rows.splice(6, 0, ['Sanjay Iyer', '12345', 'Pune']);
    rows.splice(15, 0, ['Lata Menon', 'call me', 'Delhi']);
    csvFile = path.join(dir, 'festive-customers.csv');
    fs.writeFileSync(csvFile, ['Name,Phone,City', ...rows.map((r) => r.join(','))].join('\n'));
}

/** A fresh composer: no "Continue where you left off?" from an earlier task. */
async function fresh(h, url = '/campaign') {
    await h.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('wsender.campaignDraft')).forEach((k) => localStorage.removeItem(k)));
    await h.goto(url);
}
const source = (n) => (h) => h.click(sel(`.sources button:nth-of-type(${n})`));
async function vipSegment(h) {
    await source(2)(h);
    await h.settle(800);
    await h.page.select('#seg', String(ids.segment));
    await h.settle(800);
}
async function uploadSheet(h) {
    await source(1)(h);
    const input = await h.page.$('#aud-file');
    await input?.uploadFile(csvFile);
    await h.settle(3000);
}
const next = (h) => h.click(sel('.main > .foot .btn.primary'));
async function writeMessage(h) {
    await fill(h, '#msg', 'Hi , our festive collection is here! Show this message in store for 15% off this week.');
    await h.page.$eval('#msg', (n) => { n.focus(); n.setSelectionRange(3, 3); });
    await h.click(sel('.chips[aria-label="Insert a variable"] .vchip'));
    await h.page.evaluate(() => document.activeElement?.blur());
    await h.settle(500);
}
/** Open a <details> by its summary text. */
const openDetails = (text) => (h) => h.page.evaluate((t) => {
    for (const s of document.querySelectorAll('summary')) if (s.textContent.includes(t) && s.checkVisibility()) s.parentElement.open = true;
}, text).then(() => h.settle(500));
const fill = async (h, selector, text) => {
    await h.page.$eval(selector, (n) => { n.focus(); n.select?.(); });
    await h.page.keyboard.press('Backspace');
    await h.page.type(selector, text);
    await h.page.evaluate(() => document.activeElement?.blur());
    await h.settle(400);
};

export default {
    async setup(h) {
        await seedActivity(h);
        writeCsv();
        const { campaigns } = await h.api('GET', '/api/campaigns');
        for (const c of campaigns) ids[c.name] ??= c.id;
        const { contacts = [], tags = [] } = await h.api('GET', '/api/contacts?limit=200');
        // The commonest tag to send to, and a tag that leaves some of those people out.
        const tagsOf = (c) => (c.tags ?? []).map((t) => (typeof t === 'string' ? t : t.tag ?? t.name));
        const count = (fn) => contacts.filter(fn).length;
        const names = [...new Set(contacts.flatMap(tagsOf))].sort((a, b) => count((c) => tagsOf(c).includes(b)) - count((c) => tagsOf(c).includes(a)));
        tag = { any: names[0] ?? 'vip', not: 'cold' };
        for (const n of names) {
            const left = count((c) => tagsOf(c).includes(tag.any) && !tagsOf(c).includes(n));
            if (n !== tag.any && left > 0 && left < count((c) => tagsOf(c).includes(tag.any))) { tag.not = n; break; }
        }
        ids.segment = h.db.prepare("SELECT id FROM segments WHERE name = 'VIP customers'").get()?.id ?? 1;
        if (ids['Monsoon clearance']) return;
        // Scheduled for tomorrow.
        const tomorrow = new Date(Date.now() + 86400000);
        tomorrow.setUTCHours(5, 30, 0, 0);
        await h.api('POST', '/api/campaigns', {
            name: 'Christmas preview', status: 'scheduled', scheduledAt: tomorrow.toISOString(), segmentId: ids.segment,
            body: 'Hi {name}, a first look at our Christmas range opens tomorrow at 11 am.',
        });
        // A run that is still sending: started, then half of it put back in the queue.
        const audience = contacts.filter((c) => c.phone).slice(0, 30).map((c) => ({ name: c.name, phone: c.phone }));
        const { campaign: monsoon } = await h.api('POST', '/api/campaigns', { name: 'Monsoon clearance', body: 'Hi {name}, monsoon clearance: up to 40% off rainwear!', audience });
        await h.api('POST', `/api/campaigns/${monsoon.id}/start`, {});
        await h.settle(3000);
        h.db.prepare(`UPDATE messages SET status = CASE WHEN rowid % 3 = 0 THEN 'READ' WHEN rowid % 3 = 1 THEN 'DELIVERED' ELSE 'QUEUED' END,
                      sent_at = CASE WHEN rowid % 3 = 2 THEN NULL ELSE sent_at END WHERE campaign_id = ?`).run(`camp-${monsoon.id}`);
        h.db.prepare("UPDATE campaigns SET status = 'running', finished_at = NULL WHERE id = ?").run(monsoon.id);
        // Festive preview repeats every week; its next run is booked.
        const festive = ids['Festive preview'];
        const nextRun = new Date(Date.now() + 5 * 86400000);
        nextRun.setUTCHours(5, 30, 0, 0);
        const { campaign: following } = await h.api('POST', '/api/campaigns', {
            name: 'Festive preview', status: 'scheduled', scheduledAt: nextRun.toISOString(), segmentId: ids.segment,
            body: 'Hi {name}, get an early look at our festive range before it opens to everyone.',
        });
        h.db.prepare(`UPDATE campaigns SET options = json_set(options, '$.recurrence', json('{"every":"week"}'), '$.nextId', ?) WHERE id = ?`).run(following.id, festive);
        h.db.prepare(`UPDATE campaigns SET options = json_set(options, '$.recurrence', json('{"every":"week"}'), '$.previousId', ?) WHERE id = ?`).run(festive, following.id);
        ids.festiveNext = following.id;
        const list = (await h.api('GET', '/api/campaigns')).campaigns;
        for (const c of list) ids[c.name] ??= c.id;
    },
    tasks: {
        1: {
            path: '/campaigns',
            before: (h) => h.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('wsender.campaignDraft')).forEach((k) => localStorage.removeItem(k))),
            steps: {
                1: { ring: sel('main a.btn.primary[href="/campaign"]'), click: true, after: (h) => h.settle(800) },
                2: { ring: sel('.sources'), click: false, after: async (h) => { await vipSegment(h); await next(h); } },
                3: { act: writeMessage, ring: sel('.chips[aria-label="Insert a variable"]'), click: false, after: next },
                4: { ring: sel('[role=radiogroup][aria-label="When to send"]'), click: false },
                5: { ring: sel('section.card.panel:has(#rv-name)'), click: false },
            },
        },
        2: {
            path: '/campaign',
            before: async (h) => { await fresh(h); await source(1)(h); },
            steps: {
                1: { ring: sel('label.drop[for="aud-file"]'), click: false, after: uploadSheet },
                2: { ring: sel('.colmap') },
                3: { ring: sel('.map .field') },
                4: {
                    act: async (h) => {
                        await openDetails('More options')(h);
                        await fill(h, '#col-name', 'Offer code');
                        await fill(h, '#col-value', 'FEST15');
                    },
                    ring: sel('.add-col'),
                    click: false,
                },
                5: { act: openDetails('See skipped rows'), ring: sel('details.more:has([aria-label="Rows with problems"])'), click: false },
            },
        },
        3: {
            path: '/campaign',
            before: (h) => fresh(h),
            steps: {
                1: { ring: sel('.sources button:nth-of-type(2)'), click: true, after: (h) => h.settle(800) },
                2: { ring: sel('.field:has(#seg)'), click: false },
                3: { act: (h) => fill(h, '#tag-any', tag.any), ring: sel('.tag-rows .field:has(#tag-any)') },
                4: { act: (h) => fill(h, '#tag-not', tag.not), ring: sel('.tag-rows .field:has(#tag-not)') },
                5: { act: (h) => h.settle(800), ring: sel('.summary') },
            },
        },
        4: {
            path: '/campaign',
            before: async (h) => { await fresh(h); await vipSegment(h); await next(h); },
            steps: {
                1: {
                    ring: sel('.tpl-row'),
                    click: false,
                    after: async (h) => {
                        await h.page.evaluate(() => {
                            const s = document.querySelector('#saved-tpl');
                            const o = [...s.options].find((x) => x.textContent.trim() === 'welcome_message');
                            if (o) { s.value = o.value; s.dispatchEvent(new Event('change', { bubbles: true })); }
                        });
                        await h.settle(600);
                    },
                },
                2: { ring: sel('.chips[aria-label="Insert a variable"]'), click: false },
                3: { ring: sel('.attach'), click: false },
                4: {
                    act: async (h) => {
                        await openDetails('Add buttons')(h);
                        await h.click(sel('[aria-label="Interactive message type"] button:nth-of-type(2)'));
                        await openDetails('Auto-reply when someone taps a button')(h);
                    },
                    ring: sel('details.more-card'),
                    click: false,
                },
                5: { ring: sel('aside.side app-phone-preview'), click: false },
                6: { ring: sel('.test'), click: false },
            },
        },
        5: {
            path: '/campaign',
            before: async (h) => { await fresh(h); await vipSegment(h); await next(h); await writeMessage(h); await next(h); },
            steps: {
                1: { ring: sel('[aria-label="When to send"] button:nth-of-type(2)'), click: true },
                2: {
                    // Tomorrow, so the time is not in the past.
                    act: async (h) => {
                        const day = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
                        await h.page.$eval('#rv-date', (n, v) => { n.value = v; n.dispatchEvent(new Event('input', { bubbles: true })); n.dispatchEvent(new Event('change', { bubbles: true })); }, day);
                        await h.settle(500);
                    },
                    ring: sel('.when.enter'),
                    click: false,
                },
                3: {
                    act: async (h) => { await h.goto('/campaigns'); await h.click(sel('.chips[aria-label="Filter by status"] button:nth-of-type(2)')); },
                    ring: sel('td.status'),
                },
                4: { ring: sel('td.name a'), click: false },
            },
        },
        6: {
            path: '/campaign',
            before: async (h) => { await fresh(h); await uploadSheet(h); await next(h); await writeMessage(h); await next(h); await openDetails('More options')(h); },
            steps: {
                1: {
                    ring: sel('.adv-row:has(button[aria-label="Spread over several days"])'),
                    click: false,
                    after: async (h) => { await h.click(sel('button[aria-label="Spread over several days"]')); await h.settle(800); },
                },
                2: { ring: sel('.when.enter'), click: false },
                3: { act: (h) => h.settle(1500), ring: sel('.plan-slot'), click: false },
            },
        },
        7: {
            path: '/campaign',
            before: async (h) => { await fresh(h); await vipSegment(h); await next(h); await writeMessage(h); await next(h); await openDetails('More options')(h); },
            steps: {
                1: { ring: sel('.field:has(#rv-repeat)'), click: false },
                2: { act: async (h) => { await h.page.select('#rv-repeat', 'week'); await h.settle(400); }, ring: sel('.when:has(#rv-repeat)'), click: false },
                3: { act: (h) => h.goto(`/campaigns/${ids['Festive preview']}`), ring: sel('.series') },
                4: { act: (h) => h.goto(`/campaigns/${ids.festiveNext}`), ring: sel('[aria-label="Campaign controls"] button:has(.ti-ban)'), click: false },
            },
        },
        8: {
            path: '/campaign',
            before: (h) => fresh(h),
            steps: {
                1: { ring: sel('[role=tablist][aria-label="Mode"] [role=tab]:nth-of-type(2)'), click: true, after: (h) => h.settle(600) },
                2: {
                    act: async (h) => {
                        await h.page.type('#recipient', '9876543210');
                        await h.page.type('#recipient-name', 'Priya Nair');
                        await h.page.type('#message', 'Hi Priya, your saree is ready for pickup. See you soon!');
                        await h.page.evaluate(() => document.activeElement?.blur());
                        await h.settle(400);
                    },
                    ring: sel('section.card:has(#recipient)'),
                    click: false,
                },
            },
        },
        9: {
            path: '/campaigns',
            steps: {
                1: { act: (h) => h.settle(500), ring: link('Weekend sale'), click: true },
                2: { act: (h) => h.settle(1500), ring: sel('ol.stages') },
                3: { ring: sel('section[aria-labelledby="funnel-h"] header.head') },
                4: { ring: sel('section[aria-labelledby="clicks-h"]') },
                5: { ring: sel('section[aria-labelledby="fail-h"]') },
            },
        },
        10: {
            path: '/campaigns',
            steps: {
                1: { ring: link('Monsoon clearance'), click: true },
                2: { act: (h) => h.settle(1200), ring: sel('[aria-label="Campaign controls"] button:has(.ti-player-pause)'), click: true, after: (h) => h.settle(1200) },
                3: {
                    act: (h) => h.click(sel('[aria-label="Campaign controls"] button:has(.ti-ban)')),
                    ring: sel('[aria-label="Campaign controls"] button:has(.ti-ban)'),
                    click: false,
                },
            },
        },
        11: {
            get path() { return `/campaigns/${ids['Weekend sale']}`; },
            before: (h) => h.settle(1200),
            steps: {
                1: { ring: sel('section[aria-labelledby="rt-h"]') },
                2: { ring: sel('button[aria-label^="Send to no reply" i]'), click: true, after: (h) => h.settle(1500) },
                3: { ring: sel('.card.panel:has(#rt-campaign)') },
            },
        },
        12: {
            path: '/campaigns',
            steps: {
                1: { ring: sel('.chips[aria-label="Filter by status"]') },
                2: { ring: sel('button[aria-label="Refresh campaigns"]'), click: false },
                3: {
                    act: (h) => h.click(sel('.chips[aria-label="Filter by status"] button:nth-of-type(7)')),
                    ring: sel('tr:has(a[aria-label="Edit Diwali offer (demo)"])'),
                    click: false,
                },
            },
        },
    },
};
