/**
 * Auto-replies v2: match types, priority, variants, schedule, audience, system
 * replies (welcome, away, fallback, handoff), menus, media/interactive jobs,
 * analytics, the test console, and migration of v1 rows.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { AutoReplyEngine } from '../src/autoreply/engine.js';
import { fold, matchOne } from '../src/autoreply/match.js';
import { AutoReplyStore } from '../src/autoreply/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { ConversationStore } from '../src/inbox/store.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-autoreply-v2-'));
let seq = 0;
const opened = [];

// Saturday 10 Oct 2026 and the Monday after, in UTC.
const SAT_NOON = new Date('2026-10-10T12:00:00Z');
const MON_10AM = new Date('2026-10-12T10:00:00Z');
const MON_8PM = new Date('2026-10-12T20:00:00Z');

/** A fresh database, an engine on it, and a fake message service that records jobs. */
function setup({ timezone = 'UTC' } = {}) {
    const db = new Database(path.join(tmp, `e${++seq}.db`));
    opened.push(db);
    db.db.exec('DELETE FROM auto_replies'); // no seeded hi/hello/pricing
    const jobs = [];
    const keys = new Set();
    const service = {
        send(job) {
            if (keys.has(job.idempotencyKey)) return { accepted: false, messageId: null, reason: 'duplicate' };
            keys.add(job.idempotencyKey);
            jobs.push(job);
            return { accepted: true, messageId: `m${jobs.length}`, reason: null };
        },
    };
    const engine = new AutoReplyEngine(db, { isConnected: () => true }, { delayRangeMs: [0, 0], service });
    const contacts = new ContactStore(db);
    const conversations = new ConversationStore(db);
    engine.attach({
        contacts, conversations,
        channel: () => ({ id: 0, timezone }),
        media: (mediaId) => ({ mediaId, filename: 'menu.pdf', mimetype: 'application/pdf', size: 10 }),
    });
    const store = new AutoReplyStore(db);
    let n = 0;
    /** Deliver an inbound message the way handleInbound does: stored first, then both stages. */
    const inbound = async (body, { sender = '919800000001', now = MON_10AM, replyId = null, senderName = 'Asha Rao' } = {}) => {
        const saved = db.insertInbound({ messageId: `in.${seq}.${++n}`, sender, senderName, body, receivedAt: now.toISOString() });
        const before = jobs.length;
        const early = await engine.handlePre({ ...saved, replyId }, { now });
        if (!early.handled) await engine.handleInbound(saved, { greeted: early.greeted, greeting: early.greeting, now });
        return jobs.slice(before);
    };
    return { db, engine, jobs, store, contacts, conversations, inbound };
}

describe('matching', () => {
    const rule = (matchType, keywords) => ({ id: 1, matchType, keywords });

    it('EXACT ignores case, accents, quotes and trailing punctuation', () => {
        assert.ok(matchOne(rule('EXACT', ['cafe']), '"Café!"'));
        assert.equal(matchOne(rule('EXACT', ['cafe']), 'cafe menu'), null);
        assert.equal(fold('  ÉLÈVE?? '), 'eleve');
    });

    it('CONTAINS finds a keyword anywhere, STARTS_WITH only at the start', () => {
        assert.ok(matchOne(rule('CONTAINS', ['price']), 'what is the PRICE today'));
        assert.ok(matchOne(rule('STARTS_WITH', ['order']), 'Order 1234 status'));
        assert.equal(matchOne(rule('STARTS_WITH', ['order']), 'my order 1234'), null);
    });

    it('ANY_OF matches whole words from a list, not fragments', () => {
        const r = rule('ANY_OF', ['hi', 'hello', 'good morning']);
        assert.ok(matchOne(r, 'Hi there'));
        assert.ok(matchOne(r, 'well, good morning!'));
        assert.equal(matchOne(r, 'this is it'), null, '"hi" inside "this" is not a hit');
        // a v1-style comma list in the single keyword works too
        assert.ok(matchOne({ id: 2, matchType: 'ANY_OF', keyword: 'refund, return' }, 'I want to return it'));
    });

    it('FUZZY tolerates typos but not on short words', () => {
        const r = rule('FUZZY', ['price', 'delivery time']);
        assert.ok(matchOne(r, 'whats the pirce'), 'transposition');
        assert.ok(matchOne(r, 'delivry tme please'), 'two dropped letters in a phrase');
        assert.equal(matchOne(r, 'nice'), null);
        assert.equal(matchOne(rule('FUZZY', ['hi']), 'ho'), null, 'two-letter words need an exact hit');
        assert.ok(matchOne(r, 'price').score === 1);
    });

    it('REGEX is case-insensitive and a broken pattern is just a miss', () => {
        assert.ok(matchOne(rule('REGEX', ['invoice\\s*#?\\d+']), 'Invoice #42'));
        assert.equal(matchOne(rule('REGEX', ['(']), 'anything'), null);
    });
});

