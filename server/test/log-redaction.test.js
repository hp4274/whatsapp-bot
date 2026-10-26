/** Section 4: logs never hold a message body, and phone numbers keep only their last 4 digits. */

import assert from 'node:assert/strict';
import { after, before, it } from 'node:test';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS } from '../src/config.js';
import { maskPhone, scrub, setSink } from '../src/observability/logger.js';
import { TransportSendError } from '../src/transports/base.js';

const lines = [];
const consoleLines = [];
const saved = { warn: console.warn, log: console.log, error: console.error };
before(() => {
    setSink((level, line) => lines.push(line));
    for (const name of ['warn', 'log', 'error']) console[name] = (...args) => consoleLines.push(args.join(' '));
});
after(() => {
    Object.assign(console, saved);
    setSink((level, line) => process.stdout.write(`${line}\n`));
});

it('masks phone numbers and redacts bodies by key and in free text', () => {
    assert.equal(maskPhone('+91 98123 45678'), '…5678');
    assert.equal(maskPhone('919812345678@s.whatsapp.net'), '…5678');
    const out = scrub({
        recipient: '+91 98123 45678', phone: 919812345678, body: 'Your OTP is 4411', text: 'Hi Asha', caption: 'pic',
        error: 'send to 919812345678@s.whatsapp.net failed', nested: { sender: '919812345678', messageText: 'x' },
        requestId: '12345678-1234-1234-1234-123456789012', at: '2026-10-26T10:00:00.000Z', channelId: 3, count: 12345678,
    });
    assert.equal(out.recipient, '…5678');
    assert.equal(out.phone, '…5678');
    for (const key of ['body', 'text', 'caption']) assert.equal(out[key], '[redacted]');
    assert.equal(out.nested.messageText, '[redacted]');
    assert.equal(out.nested.sender, '…5678');
    assert.equal(out.error, 'send to …5678@s.whatsapp.net failed');
    assert.equal(out.requestId, '12345678-1234-1234-1234-123456789012', 'ids and dates are not phone numbers');
    assert.equal(out.at, '2026-10-26T10:00:00.000Z');
    assert.equal(out.channelId, 3);
    assert.equal(out.count, 12345678, 'a plain count is not a phone');
});

it("a send path's log lines contain neither the body nor the full number", async () => {
    const phone = '919812345678';
    const body = 'Secret offer for Asha: code 7731';
    const store = { insert: (r) => r, updateStatus: () => {}, countSentBetween: () => 0 };
    const transport = {
        realDelivery: true,
        isConnected: () => true,
        sendMessage: async (recipient) => {
            throw new TransportSendError(`${recipient} could not be reached (+91 98123 45678)`, { retryable: false });
        },
    };
    const manager = new CampaignManager(store, transport, {
        ...DEFAULTS, pacingMode: 'fixed', dailyLimit: 0, rateLimitPerSecond: 50, rateLimitBurst: 10, maxRetries: 0,
    });
    manager.enqueueJob({ recipient: phone, text: body, messageType: 'auto_reply', priority: 1 });
    manager.start();
    try {
        for (let i = 0; i < 50 && manager.stats.failed === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
        assert.equal(manager.stats.failed, 1);
    } finally {
        await manager.shutdown();
    }
    const all = [...lines, ...consoleLines].join('\n');
    assert.match(all, /send failed/, 'the failure was logged');
    assert.match(all, /…5678/, 'with the last 4 digits');
    assert.equal(all.includes(phone), false, 'never the whole number');
    assert.equal(all.includes('98123 45678'), false);
    assert.equal(all.includes(body), false, 'never the body');
    assert.equal(all.includes('7731'), false);
});
