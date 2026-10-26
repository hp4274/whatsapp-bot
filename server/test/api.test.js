/**
 * The API and the engine end to end, over a real HTTP listener with a fake
 * transport: send, retry, one-message-per-number, history and the SSE feed.
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
import { rowsToPaymentReminders } from '../src/paymentReminders.js';
import { Status } from '../src/protocol.js';
import { SandboxTransport } from '../src/transports/sandbox.js';
import { TransportConnectionError, TransportSendError } from '../src/transports/base.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-api-'));
let server;
let base;
let db;
let app;

before(async () => {
    db = new Database(path.join(tmp, 'api.db'));
    const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000,
        retryDelay: 0.01, maxRetries: 1 };
    delete config.misc;
    app = createApp({ db, config });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await closeApp(app);   // stop the worker before the database goes away
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const api = async (method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};

// The auto-reply engine waits a human-like 2500-4500ms before replying, so a
// 4s default raced it and flaked roughly one run in three.
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
};

describe('config API', () => {
    it('drops the removed Cloud API settings and keeps the rest', async () => {
        await api('PUT', '/api/config', { accessToken: 'SECRET', defaultCountryCode: '91', transport: TRANSPORT_SANDBOX });
        const { body } = await api('GET', '/api/config');
        assert.equal(body.config.defaultCountryCode, '91');
        assert.equal(body.config.accessToken, undefined);
        assert.deepEqual(body.transports.includes('cloud_api'), false);
    });

    it('rejects settings that cannot work', async () => {
        // requestTimeout is the platform admin's now (ADMIN_CHANNEL_KEYS), so a bad transport stands in.
        const { status, body } = await api('PUT', '/api/config', { transport: 'carrier_pigeon' });
        assert.equal(status, 400);
        assert.match(body.errors[0], /Unknown transport/);
    });
});

describe('sending', () => {
    it('refuses to send before a transport is connected', async () => {
        const { status } = await api('POST', '/api/messages',
            { recipient: '+919876543210', message: 'hi' });
        assert.equal(status, 409);
    });

    it('rejects an invalid number before anything is queued', async () => {
        await api('POST', '/api/connection/connect');
        const { status, body } = await api('POST', '/api/messages',
            { recipient: 'nonsense', message: 'hi' });
        assert.equal(status, 400);
        assert.match(body.errors[0], /empty|not a number|E\.164/);
    });

    it('sends one message and records what the transport reported', async () => {
        const { status, body } = await api('POST', '/api/messages',
            { recipient: '+919876543210', message: 'Hello {name}', name: 'Rahul' });
        assert.equal(status, 200);
        assert.equal(body.message, 'Hello Rahul', 'the name must be substituted');
        assert.ok(await waitFor(() => db.get(body.messageId)?.status === Status.SANDBOX),
            'sandbox sends land as SANDBOX, never SENT');
    });

    it('returns multiple preview renders for spintax templates', async () => {
        const { body } = await api('POST', '/api/contacts/preview', {
            template: '{Hi|Hello} {name}, plan {plan|standard}',
            contact: { name: 'Rahul', extra: { plan: '' } },
        });
        assert.equal(body.previews.length, 3);
        assert.ok(body.previews.every((preview) =>
            /^(Hi|Hello) Rahul, plan standard$/.test(preview)));
    });

    it('uploads media and sends campaign attachments through sandbox', async () => {
        const form = new FormData();
        form.set('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'Brochure.pdf');
        const uploadRes = await fetch(`${base}/api/media/upload`, { method: 'POST', body: form });
        assert.equal(uploadRes.status, 201);
        const media = await uploadRes.json();
        assert.match(media.mediaId, /^med_/);
        assert.equal(media.filename, 'Brochure.pdf');

        const { body } = await api('POST', '/api/campaign/start', {
            contacts: [{ name: 'Media', phone: '919700000011' }],
            template: 'Here is your brochure, {name}',
            onePerNumber: true,
            mediaId: media.mediaId,
        });
        assert.equal(body.queued, 1);
    });

    it('accepts an mp4 video upload and caps images at 16 MB', async () => {
        const mp4 = Buffer.concat([Buffer.from('00000020667479706d703432', 'hex'), Buffer.alloc(64)]);
        const form = new FormData();
        form.set('file', new Blob([mp4], { type: 'video/mp4' }), 'clip.mp4');
        const res = await fetch(`${base}/api/media/upload`, { method: 'POST', body: form });
        assert.equal(res.status, 201);
        assert.equal((await res.json()).mimetype, 'video/mp4');

        const big = Buffer.alloc(17 * 1024 * 1024);
        Buffer.from('89504e470d0a1a0a', 'hex').copy(big);
        const bigForm = new FormData();
        bigForm.set('file', new Blob([big], { type: 'image/png' }), 'big.png');
        const bigRes = await fetch(`${base}/api/media/upload`, { method: 'POST', body: bigForm });
        assert.equal(bigRes.status, 413);
    });

    it('runs a campaign and skips a number it already messaged', async () => {
        const contacts = [
            { name: 'Rahul', phone: '919876543210' },   // messaged above (SANDBOX)
            { name: 'Priya', phone: '919812345678' },
            { name: 'Priya again', phone: '919812345678' },
        ];
        const { body } = await api('POST', '/api/campaign/start',
            { contacts, template: 'Hi {name}', onePerNumber: true });
        // SANDBOX does not count as messaged, so all three numbers are new;
        // the repeated number is what gets skipped.
        assert.equal(body.queued, 2);
        assert.equal(body.skipped, 1);
        assert.ok(await waitFor(async () => {
            const { body: stats } = await api('GET', '/api/campaign/stats');
            return stats.stats.processed >= 2;
        }));
    });

    it('imports payment reminder rows with common Excel headers', () => {
        const result = rowsToPaymentReminders([
            {
                'Full Name': 'Anika',
                Mobile: '9876543210',
                'Due Amount': 'Rs. 1,250',
                'Due Date': '2026-10-30',
                Message: 'Hi {name}, your balance is {remaining} by {due_date}.',
            },
            {
                Name: 'Broken',
                Mobile: '123',
                Remaining: '',
            },
        ], '91');
        assert.equal(result.reminders.length, 1);
        assert.equal(result.reminders[0].phone, '919876543210');
        assert.equal(result.reminders[0].remaining, 'Rs. 1,250');
        assert.equal(result.reminders[0].finalMessage, 'Hi Anika, your balance is Rs. 1,250 by 2026-10-30.');
        assert.match(result.errors[0], /remaining payment amount/);
    });

    it('uploads an Excel payment sheet and queues individualized reminders', async () => {
        const XLSX = await import('xlsx');
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.json_to_sheet([
            { Name: 'Isha', Phone: '9988776655', Remaining: '2500' },
            {
                Name: 'Dev',
                Phone: '9988776644',
                Remaining: '3100',
                Message: 'Hello {name}, please pay {remaining}.',
            },
        ]);
        XLSX.utils.book_append_sheet(workbook, sheet, 'Payments');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const form = new FormData();
        form.set('file', new Blob([buffer], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }), 'payments.xlsx');
        const uploadRes = await fetch(`${base}/api/payment-reminders/import`, {
            method: 'POST',
            body: form,
        });
        assert.equal(uploadRes.status, 200);
        const imported = await uploadRes.json();
        assert.equal(imported.reminders.length, 2);
        assert.match(imported.reminders[0].finalMessage, /Isha/);

        const { status, body } = await api('POST', '/api/payment-reminders/send', {
            reminders: imported.reminders,
        });
        assert.equal(status, 200);
        assert.equal(body.queued, 2);
        // Settled, not just written: the history test next compares two reads and a row still QUEUED would change between them.
        assert.ok(await waitFor(() => {
            const rows = db.history({ campaignId: body.campaignId });
            return rows.length === 2 && rows.every((r) => r.status === Status.SANDBOX);
        }));
        const records = db.history({ campaignId: body.campaignId });
        assert.ok(records.some((record) => record.message === 'Hello Dev, please pay 3100.'));
        assert.ok(records.some((record) => /Isha/.test(record.message) && /2500/.test(record.message)));
    });
});

describe('history API', () => {
    it('returns rows with a signature, and 204s when nothing changed', async () => {
        const first = await api('GET', '/api/history');
        assert.equal(first.status, 200);
        assert.ok(first.body.records.length > 0);
        const again = await api('GET', `/api/history?signature=${encodeURIComponent(first.body.signature)}`);
        assert.equal(again.status, 204, 'unchanged history must ship no rows');
    });

    it('filters by status', async () => {
        const { body } = await api('GET', '/api/history?status=SANDBOX');
        assert.ok(body.records.every((r) => r.status === Status.SANDBOX));
    });
});

describe('server-sent events', () => {
    it('pushes campaign events to the browser', async () => {
        const controller = new AbortController();
        const res = await fetch(`${base}/api/events`, { signal: controller.signal });
        const reader = res.body.getReader();
        const decoder = new TextDecoder();

        await api('POST', '/api/messages', { recipient: '+919777666555', message: 'stream me' });

        let seen = '';
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline && !seen.includes('"type":"stats"')) {
            const { value, done } = await reader.read();
            if (done) break;
            seen += decoder.decode(value, { stream: true });
        }
        controller.abort();
        assert.match(seen, /"type":"(message|stats|status)"/);
    });
});

describe('auto-reply on an inbound message', () => {
    // Played through the sandbox transport, as a real one hands a received message to the app.
    const inbound = (sender, body) => {
        const rt = app.locals.runtimeFor(1);
        rt.runtimeFor(rt.channels.getDefault()).state.transport.events.emit('inbound', {
            messageId: `wamid.api.${sender}`, sender, senderName: 'Mira', body,
        });
    };
    const repliesTo = (to) => db.db.prepare("SELECT message FROM messages WHERE recipient = ? AND direction = 'outbound'").all(to);

    it('does not send when the matching default rule is inactive', async () => {
        await api('POST', '/api/connection/connect');
        inbound('919822211111', 'hi');
        assert.ok(await waitFor(() => repliesTo('919822211111').length === 1), 'the active hi rule replies');

        const hi = db.getAutoReplies().find((rule) => rule.keyword === 'hi');
        db.saveAutoReply({
            id: hi.id, keyword: hi.keyword, matchType: hi.matchType, replyBody: hi.replyBody, isActive: false, cooldownSec: 0,
        });
        inbound('919822222222', 'hi');
        assert.ok(await waitFor(() => db.getInboundMessages({ sender: '919822222222' }).length === 1));
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(repliesTo('919822222222').length, 0);
        assert.equal(db.getInboundMessages({ sender: '919822222222' })[0].repliedRule, null);
    });
});

describe('transports', () => {
    it('sandbox writes to a file and reports SANDBOX, never SENT', async () => {
        const outbox = path.join(tmp, 'outbox.log');
        const transport = new SandboxTransport({ ...DEFAULTS }, outbox);
        await transport.connect();
        const result = await transport.sendMessage('919876543210', 'hi');
        assert.equal(result.status, Status.SANDBOX);
        assert.match(fs.readFileSync(outbox, 'utf8'), /919876543210/);
    });

    it('sandbox can be told to fail, so retries can be exercised', async () => {
        const transport = new SandboxTransport({ ...DEFAULTS }, path.join(tmp, 'fail.log'));
        await transport.connect();
        transport.failPrefix = '9199';
        await assert.rejects(() => transport.sendMessage('919900000000', 'hi'), TransportSendError);
    });
});