describe('rules', () => {
    it('evaluates by priority and reorder changes the winner', async () => {
        const { store, inbound } = setup();
        const a = store.save({ name: 'Generic', matchType: 'CONTAINS', keywords: ['price'], replyBody: 'generic' });
        const b = store.save({ name: 'Specific', matchType: 'CONTAINS', keywords: ['price list'], replyBody: 'specific' });
        assert.equal((await inbound('send the price list'))[0].text, 'generic');
        store.reorder([b.id, a.id]);
        assert.equal((await inbound('send the price list'))[0].text, 'specific');
    });

    it('a rule that does not stop lets the next one answer too', async () => {
        const { store, inbound } = setup();
        store.save({ matchType: 'CONTAINS', keywords: ['order'], replyBody: 'one', actions: { stop: false } });
        store.save({ matchType: 'CONTAINS', keywords: ['order'], replyBody: 'two' });
        store.save({ matchType: 'CONTAINS', keywords: ['order'], replyBody: 'three' });
        assert.deepEqual((await inbound('my order')).map((j) => j.text), ['one', 'two']);
    });

    it('picks a random reply variant', async () => {
        const { store, engine, inbound } = setup();
        store.save({ matchType: 'EXACT', keywords: ['hey'], variants: ['first', 'second', 'third'] });
        engine.random = () => 0.99;
        assert.equal((await inbound('hey'))[0].text, 'third');
        engine.random = () => 0;
        assert.equal((await inbound('hey'))[0].text, 'first');
    });

    it('renders variables, contact fields and {var|fallback}', async () => {
        const { store, contacts, inbound } = setup({ timezone: 'Asia/Kolkata' });
        store.saveSettings({ businessName: 'Rao Bakery' });
        contacts.upsert({ phone: '919800000001', name: 'Asha Rao', customFields: { city: 'Pune' } });
        contacts.upsert({ phone: '919800000009', name: '', customFields: { plan: 'gold' } });
        store.save({ matchType: 'EXACT', keywords: ['vars'], replyBody: '{time_greeting} {first_name} from {city|your city} - {business_name} {date} {phone}' });
        const [job] = await inbound('vars', { now: MON_10AM }); // 15:30 in Kolkata
        assert.equal(job.text, 'Good afternoon Asha from Pune - Rao Bakery 12 Oct 2026 919800000001');
        const [other] = await inbound('vars', { sender: '919800000009', senderName: '' });
        assert.match(other.text, /^Good afternoon there from your city/);
    });

    it('schedule: inside the window replies, outside sends the outside-hours reply or falls through', async () => {
        const { store, inbound } = setup();
        const sched = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '09:00', end: '17:00' };
        store.save({ matchType: 'CONTAINS', keywords: ['visit'], replyBody: 'Come over now!', schedule: { ...sched, outsideReply: 'We open Monday 9am.' } });
        store.save({ matchType: 'CONTAINS', keywords: ['call'], replyBody: 'Call us now', schedule: sched });
        store.save({ matchType: 'CONTAINS', keywords: ['call'], replyBody: 'Leave a message' });
        assert.equal((await inbound('can I visit', { now: MON_10AM }))[0].text, 'Come over now!');
        assert.equal((await inbound('can I visit', { now: SAT_NOON }))[0].text, 'We open Monday 9am.');
        assert.equal((await inbound('can I call', { now: MON_10AM }))[0].text, 'Call us now');
        assert.equal((await inbound('can I call', { now: MON_8PM }))[0].text, 'Leave a message');
    });

    it('schedule: times are read in the zone they were picked in, not the number zone', async () => {
        const { store, inbound } = setup(); // number is on Asia/Kolkata: MON_10AM is 15:30 there
        store.save({ matchType: 'EXACT', keywords: ['open'], replyBody: 'Yes, open', schedule: { start: '09:00', end: '11:00', timezone: 'UTC' } });
        assert.equal((await inbound('open', { now: MON_10AM }))[0]?.text, 'Yes, open');
        assert.equal((await inbound('open', { now: MON_8PM })).length, 0, 'after the window nothing replies');
    });

    it('audience: new contacts only, and contacts with a tag', async () => {
        const { store, contacts, inbound } = setup();
        store.save({ matchType: 'EXACT', keywords: ['offer'], replyBody: 'VIP offer', audience: { type: 'tag', tag: 'vip' } });
        store.save({ matchType: 'EXACT', keywords: ['offer'], replyBody: 'New-customer offer', audience: { type: 'new' } });
        store.save({ matchType: 'EXACT', keywords: ['offer'], replyBody: 'Regular offer' });
        const old = '919800000002';
        await inbound('hello', { sender: old, now: new Date('2026-10-01T10:00:00Z') });
        assert.equal((await inbound('offer', { sender: '919800000003' }))[0].text, 'New-customer offer');
        assert.equal((await inbound('offer', { sender: old }))[0].text, 'Regular offer');
        contacts.upsert({ phone: old, tags: ['VIP'] });
        assert.equal((await inbound('offer', { sender: old }))[0].text, 'VIP offer');
    });

    it('actions: tag and field on the contact', async () => {
        const { store, contacts, inbound } = setup();
        store.save({ matchType: 'ANY_OF', keywords: ['wholesale'], replyBody: 'Noted', actions: { addTag: 'lead', setField: { key: 'interest', value: 'wholesale' } } });
        await inbound('wholesale prices?');
        const c = contacts.getByPhone('919800000001');
        assert.ok(c.tags.includes('lead'));
        assert.equal(c.customFields.interest, 'wholesale');
    });
});

