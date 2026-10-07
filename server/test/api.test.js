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
import { DEFAULTS, TRANSPORT_CLOUD_API, TRANSPORT_SANDBOX, TRANSPORT_WEB_JS } from '../src/config.js';
import { Database } from '../src/db.js';
import { rowsToPaymentReminders } from '../src/paymentReminders.js';
import { Status } from '../src/protocol.js';
import { CloudApiTransport, parseStatusPayload } from '../src/transports/cloudApi.js';
import { SandboxTransport } from '../src/transports/sandbox.js';
import { TransportConnectionError, TransportSendError } from '../src/transports/base.js';
import { WhatsAppWebTransport, ackStatus } from '../src/transports/whatsappWeb.js';

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
    it('never hands the access token to the browser', async () => {
        await api('PUT', '/api/config', { accessToken: 'SECRET', transport: TRANSPORT_SANDBOX });
        const { body } = await api('GET', '/api/config');
        assert.equal(body.config.accessToken, '__set__');
        assert.notEqual(body.config.accessToken, 'SECRET');
    });

    it('keeps the stored token when the client echoes the placeholder', async () => {
        await api('PUT', '/api/config', { accessToken: '__set__', defaultCountryCode: '91' });
        const { body } = await api('GET', '/api/config');
        assert.equal(body.config.defaultCountryCode, '91');
        assert.equal(body.config.accessToken, '__set__');
    });

    it('rejects settings that cannot work', async () => {
        const { status, body } = await api('PUT', '/api/config', { rateLimitPerSecond: 0 });
        assert.equal(status, 400);
        assert.match(body.errors[0], /Rate limit/);
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
        assert.ok(await waitFor(() => db.history({ campaignId: body.campaignId }).length === 2));
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

describe('inbound webhook auto-replies', () => {
    const inboundPayload = (body = 'hi') => ({
        entry: [{ changes: [{ value: {
            contacts: [{ wa_id: '15551234567', profile: { name: 'Mira' } }],
            messages: [{ id: `wamid.in.${Date.now()}`, from: '15551234567',
                timestamp: '1790771400', type: 'text', text: { body } }],
        } }] }],
    });

    const startCloudApp = async ({ dbName, fetchImpl }) => {
        const cloudDb = new Database(path.join(tmp, dbName));
        const cloudApp = createApp({
            db: cloudDb,
            config: {
                ...DEFAULTS,
                transport: TRANSPORT_CLOUD_API,
                phoneNumberId: '1',
                accessToken: 'good',
                requestTimeout: 5,
            },
            deps: { fetchImpl },
        });
        const cloudServer = cloudApp.listen(0, '127.0.0.1');
        await new Promise((resolve) => cloudServer.once('listening', resolve));
        const cloudBase = `http://127.0.0.1:${cloudServer.address().port}`;
        return { cloudDb, cloudApp, cloudServer, cloudBase };
    };

    it('sends the default hi reply through the Cloud API transport send path', async () => {
        const sends = [];
        const fetchImpl = async (url, init) => {
            if (init?.method === 'POST') {
                sends.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ messages: [{ id: 'wamid.reply.1' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({
                display_phone_number: '15550783881',
                verified_name: 'Acme',
                quality_rating: 'GREEN',
            }), { status: 200 });
        };
        const { cloudDb, cloudApp, cloudServer, cloudBase } = await startCloudApp({
            dbName: 'webhook-hi.db',
            fetchImpl,
        });
        try {
            const res = await fetch(`${cloudBase}/api/webhook`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(inboundPayload('hi')),
            });
            assert.equal(res.status, 200);
            assert.ok(await waitFor(() => sends.length === 1), 'default hi rule should send one reply');
            assert.equal(sends[0].to, '15551234567');
            assert.equal(sends[0].type, 'text');
            assert.match(sends[0].text.body, /thank you for contacting us/);
            assert.equal(cloudDb.getInboundMessages({ sender: '15551234567' })[0].repliedRule, 'hi');
        } finally {
            await closeApp(cloudApp);
            await new Promise((resolve) => cloudServer.close(resolve));
            cloudDb.close();
        }
    });

    it('uses a keyword reply created through the auto-replies API', async () => {
        const sends = [];
        const fetchImpl = async (url, init) => {
            if (init?.method === 'POST') {
                sends.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ messages: [{ id: 'wamid.reply.dynamic' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({
                display_phone_number: '15550783881',
                verified_name: 'Acme',
                quality_rating: 'GREEN',
            }), { status: 200 });
        };
        const { cloudDb, cloudApp, cloudServer, cloudBase } = await startCloudApp({
            dbName: 'webhook-dynamic.db',
            fetchImpl,
        });
        try {
            const createRes = await fetch(`${cloudBase}/api/auto-replies`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    keyword: 'catalog',
                    matchType: 'CONTAINS',
                    replyBody: 'Here is the catalog link, {name}.',
                    cooldownSec: 0,
                }),
            });
            assert.equal(createRes.status, 201);
            const created = await createRes.json();
            assert.equal(created.rule.keyword, 'catalog');

            const webhookRes = await fetch(`${cloudBase}/api/webhook`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(inboundPayload('Can you send catalog?')),
            });
            assert.equal(webhookRes.status, 200);
            assert.ok(await waitFor(() => sends.length === 1), 'created keyword rule should send one reply');
            assert.equal(sends[0].to, '15551234567');
            assert.equal(sends[0].text.body, 'Here is the catalog link, Mira.');
            assert.equal(cloudDb.getInboundMessages({ sender: '15551234567' })[0].repliedRule, 'catalog');
        } finally {
            await closeApp(cloudApp);
            await new Promise((resolve) => cloudServer.close(resolve));
            cloudDb.close();
        }
    });

    it('does not send when the matching default rule is inactive', async () => {
        const sends = [];
        const fetchImpl = async (url, init) => {
            if (init?.method === 'POST') {
                sends.push(JSON.parse(init.body));
                return new Response(JSON.stringify({ messages: [{ id: 'wamid.reply.2' }] }), { status: 200 });
            }
            return new Response(JSON.stringify({
                display_phone_number: '15550783881',
                verified_name: 'Acme',
                quality_rating: 'GREEN',
            }), { status: 200 });
        };
        const { cloudDb, cloudApp, cloudServer, cloudBase } = await startCloudApp({
            dbName: 'webhook-inactive.db',
            fetchImpl,
        });
        try {
            const hi = cloudDb.getAutoReplies().find((rule) => rule.keyword === 'hi');
            cloudDb.saveAutoReply({
                id: hi.id,
                keyword: hi.keyword,
                matchType: hi.matchType,
                replyBody: hi.replyBody,
                isActive: false,
                cooldownSec: 0,
            });
            const res = await fetch(`${cloudBase}/api/webhook`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(inboundPayload('hi')),
            });
            assert.equal(res.status, 200);
            assert.ok(await waitFor(() => cloudDb.getInboundMessages({ sender: '15551234567' }).length === 1));
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(sends.length, 0);
            assert.equal(cloudDb.getInboundMessages({ sender: '15551234567' })[0].repliedRule, null);
        } finally {
            await closeApp(cloudApp);
            await new Promise((resolve) => cloudServer.close(resolve));
            cloudDb.close();
        }
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

    it('cloud API maps auth errors to a permanent connection failure', async () => {
        const transport = new CloudApiTransport(
            { ...DEFAULTS, phoneNumberId: '1', accessToken: 'bad', requestTimeout: 5 },
            { fetchImpl: async () => new Response(
                JSON.stringify({ error: { code: 190, message: 'Invalid OAuth token' } }),
                { status: 401 }) });
        await assert.rejects(() => transport.connect(), (err) => {
            assert.equal(err.retryable, false, 'a bad token is not worth retrying');
            return true;
        });
    });

    it('WhatsApp Web reports profile locks as controlled connection failures', async () => {
        class LockedClient extends EventEmitter {
            async initialize() {
                throw new Error('The browser is already running for C:\\Users\\harsh\\.whatsapp_sender_web\\wwebjs_auth\\session. Use a different userDataDir or stop the running browser first.');
            }

            async destroy() {}
        }

        const transport = new WhatsAppWebTransport(
            { ...DEFAULTS },
            { createClient: async () => new LockedClient() });

        await assert.rejects(() => transport.connect(), (err) => {
            assert.ok(err instanceof TransportConnectionError);
            assert.equal(err.code, 'WHATSAPP_WEB_PROFILE_LOCKED');
            assert.equal(err.retryable, false);
            assert.match(err.message, /profile is already in use/);
            return true;
        });
        assert.equal(transport.isConnected(), false);
    });

    it('WhatsApp Web reconnects after an unexpected disconnect without duplicate timers', async () => {
        const clients = [];
        const timers = [];
        let clearCalls = 0;

        class ReconnectClient extends EventEmitter {
            info = { wid: { user: `1555000000${clients.length + 1}` } };
            destroyed = false;

            async initialize() {
                setImmediate(() => this.emit('ready'));
            }

            async destroy() {
                this.destroyed = true;
            }
        }

        const transport = new WhatsAppWebTransport(
            { ...DEFAULTS },
            {
                createClient: async () => {
                    const client = new ReconnectClient();
                    clients.push(client);
                    return client;
                },
                setTimeoutFn: (fn, ms) => {
                    const timer = { fn, ms, cleared: false };
                    timers.push(timer);
                    return timer;
                },
                clearTimeoutFn: (timer) => {
                    clearCalls += 1;
                    timer.cleared = true;
                },
                randomFn: () => 0,
                reconnectBaseMs: 10,
                reconnectMaxMs: 50,
            });

        await transport.connect();
        assert.equal(transport.isConnected(), true);
        clients[0].emit('disconnected', 'NAVIGATION');
        clients[0].emit('disconnected', 'NAVIGATION');
        assert.equal(timers.length, 1, 'only one reconnect timer should be active');
        assert.equal(timers[0].ms, 10);

        timers[0].fn();
        assert.ok(await waitFor(() => clients.length === 2 && transport.isConnected()));
        assert.equal(clients[0].destroyed, true, 'the stale client should be destroyed before reconnect');
        assert.equal(transport.account, '15550000002');
        assert.equal(clearCalls, 0, 'firing the timer should not need manual clearing');
    });

    it('WhatsApp Web does not reconnect after auth/session invalidation', async () => {
        const timers = [];
        const states = [];

        class LogoutClient extends EventEmitter {
            info = { wid: { user: '15550000001' } };

            async initialize() {
                setImmediate(() => this.emit('ready'));
            }

            async destroy() {}
        }

        const client = new LogoutClient();
        const transport = new WhatsAppWebTransport(
            { ...DEFAULTS },
            {
                createClient: async () => client,
                setTimeoutFn: (fn, ms) => {
                    timers.push({ fn, ms });
                    return timers.at(-1);
                },
                reconnectBaseMs: 10,
                reconnectMaxMs: 50,
            });
        transport.events.on('state', (payload) => states.push(payload));

        await transport.connect();
        client.emit('disconnected', 'LOGOUT');

        assert.equal(transport.isConnected(), false);
        assert.equal(timers.length, 0, 'logout means the cached session is no longer reusable');
        assert.equal(states.at(-1).state, 'auth_failure');
        assert.match(states.at(-1).detail, /LOGOUT/);
    });

    it('connection API stays alive and exposes WhatsApp Web profile lock state', async () => {
        class LockedClient extends EventEmitter {
            async initialize() {
                throw new Error('The browser is already running for C:\\Users\\harsh\\.whatsapp_sender_web\\wwebjs_auth\\session. Use a different userDataDir or stop the running browser first.');
            }

            async destroy() {}
        }

        const lockedDb = new Database(path.join(tmp, 'locked.db'));
        const lockedApp = createApp({
            db: lockedDb,
            config: { ...DEFAULTS, transport: TRANSPORT_WEB_JS },
            deps: { createClient: async () => new LockedClient() },
        });
        const lockedServer = lockedApp.listen(0, '127.0.0.1');
        await new Promise((resolve) => lockedServer.once('listening', resolve));
        const lockedBase = `http://127.0.0.1:${lockedServer.address().port}`;
        try {
            const connectRes = await fetch(`${lockedBase}/api/connection/connect`, { method: 'POST' });
            assert.equal(connectRes.status, 409);
            const healthRes = await fetch(`${lockedBase}/api/health`);
            assert.equal(healthRes.status, 200);
            const stateRes = await fetch(`${lockedBase}/api/connection`);
            const state = await stateRes.json();
            assert.equal(state.connected, false);
            assert.equal(state.code, 'WHATSAPP_WEB_PROFILE_LOCKED');
            assert.match(state.error, /profile is already in use/);
        } finally {
            await closeApp(lockedApp);
            await new Promise((resolve) => lockedServer.close(resolve));
            lockedDb.close();
        }
    });

    it('auto-replies to WhatsApp Web LID inbound chats without number lookup', async () => {
        const sends = [];
        let getNumberIdCalls = 0;
        class LidClient extends EventEmitter {
            info = { wid: { user: '15550783881' } };

            async initialize() {
                setImmediate(() => this.emit('ready'));
            }

            async destroy() {}

            async getNumberId() {
                getNumberIdCalls += 1;
                return null;
            }

            async sendMessage(chatId, message) {
                sends.push({ chatId, message });
                return { id: { _serialized: 'web.reply.lid.1' } };
            }
        }

        const lidDb = new Database(path.join(tmp, 'web-lid-autoreply.db'));
        const client = new LidClient();
        const lidApp = createApp({
            db: lidDb,
            config: { ...DEFAULTS, transport: TRANSPORT_WEB_JS },
            deps: { createClient: async () => client },
        });
        const lidServer = lidApp.listen(0, '127.0.0.1');
        await new Promise((resolve) => lidServer.once('listening', resolve));
        const lidBase = `http://127.0.0.1:${lidServer.address().port}`;
        try {
            const connectRes = await fetch(`${lidBase}/api/connection/connect`, { method: 'POST' });
            assert.equal(connectRes.status, 200);

            client.emit('message', {
                id: { _serialized: 'web.in.lid.1' },
                from: '123456789012345@lid',
                body: 'hi',
                timestamp: '1790771400',
                _data: { notifyName: 'Mira' },
            });

            assert.ok(await waitFor(() => sends.length === 1, 6000),
                'LID inbound sender should receive the auto-reply');
            assert.equal(sends[0].chatId, '123456789012345@lid');
            assert.match(sends[0].message, /thank you for contacting us/);
            assert.equal(getNumberIdCalls, 0, 'direct chat ids must not go through getNumberId');
            assert.equal(lidDb.getInboundMessages({ sender: '123456789012345@lid' })[0].repliedRule, 'hi');
        } finally {
            await closeApp(lidApp);
            await new Promise((resolve) => lidServer.close(resolve));
            lidDb.close();
        }
    });

    it('auto-replies to own WhatsApp Web messages in a friend chat without recursion', async () => {
        const sends = [];
        class OwnMessageClient extends EventEmitter {
            info = { wid: { user: '15550783881' } };

            async initialize() {
                setImmediate(() => this.emit('ready'));
            }

            async destroy() {}

            async getNumberId(recipient) {
                assert.equal(recipient, '15551234567');
                return { _serialized: '15551234567@c.us' };
            }

            async sendMessage(chatId, message) {
                sends.push({ chatId, message });
                this.emit('message_create', {
                    id: { _serialized: `web.bot.${sends.length}` },
                    fromMe: true,
                    from: '15550783881@c.us',
                    to: chatId,
                    body: message,
                    timestamp: '1790771401',
                });
                return { id: { _serialized: `web.reply.${sends.length}` } };
            }
        }

        const ownDb = new Database(path.join(tmp, 'web-own-message-autoreply.db'));
        const client = new OwnMessageClient();
        const ownApp = createApp({
            db: ownDb,
            config: { ...DEFAULTS, transport: TRANSPORT_WEB_JS },
            deps: { createClient: async () => client },
        });
        const ownServer = ownApp.listen(0, '127.0.0.1');
        await new Promise((resolve) => ownServer.once('listening', resolve));
        const ownBase = `http://127.0.0.1:${ownServer.address().port}`;
        try {
            const connectRes = await fetch(`${ownBase}/api/connection/connect`, { method: 'POST' });
            assert.equal(connectRes.status, 200);

            client.emit('message_create', {
                id: { _serialized: 'web.own.1' },
                fromMe: true,
                from: '15550783881@c.us',
                to: '15551234567@c.us',
                body: 'hello',
                timestamp: '1790771400',
                _data: { notifyName: 'Mira' },
            });

            assert.ok(await waitFor(() => sends.length === 1, 6000),
                'own message in a friend chat should trigger one auto-reply');
            await new Promise((resolve) => setTimeout(resolve, 50));
            assert.equal(sends.length, 1, 'bot-sent message_create echo must not recurse');
            assert.equal(sends[0].chatId, '15551234567@c.us');
            assert.match(sends[0].message, /thank you for contacting us/);
            const messages = ownDb.getInboundMessages({ sender: '15551234567' });
            assert.equal(messages.length, 1);
            assert.equal(messages[0].body, 'hello');
            assert.equal(messages[0].repliedRule, 'hello');
        } finally {
            await closeApp(ownApp);
            await new Promise((resolve) => ownServer.close(resolve));
            ownDb.close();
        }
    });

    it('cloud API reports accepted sends as SENT', async () => {
        const transport = new CloudApiTransport(
            { ...DEFAULTS, phoneNumberId: '1', accessToken: 'good', requestTimeout: 5 },
            { fetchImpl: async (url, init) => (init?.method === 'POST'
                ? new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 })
                : new Response(JSON.stringify({ display_phone_number: '15550783881',
                    verified_name: 'Acme', quality_rating: 'GREEN' }), { status: 200 })) });
        const info = await transport.connect();
        assert.equal(info.realDelivery, true);
        const result = await transport.sendMessage('919876543210', 'hi');
        assert.deepEqual([result.providerId, result.status], ['wamid.X', Status.SENT]);
    });

    it('cloud API uploads media then sends a document payload', async () => {
        const bodies = [];
        const transport = new CloudApiTransport(
            { ...DEFAULTS, phoneNumberId: '1', accessToken: 'good', requestTimeout: 5 },
            { fetchImpl: async (url, init) => {
                if (String(url).endsWith('/media')) {
                    bodies.push({ url: String(url), body: init.body });
                    return new Response(JSON.stringify({ id: 'media.1' }), { status: 200 });
                }
                if (init?.method === 'POST') {
                    bodies.push({ url: String(url), body: JSON.parse(init.body) });
                    return new Response(JSON.stringify({ messages: [{ id: 'wamid.MEDIA' }] }), { status: 200 });
                }
                return new Response(JSON.stringify({ display_phone_number: '15550783881',
                    verified_name: 'Acme', quality_rating: 'GREEN' }), { status: 200 });
            } });
        await transport.connect();
        const result = await transport.sendMessage('919876543210', 'caption', {
            media: {
                filename: 'Brochure.pdf',
                mimetype: 'application/pdf',
                size: 12,
                buffer: Buffer.from('%PDF-1.4'),
            },
        });
        assert.equal(result.providerId, 'wamid.MEDIA');
        assert.equal(bodies[1].body.type, 'document');
        assert.deepEqual(bodies[1].body.document, {
            id: 'media.1',
            caption: 'caption',
            filename: 'Brochure.pdf',
        });
    });

    it('reads DELIVERED and READ out of a Meta webhook body', () => {
        const receipts = parseStatusPayload({
            entry: [{ changes: [{ value: { statuses: [
                { id: 'wamid.A', status: 'delivered' },
                { id: 'wamid.B', status: 'read' },
                { id: 'wamid.C', status: 'failed', errors: [{ title: 'undeliverable' }] },
                { id: 'wamid.D', status: 'something-new' },
            ] } }] }],
        });
        assert.equal(receipts.length, 3, 'an unknown status is dropped, never guessed');
        assert.deepEqual(receipts[0], { providerId: 'wamid.A', status: Status.DELIVERED, error: null });
        assert.equal(receipts[2].error, 'undeliverable');
    });

    it('maps WhatsApp Web ACKs without guessing at pending', () => {
        assert.equal(ackStatus(-1), Status.FAILED);
        assert.equal(ackStatus(0), null, 'pending reports nothing');
        assert.equal(ackStatus(1), Status.SENT);
        assert.equal(ackStatus(2), Status.DELIVERED);
        assert.equal(ackStatus(3), Status.READ);
    });
});
