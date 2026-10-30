/** Baileys transport: media, text, the interactive text menu, inbound, receipts, reconnect, retries - no network. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';
import { BaileysTransport, extractContent, mediaCache, ownDeviceCopy, quietLogger, toJid } from '../src/transports/baileys.js';

class FakeSock {
    ev = new EventEmitter();
    user = { id: '15550000001:7@s.whatsapp.net' };
    sends = [];
    ended = false;
    loggedOut = false;
    constructor({ onWhatsApp, sendResult } = {}) {
        this.onWhatsAppFn = onWhatsApp;
        this.sendResult = sendResult;
    }
    async sendMessage(jid, content) {
        this.sends.push({ jid, content });
        if (this.sendResult) return this.sendResult(jid, content, this.sends.length);
        return { key: { id: `BAE5${this.sends.length}`, remoteJid: jid, fromMe: true } };
    }
    relays = [];
    async relayMessage(jid, message, opts) { this.relays.push({ jid, message, opts }); return opts.messageId; }
    async waUploadToServer() { return { mediaUrl: 'https://mmg.test/x', directPath: '/v/x' }; }
    async onWhatsApp(...jids) {
        return this.onWhatsAppFn ? this.onWhatsAppFn(...jids) : jids.map((jid) => ({ jid, exists: true }));
    }
    async logout() { this.loggedOut = true; }
    async end() { this.ended = true; }
}

const closeWith = (statusCode, message = 'closed') => ({
    connection: 'close',
    lastDisconnect: { error: { output: { statusCode, payload: { message } }, message }, date: new Date() },
});

function makeTransport({ first = 'open', sockOptions = {}, ...deps } = {}) {
    const socks = [];
    const transport = new BaileysTransport({ ...DEFAULTS }, {
        sessionDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-baileys-')),
        createSocket: async () => {
            const sock = new FakeSock(sockOptions);
            socks.push(sock);
            setImmediate(() => sock.ev.emit('connection.update', first === 'open' ? { connection: 'open' } : { qr: 'QR-DATA' }));
            return sock;
        },
        setTimeoutFn: (fn) => setTimeout(fn, 0),
        randomFn: () => 0,
        ...deps,
    });
    return { transport, socks, sock: () => socks[socks.length - 1] };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

const png = () => ({ filename: 'pic.png', mimetype: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });

it('connects, reports the account, and sends plain text', async () => {
    const { transport, sock } = makeTransport();
    const ready = [];
    transport.events.on('ready', (info) => ready.push(info));
    const info = await transport.connect();
    assert.equal(info.connected, true);
    assert.equal(info.account, '15550000001');
    assert.equal(transport.isConnected(), true);
    assert.equal(ready.length, 1);
    const result = await transport.sendMessage('+91 98000 00001', 'Hello');
    assert.equal(result.status, Status.SENT);
    assert.equal(result.providerId, 'BAE51');
    assert.deepEqual(sock().sends[0], { jid: '919800000001@s.whatsapp.net', content: { text: 'Hello' } });
    assert.equal(transport.getStatus('BAE51'), Status.SENT);
});

it('sends an image with caption and mimetype from the stored bytes', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const media = png();
    const result = await transport.sendMessage('919800000002', 'Look', { media });
    assert.equal(result.status, Status.SENT);
    const { content } = sock().sends[0];
    assert.equal(content.caption, 'Look');
    assert.equal(content.mimetype, 'image/png');
    assert.ok(Buffer.isBuffer(content.image) && content.image.equals(media.buffer));
    assert.equal(content.document, undefined);
});

it('sends a video from disk as a video message', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-baileys-'));
    const filePath = path.join(dir, 'med_0123456789ab_clip.mp4');
    const bytes = Buffer.from('00000018667479706d703432', 'hex');
    fs.writeFileSync(filePath, bytes);
    await transport.sendMessage('919800000003', 'Watch', { media: { filePath, filename: 'clip.mp4', mimetype: 'video/mp4' } });
    const { content } = sock().sends[0];
    assert.deepEqual(content.video, { url: filePath }); // by path, so Baileys' mediaCache can reuse the upload
    assert.equal(content.mimetype, 'video/mp4');
    assert.equal(content.caption, 'Watch');
});

it('sends a PDF as a document with its file name', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    await transport.sendMessage('919800000004', 'Invoice', {
        media: { filename: 'Invoice 42.pdf', mimetype: 'application/pdf', buffer: Buffer.from('%PDF-1.4') },
    });
    const { content } = sock().sends[0];
    assert.equal(content.document.toString(), '%PDF-1.4');
    assert.equal(content.mimetype, 'application/pdf');
    assert.equal(content.fileName, 'Invoice 42.pdf');
    assert.equal(content.caption, 'Invoice');
});

it('fails a missing attachment file without retrying', async () => {
    const { transport } = makeTransport();
    await transport.connect();
    await assert.rejects(
        transport.sendMessage('919800000004', 'x', { media: { filePath: '/nope/missing.png', mimetype: 'image/png' } }),
        (err) => err.retryable === false && /attachment file is missing/.test(err.message),
    );
});

it('sends 3gp and other non-mp4 video as a document, so it opens on every device', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    await transport.sendMessage('919800000003', 'Clip', { media: { filename: 'clip.3gp', mimetype: 'video/3gpp', buffer: Buffer.from('3gp') } });
    const { content } = sock().sends[0];
    assert.equal(content.video, undefined);
    assert.equal(content.document.toString(), '3gp');
    assert.equal(content.fileName, 'clip.3gp');
    assert.equal(content.caption, 'Clip');
});

it('sends reply buttons as the numbered text menu, never native buttons', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const interactive = { type: 'buttons', header: 'Order 7', buttons: [{ id: 'YES', title: 'Yes' }, { id: 'NO', title: 'No' }], footer: 'Reply soon' };
    const result = await transport.sendMessage('919800000005', 'Confirm?', { interactive });
    assert.equal(sock().sends.length, 1);
    assert.deepEqual(sock().sends[0].content, { text: '*Order 7*\n\nConfirm?\n\nReply 1 or 2:\n1. Yes\n2. No\n\n_Reply soon_' });
    assert.equal(result.providerId, 'BAE51');
    assert.equal(result.parts, undefined);
});

it('sends lists and CTAs as text, and media with the menu as its caption', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    await transport.sendMessage('919800000005', 'Links', { interactive: { type: 'cta', cta: [{ kind: 'url', title: 'Open', value: 'https://x.test' }] } });
    await transport.sendMessage('919800000005', 'Pick', { interactive: { type: 'list', list: { button: 'Slots', sections: [
        { title: 'Morning', rows: [{ id: 'A', title: '9 AM' }] },
    ] } } });
    await transport.sendMessage('919800000005', 'Look', { media: png(), interactive: { type: 'buttons', buttons: [{ id: 'Y', title: 'Yes' }] } });
    const [cta, list, media] = sock().sends.map((s) => s.content);
    assert.deepEqual(cta, { text: 'Links\n\n\u{1F517} Open: https://x.test' });
    assert.deepEqual(list, { text: 'Pick\n\n*Slots*\n\n_Morning_\n1. 9 AM' });
    assert.ok(Buffer.isBuffer(media.image));
    assert.equal(media.caption, 'Look\n\nReply 1:\n1. Yes');
});

it('a carousel sends the main text, then one captioned image per card, and counts every message as a part', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const media = { buffer: Buffer.from('png'), mimetype: 'image/png' };
    const buttons = (t) => [{ id: t, title: t }];
    const interactive = { type: 'carousel', carousel: { kind: 'reply', cards: [
        { mediaId: 'a', text: 'One', media, buttons: buttons('Buy') },
        { mediaId: 'b', text: 'Two', media, buttons: buttons('Buy') },
    ] } };
    const result = await transport.sendMessage('919800000005', 'Hello', { interactive });
    assert.equal(sock().sends.length, 3);
    assert.deepEqual(sock().sends[0].content, { text: 'Hello' });
    assert.equal(sock().sends[1].content.caption, 'One\n\nReply 1:\n1. Buy');
    assert.equal(sock().sends[2].content.caption, 'Two\n\nReply 2:\n2. Buy');
    // No album message: iPhones never showed photos tied to one.
    assert.ok(sock().sends.every((s) => !s.content.album && !s.content.albumParentKey));
    assert.equal(result.providerId, 'BAE51', 'the receipt is the first message');
    assert.equal(result.parts, 3);
});

it('a one-card carousel, or one with a document card, goes card by card', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const image = { buffer: Buffer.from('png'), mimetype: 'image/png' };
    const pdf = { buffer: Buffer.from('pdf'), mimetype: 'application/pdf', filename: 'menu.pdf' };
    const send = (cards) => transport.sendMessage('919800000005', 'Hello', { interactive: { type: 'carousel', carousel: { kind: 'reply', cards } } });
    assert.equal((await send([{ mediaId: 'a', text: 'One', media: image }])).parts, 2);
    assert.equal((await send([{ mediaId: 'a', text: 'One', media: image }, { mediaId: 'b', text: 'Menu', media: pdf }])).parts, 3);
    assert.ok(sock().sends.every((s) => !s.content.album && !s.content.albumParentKey));
});

it('a native carousel is one interactive message: each card an uploaded image, its text and its buttons', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const media = png();
    const interactive = { type: 'carousel', carousel: { kind: 'reply', cards: [
        { mediaId: 'a', text: 'One', media, buttons: [{ id: 'BUY_1', title: 'Buy' }] },
        { mediaId: 'b', text: 'Two', media, buttons: [{ id: 'BUY_2', title: 'Buy' }] },
    ] } };
    const result = await transport.sendMessage('919800000006', 'Our picks', { interactive, nativeCarousel: true });
    assert.equal(sock().sends.length, 0, 'nothing goes as separate messages');
    assert.equal(sock().relays.length, 1);
    const msg = sock().relays[0].message.interactiveMessage;
    assert.equal(msg.body.text, 'Our picks');
    const cards = msg.carouselMessage.cards;
    assert.equal(cards.length, 2);
    assert.equal(cards[1].body.text, 'Two');
    assert.ok(cards[0].header.imageMessage, 'each card carries its uploaded image');
    assert.equal(sock().relays[0].opts.additionalNodes?.[0]?.tag, 'biz', 'phones need the biz node to show it');
    assert.deepEqual(JSON.parse(cards[1].nativeFlowMessage.buttons[0].buttonParamsJson), { display_text: 'Buy', id: 'BUY_2' });
    assert.equal(result.parts, 1);
    assert.equal(result.providerId, sock().relays[0].opts.messageId);
});

it("the sender's own devices get the carousel unwrapped; other messages pass through", () => {
    const interactiveMessage = { body: { text: 'Our picks' } };
    const ctx = { deviceListMetadataVersion: 2 };
    const dsm = { deviceSentMessage: { destinationJid: 'x@s.whatsapp.net', message: { viewOnceMessage: { message: { messageContextInfo: ctx, interactiveMessage } } } } };
    const own = ownDeviceCopy(dsm);
    assert.equal(own.deviceSentMessage.message.interactiveMessage, interactiveMessage);
    assert.equal(own.deviceSentMessage.destinationJid, 'x@s.whatsapp.net');
    assert.equal(own.messageContextInfo, ctx);
    const plain = { conversation: 'hi' };
    assert.equal(ownDeviceCopy(plain), plain);
    const recipient = dsm.deviceSentMessage.message;
    assert.equal(ownDeviceCopy(recipient), recipient, 'recipients keep the wrapped message');
});

it('a carousel campaign on a QR number counts each part against the day', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-baileys-carousel-'));
    const db = new Database(path.join(tmp, 'm.db'));
    const { transport, sock } = makeTransport();
    await transport.connect();
    const manager = new CampaignManager(db, transport, { ...DEFAULTS, transport: 'baileys', safetyEnabled: false, rateLimitPerSecond: 1000, pacingMode: 'fixed' });
    // No override: sending.carouselImages is on by default, so one image per card, which every device shows.
    const card = (n) => {
        const filePath = path.join(tmp, `c${n}.png`);
        fs.writeFileSync(filePath, png().buffer);
        return { mediaId: `m${n}`, text: `Card ${n}`, media: { filePath, mimetype: 'image/png' }, cta: [{ title: 'Open', value: `https://x.test/${n}` }] };
    };
    try {
        manager.enqueueContacts([{ name: 'A', phone: '919855550201' }], 'Hi {name}', { interactive: { type: 'carousel', carousel: { kind: 'url', cards: [card(1), card(2)] } } });
        manager.start();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && manager.quota.usedToday() < 3) await new Promise((r) => setTimeout(r, 25));
        // Main text, then a plain image per card: every device shows them.
        const [, ...cards] = sock().sends.map((s) => s.content);
        assert.equal(sock().sends.length, 3);
        assert.ok(cards.every((c) => c.image && !c.albumParentKey));
        assert.match(cards[1].caption, /Card 2[\s\S]*https:\/\/x\.test\/2/);
        manager.quota.invalidate();
        assert.equal(manager.quota.usedToday(), 3);
    } finally {
        await manager.shutdown();
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

it('emits restricted on a 463 / 475 ack and on a reach-out timelock, at least 24h out', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const restricted = [];
    transport.events.on('restricted', (r) => restricted.push(r));
    const day = Date.now() + 24 * 3_600_000;
    sock().ev.emit('messages.update', [{ key: { id: 'A' }, update: { status: 0, messageStubParameters: ['463'] } }]);
    assert.equal(restricted.length, 1);
    assert.equal(restricted[0].code, '463');
    assert.ok(Math.abs(Date.parse(restricted[0].until) - day) < 5000);
    sock().ev.emit('messages.update', [{ key: { id: 'B' }, update: { status: 0, messageStubParameters: ['475'] } }]);
    assert.equal(restricted.length, 1, 'a burst of failed acks is one restriction');
    sock().ev.emit('messages.update', [{ key: { id: 'C' }, update: { status: 0, messageStubParameters: ['479'] } }]);
    const later = new Date(Date.now() + 3 * 86_400_000);
    sock().ev.emit('connection.update', { reachoutTimeLock: { isActive: true, timeEnforcementEnds: later } });
    assert.equal(restricted.length, 2);
    assert.equal(restricted[1].until, later.toISOString());
    sock().ev.emit('connection.update', { reachoutTimeLock: { isActive: false } });
    assert.equal(restricted.length, 2);
});

it('answers retry requests from the stored proto by id after a reconnect, undefined on a miss', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-baileys-proto-'));
    const db = new Database(path.join(tmp, 'm.db'));
    const factoryArgs = [];
    const { transport, socks, sock } = makeTransport({
        messageStore: db,
        sockOptions: { sendResult: (jid, content, n) => ({ key: { id: `BAE5${n}`, remoteJid: jid, fromMe: true }, message: { conversation: content.text } }) },
    });
    const create = transport.createSocket;
    transport.createSocket = async (args) => { factoryArgs.push(args); return create(args); };
    try {
        await transport.connect();
        await transport.sendMessage('919800000001', 'Keep me');
        sock().ev.emit('connection.update', closeWith(515, 'restart required'));
        await tick();
        await tick();
        assert.equal(socks.length, 2);
        const { getMessage } = factoryArgs[1];
        const msg = await getMessage({ remoteJid: '123@lid', id: 'BAE51' });
        assert.equal(msg.conversation, 'Keep me');
        assert.equal(await getMessage({ remoteJid: '919800000001@s.whatsapp.net', id: 'NOPE' }), undefined);
        assert.equal(factoryArgs[0].msgRetryCounterCache, factoryArgs[1].msgRetryCounterCache, 'one retry cache across reconnects');
        assert.equal(typeof factoryArgs[0].msgRetryCounterCache.get, 'function');
    } finally {
        await transport.disconnect();
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

it('prunes stored protos after 14 days', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-baileys-prune-'));
    const db = new Database(path.join(tmp, 'm.db'));
    try {
        db.saveSentProto('OLD', Buffer.from([1]));
        db.db.prepare("UPDATE sent_protos SET at = '2000-01-01T00:00:00.000Z' WHERE id = 'OLD'").run();
        db.saveSentProto('NEW', Buffer.from([2]));
        assert.equal(db.sentProto('OLD'), null);
        assert.deepEqual([...db.sentProto('NEW')], [2]);
    } finally {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

it('surfaces the retry-miss debug line as a warning', () => {
    const logger = quietLogger();
    const warn = console.warn;
    const lines = [];
    console.warn = (...args) => lines.push(args.join(' '));
    try {
        logger.debug({ jid: '1@s.whatsapp.net', id: 'X' }, 'recv retry request, but message not available');
        logger.debug({}, 'something else');
    } finally {
        console.warn = warn;
    }
    assert.deepEqual(lines, ['[baileys] recv retry request, but message not available 1@s.whatsapp.net X']);
});

it('refuses numbers that are not on WhatsApp, permanently', async () => {
    const { transport } = makeTransport({ sockOptions: { onWhatsApp: async (jid) => [{ jid, exists: false }] } });
    await transport.connect();
    await assert.rejects(transport.sendMessage('919800000006', 'Hi'), (err) => err.retryable === false && /not on WhatsApp/.test(err.message));
});

it('maps inbound text, captions and button/list replies', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const inbound = [];
    transport.events.on('inbound', (m) => inbound.push(m));
    const upsert = (messages) => sock().ev.emit('messages.upsert', { type: 'notify', messages });
    upsert([
        { key: { remoteJid: '919800000007@s.whatsapp.net', fromMe: false, id: 'M1' }, pushName: 'Asha', messageTimestamp: 1700000000, message: { conversation: 'hello' } },
        { key: { remoteJid: '919800000007@s.whatsapp.net', fromMe: true, id: 'M2' }, message: { conversation: 'mine' } },
        { key: { remoteJid: '120363@g.us', fromMe: false, id: 'M3' }, message: { conversation: 'group' } },
        { key: { remoteJid: '5551@lid', remoteJidAlt: '919800000008@s.whatsapp.net', fromMe: false, id: 'M4' }, message: { imageMessage: { caption: 'pic' } } },
        { key: { remoteJid: '919800000009@s.whatsapp.net', fromMe: false, id: 'M5' }, message: { buttonsResponseMessage: { selectedButtonId: 'YES', selectedDisplayText: 'Yes' } } },
        { key: { remoteJid: '919800000009@s.whatsapp.net', fromMe: false, id: 'M6' }, message: { listResponseMessage: { title: 'Slot A', singleSelectReply: { selectedRowId: 'SLOT_A' } } } },
        { key: { remoteJid: '919800000009@s.whatsapp.net', fromMe: false, id: 'M7' }, message: { protocolMessage: {} } },
        { key: { remoteJid: '919800000009@s.whatsapp.net', fromMe: false, id: 'M8' }, message: { viewOnceMessage: { message: { interactiveResponseMessage: { body: { text: 'Yes' }, nativeFlowResponseMessage: { name: 'quick_reply', paramsJson: '{"display_text":"Yes","id":"YES"}' } } } } } },
        { key: { remoteJid: '919800000009@s.whatsapp.net', fromMe: false, id: 'M9' }, message: { interactiveResponseMessage: { body: { text: '9 AM' }, nativeFlowResponseMessage: { name: 'single_select', paramsJson: '{"id":"SLOT_A"}' } } } },
        { key: { remoteJid: '919800000009@s.whatsapp.net', fromMe: false, id: 'M10' }, message: { templateButtonReplyMessage: { selectedId: 'T1', selectedDisplayText: 'Ok' } } },
    ]);
    sock().ev.emit('messages.upsert', { type: 'append', messages: [{ key: { remoteJid: '919800000001@s.whatsapp.net', id: 'H' }, message: { conversation: 'history' } }] });
    await tick();
    assert.deepEqual(inbound.map((m) => [m.messageId, m.sender, m.body, m.replyId, m.mediaType]), [
        ['M1', '919800000007', 'hello', null, null],
        ['M4', '919800000008', 'pic', null, 'image'],
        ['M5', '919800000009', 'Yes', 'YES', null],
        ['M6', '919800000009', 'Slot A', 'SLOT_A', null],
        ['M8', '919800000009', 'Yes', 'YES', null],
        ['M9', '919800000009', '9 AM', 'SLOT_A', null],
        ['M10', '919800000009', 'Ok', 'T1', null],
    ]);
    assert.equal(inbound[0].senderName, 'Asha');
    assert.equal(inbound[0].timestamp, '2023-11-14T22:13:20.000Z');
});

it('maps receipts to DELIVERED/READ/FAILED and ignores pending', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const receipts = [];
    transport.events.on('receipt', (r) => receipts.push([r.providerId, r.status, r.error]));
    sock().ev.emit('messages.update', [
        { key: { id: 'A' }, update: { status: 1 } },
        { key: { id: 'A' }, update: { status: 2 } },
        { key: { id: 'A' }, update: { status: 3 } },
        { key: { id: 'B' }, update: { status: 4 } },
        { key: { id: 'C' }, update: { status: 0 } },
    ]);
    sock().ev.emit('message-receipt.update', [
        { key: { id: 'D' }, receipt: { receiptTimestamp: 1 } },
        { key: { id: 'D' }, receipt: { readTimestamp: 2 } },
    ]);
    assert.deepEqual(receipts, [
        ['A', Status.SENT, null],
        ['A', Status.DELIVERED, null],
        ['B', Status.READ, null],
        ['C', Status.FAILED, 'Baileys reported a send failure'],
        ['D', Status.DELIVERED, null],
        ['D', Status.READ, null],
    ]);
    assert.equal(transport.getStatus('A'), Status.DELIVERED);
    assert.equal(transport.getStatus('B'), Status.READ);
});

it('a failed ack says which WhatsApp error it was', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const errors = [];
    transport.events.on('receipt', (r) => errors.push(r.error));
    sock().ev.emit('messages.update', [
        { key: { id: 'A' }, update: { status: 0, messageStubParameters: ['463'] } },
        { key: { id: 'B' }, update: { status: 0, messageStubParameters: ['421'] } },
    ]);
    assert.match(errors[0], /error 463.*messaged it before/);
    assert.equal(errors[1], 'WhatsApp rejected the message (error 421).');
});

it('reconnects with a fresh socket after a close (restart required after QR scan)', async () => {
    const { transport, socks, sock } = makeTransport();
    const states = [];
    transport.events.on('state', (s) => states.push(s.state));
    await transport.connect();
    sock().ev.emit('connection.update', closeWith(515, 'restart required'));
    assert.equal(transport.isConnected(), false);
    await tick();
    await tick();
    assert.equal(socks.length, 2);
    assert.equal(transport.isConnected(), true);
    assert.ok(states.includes('reconnecting') && !states.includes('disconnected'), '515 is a restart, not a drop');
    assert.equal(states.filter((s) => s === 'ready').length, 2);
});

it('stops and reports auth_failure when the session is logged out', async () => {
    const { transport, socks, sock } = makeTransport();
    const states = [];
    transport.events.on('state', (s) => states.push(s));
    await transport.connect();
    sock().ev.emit('connection.update', closeWith(401, 'logged out'));
    await tick();
    await tick();
    assert.equal(socks.length, 1);
    assert.equal(transport.isConnected(), false);
    const last = states.at(-1);
    assert.equal(last.state, 'auth_failure');
    assert.match(last.detail, /logged out/);
    await assert.rejects(transport.sendMessage('919800000001', 'x'), /reconnecting/);
});

it('does not fight another socket for the login (440 replaced): no reconnect, session kept', async () => {
    const { transport, socks, sock } = makeTransport();
    const states = [];
    transport.events.on('state', (s) => states.push(s));
    await transport.connect();
    fs.mkdirSync(transport.authDir, { recursive: true });
    sock().ev.emit('connection.update', closeWith(440, 'Stream Errored (conflict)'));
    await tick();
    await tick();
    assert.equal(socks.length, 1, 'no reconnect, or the two sockets kick each other forever');
    assert.equal(transport.replaced, true);
    assert.equal(transport.reconnectTimer, null);
    assert.equal(states.at(-1).state, 'error');
    assert.ok(fs.existsSync(transport.authDir), 'the session is still valid, so it is kept');

    await transport.connect(); // a manual Connect takes the number back
    assert.equal(transport.replaced, false);
    assert.equal(transport.isConnected(), true);
});

it('a banned number (403) stops for good: no reconnect, session kept, state banned', async () => {
    const { transport, socks, sock } = makeTransport();
    const states = [];
    transport.events.on('state', (s) => states.push(s));
    await transport.connect();
    fs.mkdirSync(transport.authDir, { recursive: true });
    sock().ev.emit('connection.update', closeWith(403, 'Connection Failure'));
    await tick();
    await tick();
    assert.equal(socks.length, 1, 'retrying a banned number only deepens the ban');
    assert.equal(transport.banned, true);
    assert.equal(transport.reconnectTimer, null);
    assert.equal(states.at(-1).state, 'banned');
    assert.match(states.at(-1).detail, /banned this number/);
    assert.ok(fs.existsSync(transport.authDir), 'a temporary ban can lift, so the session is kept');

    await transport.connect(); // a manual Connect tries again
    assert.equal(transport.banned, false);
});

it('a 403 during the first connect rejects at once, not after the 60s timeout', async () => {
    const { transport } = makeTransport();
    transport.createSocket = async () => {
        const sock = new FakeSock();
        setImmediate(() => sock.ev.emit('connection.update', closeWith(403, 'Connection Failure')));
        return sock;
    };
    await assert.rejects(transport.connect(), (err) => err.retryable === false && /banned this number/.test(err.message));
    assert.equal(transport.banned, true);
});

it('hands the QR to the caller and the events when the session is new', async () => {
    const { transport } = makeTransport({ first: 'qr' });
    const qrs = [];
    transport.events.on('qr', (qr) => qrs.push(qr));
    const info = await transport.connect();
    assert.equal(info.connected, false);
    assert.equal(info.qr, 'QR-DATA');
    assert.deepEqual(qrs, ['QR-DATA']);
});

it('logout unlinks the device and wipes the cached session', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    fs.mkdirSync(transport.authDir, { recursive: true });
    fs.writeFileSync(path.join(transport.authDir, 'creds.json'), '{}');
    await transport.logout();
    assert.equal(sock().loggedOut, true);
    assert.equal(sock().ended, true);
    assert.equal(fs.existsSync(transport.authDir), false);
    assert.equal(transport.isConnected(), false);
});

it('a campaign with an attachment reaches Baileys as an image with the personalised caption', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-baileys-campaign-'));
    const db = new Database(path.join(tmp, 'm.db'));
    const { transport, sock } = makeTransport();
    await transport.connect();
    // Sending levels would hold media until level 4; this is about the media path, not the levels.
    const manager = new CampaignManager(db, transport, { ...DEFAULTS, safetyEnabled: false, rateLimitPerSecond: 1000, pacingMode: 'fixed' });
    const media = { mediaId: 'med_aaaaaaaaaaaa', ...png(), size: 8, filePath: 'x' };
    manager.enqueueContacts([{ name: 'A', phone: '919855550101' }, { name: 'B', phone: '919855550102' }], 'Hi {name}', { media });
    manager.start();
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && sock().sends.length < 2) await new Promise((r) => setTimeout(r, 25));
    await manager.shutdown();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    assert.equal(sock().sends.length, 2);
    assert.deepEqual(sock().sends.map((s) => [s.jid, s.content.caption, s.content.mimetype, Buffer.isBuffer(s.content.image)]).sort(), [
        ['919855550101@s.whatsapp.net', 'Hi A', 'image/png', true],
        ['919855550102@s.whatsapp.net', 'Hi B', 'image/png', true],
    ]);
});

it('normalises recipients to jids and parses envelopes', () => {
    assert.equal(toJid('919800000001@c.us'), '919800000001@s.whatsapp.net');
    assert.equal(toJid('123@lid'), '123@lid');
    assert.equal(toJid('abc'), null);
    assert.deepEqual(extractContent({ ephemeralMessage: { message: { extendedTextMessage: { text: 'hi' } } } }), { body: 'hi', replyId: null, mediaType: null });
    assert.deepEqual(extractContent({ documentMessage: { caption: 'doc' } }), { body: 'doc', replyId: null, mediaType: 'document' });
    assert.deepEqual(extractContent({ interactiveResponseMessage: { body: { text: 'Yes' }, nativeFlowResponseMessage: { paramsJson: '{"id":"YES"}' } } }), { body: 'Yes', replyId: 'YES', mediaType: null });
});

it('hands back the provider id without waiting for the "paused" presence, and keeps a receipt that lands meanwhile', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    sock().sendPresenceUpdate = async (state) => {
        if (state !== 'paused') return;
        // The phone answers during the presence round trip; it hangs long enough to prove we do not wait.
        sock().ev.emit('messages.update', [{ key: { id: 'BAE51' }, update: { status: 3 } }]);
        await new Promise((resolve) => setTimeout(resolve, 300));
    };
    const started = Date.now();
    const result = await transport.sendMessage('+91 98000 00001', 'Hello', { typingMs: 1 });
    assert.equal(result.providerId, 'BAE51');
    assert.ok(Date.now() - started < 250, 'sendMessage must not wait on the paused presence');
    await tick();
    assert.equal(transport.getStatus('BAE51'), Status.DELIVERED, 'a late SENT must not overwrite the receipt');
});

it('tags a 429 as RATE_LIMITED, and 3 in an hour turn on the restricted brake', async () => {
    const limit = Object.assign(new Error('rate-overlimit'), { data: 429 });
    const { transport } = makeTransport({ sockOptions: { sendResult: () => { throw limit; } } });
    const restricted = [];
    transport.events.on('restricted', (r) => restricted.push(r));
    await transport.connect();
    for (let i = 0; i < 2; i += 1) {
        await assert.rejects(transport.sendMessage('919800000001', 'x', { registered: true }), (err) => err.code === 'RATE_LIMITED' && err.retryable);
    }
    assert.equal(restricted.length, 0);
    await assert.rejects(transport.sendMessage('919800000001', 'x', { registered: true }), /rate-overlimit/);
    assert.equal(restricted.length, 1);
    assert.equal(restricted[0].code, '429');
});

it('bad session (500) clears the stored login only on the 3rd in a row with no open between', async () => {
    const { transport, socks, sock } = makeTransport();
    const states = [];
    transport.events.on('state', (s) => states.push(s));
    await transport.connect();
    fs.mkdirSync(transport.authDir, { recursive: true });
    // Baileys also says 500 for network and stream errors: one alone reconnects and keeps the login.
    sock().ev.emit('connection.update', closeWith(500, 'bad session'));
    for (let i = 0; i < 5 && socks.length < 2; i += 1) await tick();
    await tick();
    assert.equal(socks.length, 2, 'reconnected');
    assert.equal(fs.existsSync(transport.authDir), true, 'login kept');
    // From here every new socket closes with 500 before it opens (the open above reset the count).
    transport.createSocket = async () => {
        const s = new FakeSock();
        socks.push(s);
        setImmediate(() => s.ev.emit('connection.update', closeWith(500, 'bad session')));
        return s;
    };
    sock().ev.emit('connection.update', closeWith(500, 'bad session'));
    for (let i = 0; i < 50 && states.at(-1)?.state !== 'auth_failure'; i += 1) await tick();
    await tick();
    assert.equal(socks.length, 4, 'the open socket and two failed reconnects');
    assert.equal(fs.existsSync(transport.authDir), false);
    assert.match(states.findLast((s) => s.state === 'auth_failure').detail, /scan/);
    assert.equal(transport.reconnectsLastHour, 2, 'only closes of an open socket are drops');
});

for (const [code, why] of [[411, 'multidevice mismatch']]) {
    it(`${why} (${code}) clears the stored login and asks for a re-scan instead of looping`, async () => {
        const { transport, socks, sock } = makeTransport();
        const states = [];
        transport.events.on('state', (s) => states.push(s));
        await transport.connect();
        fs.mkdirSync(transport.authDir, { recursive: true });
        sock().ev.emit('connection.update', closeWith(code, why));
        await tick();
        await tick();
        assert.equal(socks.length, 1, 'no reconnect');
        assert.equal(fs.existsSync(transport.authDir), false);
        assert.equal(states.at(-1).state, 'auth_failure');
        assert.match(states.at(-1).detail, /scan a new QR/);
        assert.equal(transport.reconnectsLastHour, 0, 'not a drop');
    });
}

it('counts socket drops per login in memory: over 8 in an hour is unstable; a fresh process starts at 0', async () => {
    const { transport, sock } = makeTransport();
    const unstable = [];
    transport.events.on('unstable', (u) => unstable.push(u));
    await transport.connect();
    const drop = async () => {
        sock().ev.emit('connection.update', closeWith(428, 'Connection Closed'));
        await tick();
        await tick();
    };
    for (let i = 0; i < 8; i += 1) await drop();
    assert.equal(transport.reconnectsLastHour, 8);
    assert.equal(unstable.length, 0, '8 is not more than 8');
    sock().ev.emit('connection.update', closeWith(515, 'restart required'));
    await tick();
    await tick();
    assert.equal(transport.reconnectsLastHour, 8, 'a 515 restart is not a drop');
    await drop();
    assert.deepEqual(unstable, [{ reconnects: 9 }]);
    // A new transport on the same login in this process keeps counting; a restarted process (a fresh module) starts at 0.
    const again = new BaileysTransport({ ...DEFAULTS }, { sessionDir: transport.sessionDir });
    assert.equal(again.reconnectsLastHour, 9);
    const restarted = await import(`../src/transports/baileys.js?restart=${Date.now()}`);
    assert.equal(new restarted.BaileysTransport({ ...DEFAULTS }, { sessionDir: transport.sessionDir }).reconnectsLastHour, 0);
    await transport.disconnect();
});

it('reports an unexpected logout, never our own', async () => {
    const { transport, sock } = makeTransport();
    const out = [];
    transport.events.on('logged_out', (e) => out.push(e));
    await transport.connect();
    sock().ev.emit('connection.update', closeWith(401, 'logged out'));
    await tick();
    assert.equal(out.length, 1);

    const own = makeTransport();
    own.transport.events.on('logged_out', (e) => out.push(e));
    await own.transport.connect();
    own.sock().logout = async function logout() { own.sock().ev.emit('connection.update', closeWith(401, 'logged out')); };
    await own.transport.logout();
    assert.equal(out.length, 1);
});

it('mediaCache returns an upload until it expires, and drops the oldest when full', () => {
    const { ttlMs, max } = mediaCache;
    try {
        mediaCache.set('image:/a.png', 'A');
        assert.equal(mediaCache.get('image:/a.png'), 'A');
        mediaCache.ttlMs = -1;
        mediaCache.set('image:/b.png', 'B');
        assert.equal(mediaCache.get('image:/b.png'), undefined);
        mediaCache.ttlMs = ttlMs;
        mediaCache.max = 1;
        mediaCache.set('image:/c.png', 'C');
        assert.equal(mediaCache.entries.size, 1);
        assert.equal(mediaCache.get('image:/c.png'), 'C');
    } finally {
        Object.assign(mediaCache, { ttlMs, max });
        mediaCache.entries.clear();
    }
});