describe('system replies', () => {
    it('welcomes a contact on the first message only, in the same message as the keyword answer', async () => {
        const { store, inbound } = setup();
        store.saveSettings({ welcome: { enabled: true, text: 'Welcome {first_name}!' } });
        store.save({ matchType: 'EXACT', keywords: ['menu please'], replyBody: 'Here is the menu' });
        assert.deepEqual((await inbound('menu please')).map((j) => j.text), ['Welcome Asha!\n\nHere is the menu']);
        assert.deepEqual((await inbound('menu please')).map((j) => j.text), ['Here is the menu']);
    });

    it('away message and a keyword answer go out as one message; the away throttle still counts it', async () => {
        const { store, inbound } = setup();
        store.saveSettings({ away: { enabled: true, text: 'We are closed', throttleHours: 12 } });
        store.save({ matchType: 'EXACT', keywords: ['price'], replyBody: 'From 99' });
        assert.deepEqual((await inbound('price', { now: SAT_NOON })).map((j) => j.text), ['We are closed\n\nFrom 99']);
        assert.deepEqual((await inbound('price', { now: new Date(SAT_NOON.getTime() + 3_600_000) })).map((j) => j.text), ['From 99']);
    });

    it('welcome and away together, with nothing else to say, are one message', async () => {
        const { store, inbound } = setup();
        store.saveSettings({ welcome: { enabled: true, text: 'Hi!' }, away: { enabled: true, text: 'We are closed', throttleHours: 12 } });
        const jobs = await inbound('hello', { now: SAT_NOON });
        assert.deepEqual(jobs.map((j) => j.text), ['Hi!\n\nWe are closed']);
    });

    it('a welcome with media is still its own message', async () => {
        const { store, inbound } = setup();
        store.saveSettings({ welcome: { enabled: true, text: 'Welcome', media: { mediaId: 'med_1' } } });
        store.save({ matchType: 'EXACT', keywords: ['price'], replyBody: 'From 99' });
        assert.deepEqual((await inbound('price')).map((j) => j.text), ['Welcome', 'From 99']);
    });

    it('away message outside business hours and on holidays, once per throttle window', async () => {
        const { store, inbound } = setup();
        store.saveSettings({ away: { enabled: true, text: 'We are closed', throttleHours: 12, holidays: ['2026-10-13'] } });
        assert.deepEqual(await inbound('hello?', { now: MON_10AM }), [], 'open: nothing (no rules, no fallback)');
        assert.equal((await inbound('hello?', { now: SAT_NOON }))[0].text, 'We are closed');
        assert.deepEqual(await inbound('anyone?', { now: new Date(SAT_NOON.getTime() + 3_600_000) }), [], 'throttled');
        const holiday = await inbound('open today?', { now: new Date('2026-10-13T10:00:00Z'), sender: '919800000004' });
        assert.equal(holiday[0].text, 'We are closed');
    });

    it('default fallback is throttled per contact and skipped after a welcome', async () => {
        const { store, inbound } = setup();
        store.saveSettings({ fallback: { enabled: true, text: 'Sorry?', throttleHours: 6 }, welcome: { enabled: true, text: 'Hi!' } });
        assert.deepEqual((await inbound('blah')).map((j) => j.text), ['Hi!'], 'welcome already answered');
        assert.deepEqual((await inbound('blah blah')).map((j) => j.text), ['Sorry?']);
        assert.deepEqual(await inbound('more blah'), [], 'within 6 h');
        const later = await inbound('blah again', { now: new Date(MON_10AM.getTime() + 7 * 3_600_000) });
        assert.deepEqual(later.map((j) => j.text), ['Sorry?']);
    });

    it('a FALLBACK rule wins over the system fallback', async () => {
        const { store, inbound } = setup();
        store.saveSettings({ fallback: { enabled: true, text: 'system' } });
        store.save({ matchType: 'FALLBACK', keywords: [], replyBody: 'rule fallback' });
        assert.equal((await inbound('zzz'))[0].text, 'rule fallback');
    });

    it('handoff keyword confirms, opens the conversation and pauses the bot', async () => {
        const { store, conversations, inbound } = setup();
        store.saveSettings({ handoff: { enabled: true, keywords: ['agent', 'human'], text: 'Connecting you now' } });
        store.save({ matchType: 'CONTAINS', keywords: ['agent'], replyBody: 'should not fire' });
        conversations.upsertForInbound({ phone: '919800000001', channelId: 0 });
        const jobs = await inbound('I want a human please');
        assert.deepEqual(jobs.map((j) => j.text), ['Connecting you now']);
        assert.equal(conversations.isBotPaused('919800000001', 0), true);
        assert.ok(conversations.getByPhone('919800000001', 0).tags.includes('handoff'));
    });

    it('a rule can escalate too', async () => {
        const { store, conversations, inbound } = setup();
        store.save({ matchType: 'ANY_OF', keywords: ['complaint'], replyBody: 'Sorry, a manager will call', actions: { escalate: true } });
        await inbound('I have a complaint', { sender: '919800000005' });
        assert.equal(conversations.isBotPaused('919800000005', 0), true);
    });
});

