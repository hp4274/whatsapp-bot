/** Baileys transport: media, text, interactive fallback, inbound, receipts, reconnect - no network. */

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
import { BaileysTransport, extractContent, NATIVE_FLOW_NODE, toJid } from '../src/transports/baileys.js';

class FakeSock {
    ev = new EventEmitter();
    user = { id: '15550000001:7@s.whatsapp.net' };
    sends = [];
    ended = false;
    loggedOut = false;
    relays = [];
    constructor({ onWhatsApp, sendResult, relay } = {}) {
        this.onWhatsAppFn = onWhatsApp;
        this.sendResult = sendResult;
        this.relayFn = relay;
    }
    async relayMessage(jid, message, options) {
        this.relays.push({ jid, message, options });
        if (this.relayFn) return this.relayFn(jid, message, options);
        return options.messageId;
    }
    async sendMessage(jid, content) {
        this.sends.push({ jid, content });
        if (this.sendResult) return this.sendResult(jid, content, this.sends.length);
        return { key: { id: `BAE5${this.sends.length}`, remoteJid: jid, fromMe: true } };
    }
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
    assert.ok(content.video.equals(bytes));
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

const nativeOf = (relay) => relay.message.viewOnceMessage.message.interactiveMessage;
const buttonsOf = (relay) => nativeOf(relay).nativeFlowMessage.buttons.map((b) => [b.name, JSON.parse(b.buttonParamsJson)]);

it('sends reply buttons as a native-flow interactive message with the biz node', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const interactive = { type: 'buttons', header: 'Order 7', buttons: [{ id: 'YES', title: 'Yes' }, { id: 'NO', title: 'No' }], footer: 'Reply soon' };
    const result = await transport.sendMessage('919800000005', 'Confirm?', { interactive });
    assert.equal(sock().sends.length, 0);
    const [relay] = sock().relays;
    assert.equal(relay.jid, '919800000005@s.whatsapp.net');
    assert.equal(result.providerId, relay.options.messageId);
    assert.deepEqual(relay.options.additionalNodes, [NATIVE_FLOW_NODE]);
    assert.deepEqual(NATIVE_FLOW_NODE.content[0].content[0], { tag: 'native_flow', attrs: { v: '9', name: 'mixed' } });
    const msg = nativeOf(relay);
    assert.equal(msg.body.text, 'Confirm?');
    assert.equal(msg.header.title, 'Order 7');
    assert.equal(msg.footer.text, 'Reply soon');
    assert.deepEqual(buttonsOf(relay), [['quick_reply', { display_text: 'Yes', id: 'YES' }], ['quick_reply', { display_text: 'No', id: 'NO' }]]);
});

it('maps CTA kinds and list menus to cta_* and single_select buttons', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    await transport.sendMessage('919800000005', 'Links', { interactive: { type: 'cta', cta: [
        { kind: 'url', title: 'Open', value: 'https://x.test' }, { kind: 'call', title: 'Call', value: '+15551234' },
    ] } });
    await transport.sendMessage('919800000005', 'Code', { interactive: { type: 'cta', cta: [{ kind: 'copy', title: 'Copy', value: 'SAVE10' }] } });
    await transport.sendMessage('919800000005', 'Pick', { interactive: { type: 'list', list: { button: 'Slots', sections: [
        { title: 'Morning', rows: [{ id: 'A', title: '9 AM', description: 'Front desk' }] },
    ] } } });
    const [cta, copy, list] = sock().relays;
    assert.deepEqual(buttonsOf(cta), [
        ['cta_url', { display_text: 'Open', url: 'https://x.test', merchant_url: 'https://x.test' }],
        ['cta_call', { display_text: 'Call', phone_number: '+15551234' }],
    ]);
    assert.deepEqual(buttonsOf(copy), [['cta_copy', { display_text: 'Copy', copy_code: 'SAVE10' }]]);
    assert.deepEqual(buttonsOf(list), [['single_select', {
        title: 'Slots', sections: [{ title: 'Morning', rows: [{ id: 'A', title: '9 AM', description: 'Front desk' }] }],
    }]]);
});

it('sends media first, then the native buttons', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    await transport.sendMessage('919800000005', 'Look', { media: png(), interactive: { type: 'buttons', buttons: [{ id: 'Y', title: 'Yes' }] } });
    assert.equal(sock().sends.length, 1);
    assert.ok(Buffer.isBuffer(sock().sends[0].content.image));
    assert.equal(sock().sends[0].content.caption, undefined);
    assert.equal(nativeOf(sock().relays[0]).body.text, 'Look');
});

it('native:false sends the numbered text menu', async () => {
    const { transport, sock } = makeTransport();
    await transport.connect();
    const interactive = { type: 'buttons', native: false, buttons: [{ id: 'YES', title: 'Yes' }, { id: 'NO', title: 'No' }], footer: 'Reply soon' };
    await transport.sendMessage('919800000005', 'Confirm?', { interactive });
    assert.equal(sock().relays.length, 0);
    assert.equal(sock().sends[0].content.text, 'Confirm?\n\nReply 1 or 2:\n1. Yes\n2. No\n\n_Reply soon_');
});

it('falls back to the text menu when the native relay throws, without resending media', async () => {
    const { transport, sock } = makeTransport({ sockOptions: { relay: async () => { throw new Error('bad node'); } } });
    await transport.connect();
    const warn = console.warn;
    console.warn = () => {};
    try {
        const result = await transport.sendMessage('919800000005', 'Look', { media: png(), interactive: { type: 'buttons', buttons: [{ id: 'Y', title: 'Yes' }] } });
        assert.equal(sock().relays.length, 1);
        assert.equal(sock().sends.length, 2);
        assert.ok(Buffer.isBuffer(sock().sends[0].content.image));
        assert.deepEqual(sock().sends[1].content, { text: 'Look\n\nReply 1:\n1. Yes' });
        assert.equal(result.providerId, 'BAE52');
    } finally {
        console.warn = warn;
    }
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
    assert.ok(states.includes('disconnected') && states.includes('reconnecting'));
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
    const manager = new CampaignManager(db, transport, { ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed' });
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
