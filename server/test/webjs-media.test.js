/** WhatsApp Web media sends fall back instead of failing the whole message. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { DEFAULTS } from '../src/config.js';
import { Status } from '../src/protocol.js';
import { WhatsAppWebTransport } from '../src/transports/whatsappWeb.js';

const GETTER = "Data passed to getter must include an id property (it's how we memoize) but got undefined";

function makeTransport(onSend, extra = {}) {
    const sends = [];
    class FakeClient extends EventEmitter {
        getContactLidAndPhone = extra.getContactLidAndPhone;
        info = { wid: { user: '15550000001' } };
        async initialize() { setImmediate(() => this.emit('ready')); }
        async destroy() {}
        async getNumberId(n) { return { _serialized: `${n}@c.us` }; }
        async sendMessage(chatId, content, options) {
            sends.push({ chatId, content, media: typeof content !== 'string', options });
            return onSend(content, options, sends.length, this, chatId);
        }
    }
    const transport = new WhatsAppWebTransport({ ...DEFAULTS }, { createClient: async () => new FakeClient() });
    return { transport, sends };
}

const media = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-webjs-'));
    const filePath = path.join(dir, 'pic.png');
    fs.writeFileSync(filePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    return { filePath, filename: 'pic.png', mimetype: 'image/png' };
};

it('retries a failing image as a document', async () => {
    const { transport, sends } = makeTransport((content, options) => {
        if (typeof content !== 'string' && !options.sendMediaAsDocument) throw new Error(GETTER);
        return { id: { _serialized: 'wamid.doc' } };
    });
    await transport.connect();
    const result = await transport.sendMessage('919800000001', 'Hello', { media: media() });
    assert.equal(result.status, Status.SENT);
    assert.equal(result.providerId, 'wamid.doc');
    assert.match(result.detail, /document/);
    assert.equal(sends.length, 2);
});

it('delivers the text alone when the attachment will not go', async () => {
    const { transport, sends } = makeTransport((content) => {
        if (typeof content !== 'string') throw new Error(GETTER);
        return { id: { _serialized: 'wamid.text' } };
    });
    await transport.connect();
    const result = await transport.sendMessage('919800000002', 'Hello', { media: media() });
    assert.equal(result.status, Status.SENT);
    assert.equal(result.providerId, 'wamid.text');
    assert.match(result.detail, /could not attach the image/);
    assert.equal(sends.filter((s) => s.media).length, 2);
    assert.equal(sends.filter((s) => !s.media).length, 1);
});

it('sends a video as MessageMedia built from the stored bytes and MIME type', async () => {
    const { transport, sends } = makeTransport(() => ({ id: { _serialized: 'wamid.vid' } }));
    await transport.connect();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-webjs-'));
    const filePath = path.join(dir, 'med_0123456789ab_clip.mp4');
    const bytes = Buffer.from('00000018667479706d703432', 'hex');
    fs.writeFileSync(filePath, bytes);
    const result = await transport.sendMessage('919800000003', 'Watch', {
        media: { filePath, filename: 'clip.mp4', mimetype: 'video/mp4' },
    });
    assert.equal(result.providerId, 'wamid.vid');
    const { content, options } = sends[0];
    assert.equal(content.mimetype, 'video/mp4');
    assert.equal(content.filename, 'clip.mp4');
    assert.equal(content.data, bytes.toString('base64'));
    assert.equal(options.caption, 'Watch');
    assert.equal(options.sendSeen, false);
    assert.equal(options.sendMediaAsHd, undefined);
});

it('reads message ids WhatsApp Web now serializes as $1', async () => {
    const { transport } = makeTransport(() => ({ id: { $1: 'true_919800000004@c.us_ABC' } }));
    await transport.connect();
    const result = await transport.sendMessage('919800000004', 'Hello', { media: media() });
    assert.equal(result.providerId, 'true_919800000004@c.us_ABC');
});

it('confirms a send echoed back on the recipient LID, never on another recipient', async () => {
    const lids = { '919800000005@c.us': '111@lid', '919800000006@c.us': '222@lid' };
    const { transport } = makeTransport((content, options, n, client, chatId) => {
        // The other recipient's echo of the same text arrives first; it must not match.
        client.emit('message_create', { fromMe: true, to: '222@lid', body: 'Same text', id: { _serialized: 'wrong' } });
        client.emit('message_create', { fromMe: true, to: lids[chatId], body: 'Same text', id: { _serialized: 'right' } });
        return undefined; // WhatsApp Web returned no message
    }, { getContactLidAndPhone: async ([id]) => [{ lid: lids[id], pn: id }] });
    await transport.connect();
    const result = await transport.sendMessage('919800000005', 'Same text');
    assert.equal(result.providerId, 'right');
});