describe('menus, media and interactive', () => {
    const menuRule = {
        name: 'Main menu', matchType: 'ANY_OF', keywords: ['menu'], replyBody: 'How can we help, {first_name}?',
        interactive: { type: 'list', list: { button: 'Options', sections: [{ title: 'Pick', rows: [
            { id: 'HOURS', title: 'Opening hours' }, { id: 'TRACK', title: 'Track order' }] }] } },
        menu: {
            HOURS: { replyBody: 'We open 9 to 6.' },
            TRACK: {
                replyBody: 'Which order?',
                interactive: { type: 'buttons', buttons: [{ id: 'LAST', title: 'Last order' }, { id: 'OTHER', title: 'Another' }] },
                menu: { LAST: { replyBody: 'Your last order is on the way.', actions: { addTag: 'tracking' } }, OTHER: { replyBody: 'Send the order number.' } },
            },
        },
    };

    it('passes media and the personalised interactive block to the send job', async () => {
        const { store, inbound } = setup();
        store.save({ ...menuRule, media: { mediaId: 'med_000000000001' } });
        const [job] = await inbound('menu');
        assert.equal(job.messageType, 'auto_reply');
        assert.equal(job.text, 'How can we help, Asha?');
        assert.equal(job.media.mediaId, 'med_000000000001');
        assert.equal(job.media.filename, 'menu.pdf');
        assert.equal(job.interactive.type, 'list');
        assert.equal(job.interactive.list.sections[0].rows[1].title, 'Track order');
    });

    it('follows a menu by number, nested by title, and by native reply id', async () => {
        const { store, contacts, inbound } = setup();
        store.save(menuRule);
        await inbound('menu');
        assert.equal((await inbound('2'))[0].text, 'Which order?');
        const [last] = await inbound('last order');
        assert.equal(last.text, 'Your last order is on the way.');
        assert.ok(contacts.getByPhone('919800000001').tags.includes('tracking'));
        assert.equal(store.session('919800000001', MON_10AM), null, 'leaf answer ends the menu');

        await inbound('menu');
        assert.equal((await inbound('Opening hours', { replyId: 'HOURS' }))[0].text, 'We open 9 to 6.');
        assert.deepEqual(await inbound('2'), [], 'out of the menu, "2" is just text');
    });

    it('the menu expires after 30 minutes', async () => {
        const { store, inbound } = setup();
        store.save(menuRule);
        await inbound('menu');
        assert.deepEqual(await inbound('1', { now: new Date(MON_10AM.getTime() + 31 * 60_000) }), []);
    });

    it('does not answer the same inbound message twice', async () => {
        const { store, engine, jobs, db } = setup();
        store.save({ matchType: 'EXACT', keywords: ['ping'], replyBody: 'pong' });
        const saved = db.insertInbound({ messageId: 'dup.1', sender: '919800000006', body: 'ping' });
        await engine.handleInbound(saved, { now: MON_10AM });
        await engine.handleInbound(saved, { now: MON_10AM });
        assert.equal(jobs.length, 1);
    });
});

