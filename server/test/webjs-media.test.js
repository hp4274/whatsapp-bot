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

function makeTransport(onSend) {
    const sends = [];
    class FakeClient extends EventEmitter {
        info = { wid: { user: '15550000001' } };
        async initialize() { setImmediate(() => this.emit('ready')); }
        async destroy() {}
        async getNumberId(n) { return { _serialized: `${n}@c.us` }; }
        async sendMessage(chatId, content, options) {
            sends.push({ chatId, media: typeof content !== 'string', options });
            return onSend(content, options, sends.length);
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
