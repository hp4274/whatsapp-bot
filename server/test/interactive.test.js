/**
 * Interactive messages (buttons / list / CTA) and what happens after a
 * campaign with buttons goes out: native Cloud API payloads, the numbered
 * fallback on WhatsApp Web / sandbox, recording sends, matching replies,
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
import { DEFAULTS, TRANSPORT_CLOUD_API } from '../src/config.js';
import { Database } from '../src/db.js';
import {
    InteractiveError, interactiveOptions, matchReply, normalizeInteractive, personalizeInteractive, renderFallbackText,
} from '../src/messaging/interactive.js';
import { campaignIdFromParam, normalizeReplyRules } from '../src/messaging/replies.js';
import { CloudApiTransport, interactivePayload, nativeInteractive, parseInboundPayload } from '../src/transports/cloudApi.js';
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
        assert.equal(text, '*Order 7*\n\nYour order is ready.\n\nReply with:\n1. Yes, confirm\n2. Not now\n3. Talk to agent\n\n_Reply STOP to opt out_');
        assert.equal(matchReply(p, { body: '1' }).id, 'YES');
        assert.equal(matchReply(p, { body: '2.' }).id, 'LATER');
        assert.equal(matchReply(p, { body: 'talk to AGENT' }).id, 'AGENT');
        assert.equal(matchReply(p, { replyId: 'CONFIRM_ORDER_7' }).id, 'YES');
        assert.equal(matchReply(p, { body: '4' }), null);
        assert.equal(matchReply(p, { body: 'hello' }), null);
        assert.equal(interactiveOptions(normalizeInteractive(LIST)).length, 2);
        assert.match(renderFallbackText('Book', normalizeInteractive(LIST)), /1\. 9 AM - Front desk\n2\. 11 AM/);
    });
});

// ----------------------------------------------------------- Cloud API --
describe('Cloud API interactive payloads', () => {
    const transportWith = () => {
        const posts = [];
        const fetchImpl = async (url, init) => {
            if (String(url).endsWith('/media')) return new Response(JSON.stringify({ id: 'media.1' }), { status: 200 });
            posts.push(JSON.parse(init.body));
            return new Response(JSON.stringify({ messages: [{ id: `wamid.${posts.length}` }] }), { status: 200 });
        };
        const t = new CloudApiTransport({ ...DEFAULTS, phoneNumberId: '1', accessToken: 'x', requestTimeout: 5 }, { fetchImpl });
        t.connected = true;
        return { t, posts };
    };

    it('builds reply buttons with a text header and payload ids', () => {
        const p = personalizeInteractive(normalizeInteractive(BUTTONS), { order_id: '5' });
        const body = interactivePayload('919800000001', 'Ready?', p);
        assert.equal(body.type, 'interactive');
        assert.equal(body.interactive.type, 'button');
        assert.deepEqual(body.interactive.header, { type: 'text', text: 'Order 5' });
        assert.deepEqual(body.interactive.body, { text: 'Ready?' });
        assert.deepEqual(body.interactive.footer, { text: 'Reply STOP to opt out' });
        assert.deepEqual(body.interactive.action.buttons[0], { type: 'reply', reply: { id: 'CONFIRM_ORDER_5', title: 'Yes, confirm' } });
    });

    it('builds a list and a single url CTA; call/copy are not native', () => {
        const list = interactivePayload('1', 'Pick', personalizeInteractive(normalizeInteractive(LIST), {}));
        assert.equal(list.interactive.type, 'list');
        assert.equal(list.interactive.action.button, 'Pick a slot');
        assert.deepEqual(list.interactive.action.sections[0].rows[0], { id: 'AM9', title: '9 AM', description: 'Front desk' });
        const cta = normalizeInteractive({ type: 'cta', cta: [{ kind: 'url', title: 'Track', value: 'https://x.test/t/1' }] });
        const body = interactivePayload('1', 'Track it', cta);
        assert.equal(body.interactive.type, 'cta_url');
        assert.deepEqual(body.interactive.action, { name: 'cta_url', parameters: { display_text: 'Track', url: 'https://x.test/t/1' } });
        assert.equal(nativeInteractive(normalizeInteractive({ type: 'cta', cta: [{ kind: 'call', title: 'Call', value: '+1555' }] })), false);
        assert.equal(nativeInteractive(normalizeInteractive({ type: 'cta', cta: [{ kind: 'url', title: 'A', value: 'https://a' }, { kind: 'url', title: 'B', value: 'https://b' }] })), false);
    });

    it('sends call/copy CTAs as the text fallback', async () => {
        const { t, posts } = transportWith();
        const cta = normalizeInteractive({ type: 'cta', cta: [{ kind: 'copy', title: 'Coupon', value: 'SAVE10' }] });
        await t.sendMessage('919800000001', 'Here is your code', { interactive: cta });
        assert.equal(posts[0].type, 'text');
        assert.equal(posts[0].text.body, 'Here is your code\n\nCoupon: SAVE10');
    });

    it('uses media as the button header, and sends media before a list', async () => {
        const media = { buffer: Buffer.from('x'), filename: 'a.png', mimetype: 'image/png' };
        const { t, posts } = transportWith();
        await t.sendMessage('1', 'Look', { media, interactive: normalizeInteractive(BUTTONS) });
        assert.equal(posts.length, 1);
        assert.deepEqual(posts[0].interactive.header, { type: 'image', image: { id: 'media.1' } });

        const second = transportWith();
        const result = await second.t.sendMessage('1', 'Pick', { media, interactive: normalizeInteractive(LIST) });
        assert.equal(second.posts.length, 2);
        assert.equal(second.posts[0].type, 'image');
        assert.equal(second.posts[1].interactive.type, 'list');
        assert.equal(result.providerId, 'wamid.2');
    });

    it('parses button_reply, list_reply and template quick replies', () => {
        const wrap = (msg) => ({ entry: [{ changes: [{ value: { contacts: [], messages: [{ id: 'w1', from: '15551234567', timestamp: '1790771400', ...msg }] } }] }] });
        const [button] = parseInboundPayload(wrap({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'CONFIRM_ORDER_5', title: 'Yes, confirm' } } }));
        assert.equal(button.replyId, 'CONFIRM_ORDER_5');
        assert.equal(button.body, 'Yes, confirm');
        assert.equal(button.mediaType, null);
        const [list] = parseInboundPayload(wrap({ type: 'interactive', interactive: { type: 'list_reply', list_reply: { id: 'AM9', title: '9 AM' } } }));
        assert.equal(list.replyId, 'AM9');
        assert.equal(list.body, '9 AM');
        const [quick] = parseInboundPayload(wrap({ type: 'button', button: { text: 'Stop promos', payload: 'STOP_PROMO' } }));
        assert.equal(quick.replyId, 'STOP_PROMO');
        assert.equal(quick.body, 'Stop promos');
        const [text] = parseInboundPayload(wrap({ type: 'text', text: { body: 'hi' } }));
        assert.equal(text.replyId, undefined);
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
        assert.match(JSON.parse(line[3]), /Reply with:\n1\. Yes, confirm\n2\. Not now/);
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
describe('campaign replies end to end (Cloud API)', () => {
    let db; let app; let server; let base; let posts;

    before(async () => {
        posts = [];
        const fetchImpl = async (url, init) => {
            if (init?.method === 'POST') {
                posts.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${posts.length}` }] }), { status: 200 });
            }
            return new Response(JSON.stringify({ display_phone_number: '15550783881', verified_name: 'Acme', quality_rating: 'GREEN' }), { status: 200 });
        };
        db = new Database(path.join(tmp, 'e2e.db'));
        app = createApp({
            db,
            config: {
                ...DEFAULTS, transport: TRANSPORT_CLOUD_API, phoneNumberId: '1', accessToken: 'good', requestTimeout: 5,
                safetyEnabled: false, pacingMode: 'fixed', rateLimitPerSecond: 50, rateLimitBurst: 50,
            },
            deps: { fetchImpl },
        });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        const res = await call('POST', '/api/connection/connect');
        assert.equal(res.status, 200, JSON.stringify(res.body));
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
    const inbound = (from, msg) => call('POST', '/api/webhook', { entry: [{ changes: [{ value: {
        contacts: [{ wa_id: from, profile: { name: 'Mira' } }],
        messages: [{ id: msg.id ?? `wamid.in.${(n += 1)}.${Date.now()}`, from, timestamp: String(Math.floor(Date.now() / 1000)), ...msg }],
    } }] }] });
    const tap = (from, id, title, extra = {}) => inbound(from, { type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } }, ...extra });
    const typed = (from, body, extra = {}) => inbound(from, { type: 'text', text: { body }, ...extra });
    const sentTo = (to) => posts.filter((p) => p.to === to);
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
    it('starts a quick campaign with native buttons and persists reply rules', async () => {
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
        const first = sentTo('919811100001')[0];
        assert.equal(first.type, 'interactive');
        assert.equal(first.interactive.body.text, 'Hi Asha, order 11 is ready.');
        assert.equal(first.interactive.action.buttons[0].reply.id, 'CONFIRM_ORDER_11');
        const rules = await call('GET', `/api/campaigns/${campaignId}/reply-rules`);
        assert.equal(rules.body.rules.length, 3);
    });

    it('a native tap records the click and runs tag / field / follow-up', async () => {
        const phone = '919811100001';
        const before = sentTo(phone).length;
        const id = 'wamid.tap.yes';
        assert.equal((await tap(phone, 'CONFIRM_ORDER_11', 'Yes, confirm', { id })).status, 200);
        assert.ok(await waitFor(() => sentTo(phone).length === before + 1), 'follow-up sent');
        // add_tag created the contact from the WhatsApp profile name.
        assert.equal(sentTo(phone).at(-1).text.body, 'Thanks Mira, you chose Yes, confirm.');
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
        assert.match(sentTo(phone).at(-1).text.body, /thank you for contacting us/i);
        assert.equal(clicks(campaignId).filter((c) => c.recipient === phone).length, 1);
    });

    it('a click with no matching rule is counted and still falls through', async () => {
        const phone = '919811100077';
        const res = await call('POST', '/api/messages', {
            recipient: phone, message: 'Rate us', interactive: { type: 'buttons', buttons: [{ id: 'GOOD', title: 'hi' }] },
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.ok(await waitFor(() => sentTo(phone).length === 1));
        assert.equal(sentTo(phone)[0].interactive.action.buttons[0].reply.id, 'GOOD');
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