describe('analytics', () => {
    it('counts hits per rule and per system reply, with today and 7 days', async () => {
        const { store, inbound } = setup();
        const r = store.save({ matchType: 'EXACT', keywords: ['ping'], replyBody: 'pong' });
        store.saveSettings({ welcome: { enabled: true, text: 'hi' } });
        await inbound('ping', { now: new Date('2026-10-02T10:00:00Z') });
        await inbound('ping', { now: MON_10AM });
        await inbound('ping', { now: MON_10AM });
        const stats = store.stats(MON_10AM, new Date('2026-10-12T00:00:00Z'));
        assert.deepEqual(stats[`rule:${r.id}`], { hits: 3, lastTriggeredAt: MON_10AM.toISOString(), today: 2, week: 2 });
        assert.equal(stats.welcome.hits, 1);
    });
});

describe('migration', () => {
    it('keeps v1 rows working, in the v1 order', () => {
        const file = path.join(tmp, 'legacy-autoreply.db');
        const old = new DatabaseSync(file);
        old.exec(`
            CREATE TABLE auto_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL DEFAULT 1,
                keyword TEXT NOT NULL, match_type TEXT NOT NULL, reply_body TEXT NOT NULL, is_active INTEGER DEFAULT 1,
                cooldown_sec INTEGER DEFAULT 300, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            INSERT INTO auto_replies (keyword, match_type, reply_body, created_at, updated_at) VALUES
                ('', 'FALLBACK', 'fallback', 'x', 'x'),
                ('price', 'CONTAINS', 'contains', 'x', 'x'),
                ('price', 'EXACT', 'exact', 'x', 'x');
        `);
        old.close();
        const db = new Database(file);
        try {
            const rules = db.getActiveAutoReplies();
            assert.deepEqual(rules.map((r) => r.replyBody), ['exact', 'contains', 'fallback']);
            assert.deepEqual(rules[0].keywords, ['price']);
            assert.deepEqual(rules[0].variants, ['exact']);
            assert.deepEqual(rules[0].audience, { type: 'all' });
            const engine = new AutoReplyEngine(db, null);
            assert.equal(engine.matchRule('price', rules).replyBody, 'exact');
            assert.equal(engine.matchRule('the price?', rules).replyBody, 'contains');
            assert.equal(engine.matchRule('nothing', rules).replyBody, 'fallback');
        } finally {
            db.close();
        }
    });
});

