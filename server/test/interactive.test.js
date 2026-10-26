/**
 * Interactive messages (buttons / list / CTA) and what happens after a
 * campaign with buttons goes out: the numbered fallback on QR numbers / sandbox, recording sends, matching replies,
 * button_clicks and the per-campaign reply rules.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { createTestApp as createApp } from './helpers.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import {
    InteractiveError, carouselCaptions, interactiveOptions, matchReply, normalizeInteractive, personalizeInteractive, renderFallbackText,
} from '../src/messaging/interactive.js';
import { campaignIdFromParam, normalizeReplyRules } from '../src/messaging/replies.js';
import { SandboxTransport } from '../src/transports/sandbox.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-interactive-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
};

const BUTTONS = {
    type: 'buttons',
    header: 'Order {order_id}',
    footer: 'Reply STOP to opt out',
    buttons: [
        { id: 'YES', title: 'Yes, confirm', payload: 'CONFIRM_ORDER_{order_id}' },
        { id: 'LATER', title: 'Not now' },
        { id: 'AGENT', title: 'Talk to agent' },
    ],
};
const LIST = {
    type: 'list',
    list: {
        button: 'Pick a slot',
        sections: [{ title: 'Morning', rows: [{ id: 'AM9', title: '9 AM', description: 'Front desk' }, { id: 'AM11', title: '11 AM' }] }],
    },
};

// ------------------------------------------------------------ contract --
describe('interactive.js', () => {
    it('normalizes, validates and slugs ids', () => {
        assert.equal(normalizeInteractive(null), null);
        assert.equal(normalizeInteractive({ type: 'none' }), null);
        const n = normalizeInteractive({ type: 'buttons', buttons: [{ title: 'Yes please!' }, { title: '' }] });
        assert.deepEqual(n.buttons, [{ id: 'YES_PLEASE', title: 'Yes please!', payload: undefined }]);
        assert.throws(() => normalizeInteractive({ type: 'buttons', buttons: [1, 2, 3, 4].map((i) => ({ title: `B${i}` })) }), InteractiveError);
        assert.throws(() => normalizeInteractive({ type: 'list', list: { sections: [] } }), InteractiveError);
        assert.throws(() => normalizeInteractive({ type: 'cta', cta: [{ kind: 'url', title: 'x' }] }), InteractiveError);
        assert.throws(() => normalizeInteractive({ type: 'bogus' }), /Unknown interactive type/);
        assert.equal(normalizeInteractive({ type: 'buttons', buttons: [{ title: 'x'.repeat(40) }] }).buttons[0].title.length, 20);
    });

    it('personalizes titles and payloads per recipient', () => {
        const p = personalizeInteractive(normalizeInteractive(BUTTONS), { order_id: '981' });
        assert.equal(p.header, 'Order 981');
        assert.equal(p.buttons[0].payload, 'CONFIRM_ORDER_981');
        assert.equal(p.buttons[1].payload, 'LATER', 'payload defaults to the id');
    });

    it('renders the numbered fallback and matches typed answers', () => {
        const p = personalizeInteractive(normalizeInteractive(BUTTONS), { order_id: '7' });
        const text = renderFallbackText('Your order is ready.', p);
        assert.equal(text, '*Order 7*\n\nYour order is ready.\n\nReply 1, 2 or 3:\n1. Yes, confirm\n2. Not now\n3. Talk to agent\n\n_Reply STOP to opt out_');
        assert.equal(matchReply(p, { body: '1' }).id, 'YES');
        assert.equal(matchReply(p, { body: '2.' }).id, 'LATER');
        assert.equal(matchReply(p, { body: 'talk to AGENT' }).id, 'AGENT');
        assert.equal(matchReply(p, { replyId: 'CONFIRM_ORDER_7' }).id, 'YES');
        assert.equal(matchReply(p, { body: '4' }), null);
        assert.equal(matchReply(p, { body: 'hello' }), null);
        assert.equal(interactiveOptions(normalizeInteractive(LIST)).length, 2);
        assert.equal(renderFallbackText('Book', normalizeInteractive(LIST)), 'Book\n\n*Pick a slot*\n\n_Morning_\n1. 9 AM - Front desk\n2. 11 AM');
    });

    it('renders each CTA kind on its own labelled line', () => {
        const cta = normalizeInteractive({ type: 'cta', cta: [{ kind: 'url', title: 'Track', value: 'https://x.test/1' }, { kind: 'call', title: 'Call us', value: '+15551234' }] });
        assert.equal(renderFallbackText('Shipped', cta), 'Shipped\n\n\u{1F517} Track: https://x.test/1\n\u{1F4DE} Call us: +15551234');
        assert.equal(renderFallbackText('Code', normalizeInteractive({ type: 'cta', cta: [{ kind: 'copy', title: 'Coupon', value: 'SAVE10' }] })), 'Code\n\n\u{1F4CB} Coupon: SAVE10');
    });
});

describe('carousel', () => {
    const card = (n, extra) => ({ mediaId: `m${n}`, mediaUrl: `/u/${n}.png`, text: `Card ${n} for {name}`, ...extra });
    const REPLY = { type: 'carousel', carousel: { kind: 'reply', cards: [
        card(1, { buttons: [{ title: 'Buy' }, { title: 'Info' }] }),
        card(2, { buttons: [{ title: 'Buy' }] }),
    ] } };
    const URLS = { type: 'carousel', carousel: { kind: 'url', cards: [
        card(1, { cta: [{ title: 'Open', value: 'https://x.test/1' }] }),
        card(2, { cta: [{ title: 'Open', value: 'https://x.test/2' }] }),
    ] } };
    const norm = (v) => normalizeInteractive(v, { carousel: true });

    it('enforces card, kind and button limits', () => {
        const cards = (n) => Array.from({ length: n }, (_, i) => card(i + 1, { buttons: [{ title: 'Go' }] }));
        assert.throws(() => norm({ type: 'carousel', carousel: { kind: 'reply', cards: cards(1) } }), /2 to 5 cards/);
        assert.throws(() => norm({ type: 'carousel', carousel: { kind: 'reply', cards: cards(6) } }), /2 to 5 cards/);
        assert.equal(norm({ type: 'carousel', carousel: { kind: 'reply', cards: cards(5) } }).carousel.cards.length, 5);
        assert.throws(() => norm({ type: 'carousel', carousel: { cards: cards(2) } }), InteractiveError);
        const noImage = cards(2); noImage[1].mediaId = '';
        assert.throws(() => norm({ type: 'carousel', carousel: { kind: 'reply', cards: noImage } }), /Card 2 needs an image/);
        const three = cards(2); three[0].buttons = [1, 2, 3].map((i) => ({ title: 'B' + i }));
        assert.throws(() => norm({ type: 'carousel', carousel: { kind: 'reply', cards: three } }), /Card 1 needs 1 or 2/);
        // a link card in a quick reply carousel (mixed kinds) has no buttons, so it is refused
        const mixed = cards(2); mixed[1] = card(2, { cta: [{ title: 'Open', value: 'https://x.test' }] });
        assert.throws(() => norm({ type: 'carousel', carousel: { kind: 'reply', cards: mixed } }), /Card 2 needs 1 or 2/);
        const twoLinks = URLS.carousel.cards.map((c) => ({ ...c, cta: [...c.cta, ...c.cta] }));
        assert.throws(() => norm({ type: 'carousel', carousel: { kind: 'url', cards: twoLinks } }), /one link button/);
        assert.equal(norm({ ...REPLY, header: 'H', footer: 'F' }).header, undefined);
    });

    it('is campaign-only and never trusts media from the request', () => {
        assert.throws(() => normalizeInteractive(REPLY), /only available in campaigns/);
        const withMedia = { ...REPLY, carousel: { ...REPLY.carousel, cards: REPLY.carousel.cards.map((c) => ({ ...c, media: { filePath: '/etc/passwd' } })) } };
        assert.equal(norm(withMedia).carousel.cards[0].media, undefined);
        assert.deepEqual(normalizeInteractive(withMedia, { carousel: true, keepMedia: true }).carousel.cards[0].media, { filePath: '/etc/passwd' });
    });

    it('gives the same title a distinct default id per card', () => {
        const ids = interactiveOptions(norm(REPLY)).map((o) => o.id);
        assert.deepEqual(ids, ['BUY_1', 'INFO_1', 'BUY_2']);
    });

    it('numbers replies across all cards in the fallback and captions', () => {
        const p = personalizeInteractive(norm(REPLY), { name: 'Asha' });
        assert.deepEqual(carouselCaptions(p), [
            'Card 1 for Asha\n\nReply 1 or 2:\n1. Buy\n2. Info',
            'Card 2 for Asha\n\nReply 3:\n3. Buy',
        ]);
        assert.equal(renderFallbackText('Hi', p), 'Hi\n\n' + carouselCaptions(p).join('\n\n'));
        assert.equal(matchReply(p, { body: '3' }).id, 'BUY_2');
        assert.equal(matchReply(p, { body: '3' }).index, 2);
        assert.equal(matchReply(p, { replyId: 'BUY_2' }).index, 2);
        assert.deepEqual(carouselCaptions(norm(URLS)), ['Card 1 for {name}\n\n\u{1F517} Open: https://x.test/1', 'Card 2 for {name}\n\n\u{1F517} Open: https://x.test/2']);
        assert.deepEqual(carouselCaptions(norm(BUTTONS)), []);
    });
});

// ------------------------------------------------ WhatsApp Web / sandbox --
describe('text fallback transports', () => {
    it('sandbox writes the numbered fallback', async () => {
        const outbox = path.join(tmp, 'outbox.log');
        const t = new SandboxTransport({ ...DEFAULTS }, outbox);
        await t.connect();
        await t.sendMessage('919800000001', 'Ready?', { interactive: normalizeInteractive(BUTTONS) });
        const line = fs.readFileSync(outbox, 'utf8').trim().split('\t');
        assert.match(JSON.parse(line[3]), /Reply 1, 2 or 3:\n1\. Yes, confirm\n2\. Not now/);
    });

});

// ------------------------------------------------------------ rules ----
describe('reply rule validation', () => {
    it('cleans and rejects rules', () => {
        assert.deepEqual(normalizeReplyRules([{ optionId: 'YES', actions: [{ type: 'add_tag', tags: 'hot, vip' }] }, { optionId: 'NO', actions: [] }]),
            [{ optionId: 'YES', actions: [{ type: 'add_tag', tags: ['hot', 'vip'] }] }]);
        assert.throws(() => normalizeReplyRules([{ optionId: 'X', actions: [{ type: 'explode' }] }]), InteractiveError);
        assert.throws(() => normalizeReplyRules([{ optionId: 'X', actions: [{ type: 'mute_days', days: 0 }] }]), InteractiveError);
        assert.throws(() => normalizeReplyRules([{ actions: [{ type: 'opt_out' }] }]), /optionId/);
        assert.equal(campaignIdFromParam('7'), 'camp-7');
        assert.equal(campaignIdFromParam('abc123'), 'abc123');
    });
});

// ----------------------------------------------------- end to end ------
describe('campaign replies end to end', () => {
    let db; let app; let server; let base; let transport;

    before(async () => {
        db = new Database(path.join(tmp, 'e2e.db'));
        app = createApp({
            db,
            config: {
                ...DEFAULTS, transport: TRANSPORT_SANDBOX,
                safetyEnabled: false, pacingMode: 'fixed', rateLimitPerSecond: 50, rateLimitBurst: 50,
            },
        });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        const res = await call('POST', '/api/connection/connect');
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const rt = app.locals.runtimeFor(1);
        transport = rt.runtimeFor(rt.channels.getDefault()).state.transport;
    });

    after(async () => {
        await closeApp(app);
        await new Promise((resolve) => server.close(resolve));
        db.close();
    });

    async function call(method, url, body) {
        const res = await fetch(base + url, {
            method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json().catch(() => null) };
    }

    let n = 0;
    // Played through the transport, as a real one hands a received message (or a native tap's id) to the app.
    const inbound = async (from, { id, ...msg }) => {
        transport.events.emit('inbound', { messageId: id ?? `wamid.in.${(n += 1)}.${Date.now()}`, sender: from, senderName: 'Mira', ...msg });
    };
    const tap = (from, replyId, body, extra = {}) => inbound(from, { body, replyId, ...extra });
    const typed = (from, body, extra = {}) => inbound(from, { body, ...extra });
    const sentTo = (to) => db.db.prepare("SELECT message FROM messages WHERE recipient = ? AND direction = 'outbound' AND status = 'SANDBOX' ORDER BY rowid")
        .all(to).map((r) => r.message);
    const clicks = (campaignId) => db.db.prepare('SELECT * FROM button_clicks WHERE campaign_id = ?').all(campaignId);

    const RULES = [
        { optionId: 'YES', actions: [
            { type: 'add_tag', tags: ['interested'] },
            { type: 'set_field', key: 'status', value: 'Interested' },
            { type: 'send_message', text: 'Thanks {name}, you chose {option}.' },
        ] },
        { optionId: 'LATER', actions: [{ type: 'mute_days', days: 30 }] },
        { optionId: 'AGENT', actions: [{ type: 'escalate', ticket: true }] },
    ];

    let campaignId;
    it('starts a quick campaign with buttons and persists reply rules', async () => {
        const res = await call('POST', '/api/campaign/start', {
            contacts: [
                { name: 'Asha', phone: '919811100001', extra: { order_id: '11' } },
                { name: 'Bo', phone: '919811100002', extra: { order_id: '12' } },
                { name: 'Cy', phone: '919811100003', extra: { order_id: '13' } },
                { name: 'Di', phone: '919811100004', extra: { order_id: '14' } },
            ],
            template: 'Hi {name}, order {order_id} is ready.',
            interactive: BUTTONS,
            replyRules: RULES,
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        campaignId = res.body.campaignId;
        assert.equal(res.body.queued, 4);
        assert.ok(await waitFor(() => db.db.prepare('SELECT COUNT(*) AS n FROM interactive_sends WHERE campaign_id = ?').get(campaignId).n === 4));
        assert.equal(sentTo('919811100001')[0], 'Hi Asha, order 11 is ready.');
        const send = db.db.prepare('SELECT interactive FROM interactive_sends WHERE recipient = ?').get('919811100001');
        assert.equal(JSON.parse(send.interactive).buttons[0].payload, 'CONFIRM_ORDER_11');
        const rules = await call('GET', `/api/campaigns/${campaignId}/reply-rules`);
        assert.equal(rules.body.rules.length, 3);
    });

    it('a native tap records the click and runs tag / field / follow-up', async () => {
        const phone = '919811100001';
        const before = sentTo(phone).length;
        const id = 'wamid.tap.yes';
        await tap(phone, 'CONFIRM_ORDER_11', 'Yes, confirm', { id });
        assert.ok(await waitFor(() => sentTo(phone).length === before + 1), 'follow-up sent');
        // add_tag created the contact from the WhatsApp profile name.
        assert.equal(sentTo(phone).at(-1), 'Thanks Mira, you chose Yes, confirm.');
        const contact = db.db.prepare('SELECT * FROM contacts WHERE phone = ?').get(phone);
        assert.deepEqual(JSON.parse(contact.tags), ['interested']);
        assert.equal(JSON.parse(contact.custom_fields).status, 'Interested');
        const rows = clicks(campaignId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].option_id, 'YES');
        assert.equal(rows[0].payload, 'CONFIRM_ORDER_11');

        // Redelivery: no second click, no second follow-up.
        await tap(phone, 'CONFIRM_ORDER_11', 'Yes, confirm', { id });
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(clicks(campaignId).length, 1);
        assert.equal(sentTo(phone).length, before + 1);
    });

    it('typing "2" mutes the contact, and the next campaign skips them', async () => {
        const phone = '919811100002';
        await typed(phone, '2');
        assert.ok(await waitFor(() => clicks(campaignId).some((c) => c.recipient === phone && c.option_id === 'LATER')));
        assert.ok(db.bulkMutedPhones().has(phone));
        const res = await call('POST', '/api/campaign/start', {
            contacts: [{ name: 'Bo', phone }, { name: 'New', phone: '919811100099' }],
            template: 'Second wave {name}', onePerNumber: false,
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.skippedMuted, 1);
        assert.equal(res.body.queued, 1);
    });

    it('typing the title escalates: conversation open, bot paused, ticket created', async () => {
        const phone = '919811100003';
        await typed(phone, 'talk to agent');
        assert.ok(await waitFor(() => clicks(campaignId).some((c) => c.recipient === phone)));
        const conversation = db.db.prepare('SELECT * FROM conversations WHERE phone = ?').get(phone);
        assert.equal(conversation.status, 'open');
        assert.equal(conversation.bot_paused, 1);
        assert.equal(conversation.assigned_to, null);
        const ticket = db.db.prepare('SELECT * FROM tickets WHERE conversation_id = ?').get(conversation.id);
        assert.ok(ticket, 'ticket opened');
        assert.equal(ticket.category, 'campaign_reply');
    });

    it('opt_out rules add to opt_outs (set via PUT)', async () => {
        const put = await call('PUT', `/api/campaigns/${campaignId}/reply-rules`, {
            rules: [...RULES.filter((r) => r.optionId !== 'LATER'), { optionId: 'LATER', actions: [{ type: 'opt_out' }] }],
        });
        assert.equal(put.status, 200);
        const bad = await call('PUT', `/api/campaigns/${campaignId}/reply-rules`, { rules: [{ optionId: 'X', actions: [{ type: 'nope' }] }] });
        assert.equal(bad.status, 400);
        await tap('919811100004', 'LATER', 'Not now');
        assert.ok(await waitFor(() => db.getAllOptOuts().includes('919811100004')));
    });

    it('a non-answer falls through to the normal auto-replies', async () => {
        const phone = '919811100001';
        const before = sentTo(phone).length;
        await typed(phone, 'hi');
        assert.ok(await waitFor(() => sentTo(phone).length === before + 1), 'default hi auto-reply');
        assert.match(sentTo(phone).at(-1), /thank you for contacting us/i);
        assert.equal(clicks(campaignId).filter((c) => c.recipient === phone).length, 1);
    });

    it('a click with no matching rule is counted and still falls through', async () => {
        const phone = '919811100077';
        const res = await call('POST', '/api/messages', {
            recipient: phone, message: 'Rate us', interactive: { type: 'buttons', buttons: [{ id: 'GOOD', title: 'hi' }] },
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.ok(await waitFor(() => sentTo(phone).length === 1));
        await typed(phone, 'hi');
        assert.ok(await waitFor(() => sentTo(phone).length === 2), 'auto-reply still answers');
        assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM button_clicks WHERE recipient = ? AND option_id = 'GOOD'").get(phone).n, 1);
    });

    it('serves click analytics for the campaign', async () => {
        const res = await call('GET', `/api/campaigns/${campaignId}/clicks`);
        assert.equal(res.status, 200);
        assert.equal(res.body.total, 4);
        assert.equal(res.body.sent, 4);
        assert.equal(res.body.uniqueRecipients, 4);
        const byId = Object.fromEntries(res.body.byOption.map((o) => [o.id, o]));
        assert.equal(byId.LATER.count, 2);
        assert.equal(byId.YES.title, 'Yes, confirm');
        assert.equal(res.body.recent.length, 4);
        assert.ok(res.body.recent[0].at && res.body.recent[0].recipient);
        assert.ok(Array.isArray(res.body.recent.find((r) => r.optionId === 'YES').actions));
        const invalid = await call('POST', '/api/campaign/start', {
            contacts: [{ name: 'A', phone: '919811100050' }], template: 'x', interactive: { type: 'buttons', buttons: [] },
        });
        assert.equal(invalid.status, 400);
    });
});