describe('HTTP', () => {
    let app;
    let server;
    let base;
    let token;
    let db;

    const call = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    before(async () => {
        db = new Database(path.join(tmp, 'http.db'));
        app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, safetyEnabled: false } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        token = sessionFor(app, { tenantId: 1, role: 'owner' });
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
    });

    it('creates v2 rules, validates them, and reorders', async () => {
        const bad = await call('POST', '/api/auto-replies', { matchType: 'FUZZY', keywords: [], replyBody: 'x' });
        assert.equal(bad.status, 400);
        const badButtons = await call('POST', '/api/auto-replies', { matchType: 'EXACT', keywords: ['a'], replyBody: 'x', interactive: { type: 'buttons', buttons: [] } });
        assert.equal(badButtons.status, 400);

        const made = await call('POST', '/api/auto-replies', {
            name: 'Prices', matchType: 'FUZZY', keywords: ['price', 'cost'], variants: ['A', 'B'],
            schedule: { days: ['mon'], start: '09:00', end: '17:00', outsideReply: 'later' }, audience: { type: 'tag', tag: 'VIP' },
        });
        assert.equal(made.status, 201);
        assert.deepEqual(made.body.rule.keywords, ['price', 'cost']);
        assert.equal(made.body.rule.audience.tag, 'vip');
        assert.deepEqual(made.body.rule.stats, { hits: 0, lastTriggeredAt: null, today: 0, week: 0 });

        const list = (await call('GET', '/api/auto-replies')).body.rules;
        assert.equal(list.at(-1).id, made.body.rule.id, 'new rules go last');
        const reordered = await call('POST', '/api/auto-replies/reorder', { ids: [made.body.rule.id] });
        assert.equal(reordered.body.rules[0].id, made.body.rule.id);

        // a v1 client editing replyBody keeps the other variants
        const edited = await call('PUT', `/api/auto-replies/${made.body.rule.id}`, { replyBody: 'A2' });
        assert.deepEqual(edited.body.rule.variants, ['A2', 'B']);
    });

    it('saves settings deep-merged and reports system stats', async () => {
        const saved = await call('PUT', '/api/auto-replies/settings', { away: { enabled: true, hours: { sat: { open: true } } } });
        assert.equal(saved.body.settings.away.enabled, true);
        assert.equal(saved.body.settings.away.hours.sat.open, true);
        assert.equal(saved.body.settings.away.hours.mon.start, '09:00');
        const got = (await call('GET', '/api/auto-replies/settings')).body;
        assert.equal(got.settings.timezone, 'UTC');
        assert.deepEqual(Object.keys(got.stats).sort(), ['away', 'fallback', 'handoff', 'welcome']);
        await call('PUT', '/api/auto-replies/settings', { away: { enabled: false } });
    });

    it('test console runs the pipeline without sending or counting', async () => {
        await call('PUT', '/api/auto-replies/settings', { welcome: { enabled: true, text: 'Welcome {first_name}' } });
        const menu = await call('POST', '/api/auto-replies', {
            name: 'Support menu', matchType: 'EXACT', keywords: ['support'], replyBody: 'Pick one',
            interactive: { type: 'buttons', buttons: [{ id: 'BILL', title: 'Billing' }, { id: 'TECH', title: 'Technical' }] },
            menu: { BILL: { replyBody: 'Billing team here', media: { mediaId: 'med_000000000002' } }, TECH: { replyBody: 'Tech team here' } },
        });
        const historyBefore = db.forTenant(1).history({ limit: 500 }).length;

        const first = await call('POST', '/api/auto-replies/test', { body: 'support', sender: '919811111111', senderName: 'Ravi Kumar', firstContact: true, at: MON_10AM.toISOString() });
        assert.equal(first.status, 200);
        // The welcome rides in front of the rule's reply: one message, as the live path sends it.
        assert.deepEqual(first.body.replies.map((r) => r.source), ['rule']);
        assert.equal(first.body.replies[0].text, 'Welcome Ravi\n\nPick one');
        assert.equal(first.body.replies[0].interactive.type, 'buttons');
        assert.match(first.body.replies[0].fallbackText, /^Welcome Ravi\n\nPick one[\s\S]*1\. Billing/);
        assert.equal(first.body.matched.ruleId, menu.body.rule.id);
        assert.equal(first.body.session.ruleId, menu.body.rule.id);
        assert.ok(first.body.trace.length >= 2);

        const second = await call('POST', '/api/auto-replies/test', { body: '1', sender: '919811111111', session: first.body.session, firstContact: false, at: new Date(MON_10AM.getTime() + 60000).toISOString() });
        assert.equal(second.body.replies[0].source, 'menu');
        assert.equal(second.body.replies[0].text, 'Billing team here');
        assert.equal(second.body.replies[0].media.url, '/api/media/med_000000000002');
        assert.equal(second.body.session, null);

        const help = await call('POST', '/api/auto-replies/test', { body: 'help', sender: '919811111111', firstContact: false });
        assert.equal(help.body.replies[0].source, 'help');
        assert.match(help.body.replies[0].text, /support/);

        assert.equal(db.forTenant(1).history({ limit: 500 }).length, historyBefore, 'nothing was queued');
        const rule = (await call('GET', '/api/auto-replies')).body.rules.find((r) => r.id === menu.body.rule.id);
        assert.equal(rule.stats.hits, 0, 'nothing was counted');
        await call('PUT', '/api/auto-replies/settings', { welcome: { enabled: false } });
    });
});

describe('live path: one message per inbound', () => {
    let app;
    let server;
    let base;
    let db;
    let transport;

    const call = async (method, url, body) => {
        const res = await fetch(base + url, {
            method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    };
    let n = 0;
    // Played through the transport, as a real one hands a received message to the app.
    const inbound = async (from, body, id = `wamid.live.${(n += 1)}`) => {
        transport.events.emit('inbound', { messageId: id, sender: from, senderName: 'Mira', body });
    };
    const textsTo = (to) => db.db.prepare("SELECT message FROM messages WHERE recipient = ? AND direction = 'outbound' AND status = 'SANDBOX' ORDER BY rowid")
        .all(to).map((r) => r.message);
    const settle = async (to, count) => {
        const end = Date.now() + 6000;
        while (Date.now() < end && textsTo(to).length < count) await new Promise((resolve) => setTimeout(resolve, 25));
        await new Promise((resolve) => setTimeout(resolve, 300)); // room for a second message, if one were coming
        return textsTo(to);
    };

    before(async () => {
        db = new Database(path.join(tmp, 'live.db'));
        db.db.exec('DELETE FROM auto_replies');
        app = createTestApp({
            db, dataDir: tmp,
            config: {
                ...DEFAULTS, transport: TRANSPORT_SANDBOX,
                safetyEnabled: false, pacingMode: 'fixed', rateLimitPerSecond: 50, rateLimitBurst: 50,
            },
        });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        assert.equal((await call('POST', '/api/connection/connect')).status, 200);
        const rt = app.locals.runtimeFor(1);
        transport = rt.runtimeFor(rt.channels.getDefault()).state.transport;
        await call('PUT', '/api/auto-replies/settings', { welcome: { enabled: true, text: 'Welcome!' } });
        await call('POST', '/api/auto-replies', { matchType: 'EXACT', keywords: ['price'], replyBody: 'From 99' });
    });

    after(async () => {
        await closeApp(app);
        await new Promise((resolve) => server.close(resolve));
        db.close();
    });

    it('a first-time contact asking a keyword gets the welcome and the answer in one message', async () => {
        await inbound('919822200001', 'price');
        assert.deepEqual(await settle('919822200001', 1), ['Welcome!\n\nFrom 99']);
    });

    it('the welcome rides in front of an FAQ answer too', async () => {
        const faq = await call('POST', '/api/faq', { question: 'Where are you?', answer: 'MG Road', keywords: ['where'], matchType: 'CONTAINS' });
        assert.equal(faq.status, 201, JSON.stringify(faq.body));
        await inbound('919822200002', 'where are you');
        assert.deepEqual(await settle('919822200002', 1), ['Welcome!\n\nMG Road']);
    });

    it('the same inbound message delivered twice is answered once', async () => {
        await inbound('919822200003', 'price', 'wamid.live.dup');
        await settle('919822200003', 1);
        await inbound('919822200003', 'price', 'wamid.live.dup');
        assert.deepEqual(await settle('919822200003', 2), ['Welcome!\n\nFrom 99']);
        const rows = db.db.prepare("SELECT COUNT(*) AS n FROM inbound_messages WHERE message_id = 'wamid.live.dup'").get();
        assert.equal(rows.n, 1);
    });
});

after(() => {
    for (const db of opened) db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});
