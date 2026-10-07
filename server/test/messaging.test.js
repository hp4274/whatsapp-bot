/**
 * Phase 3: one dispatch pipeline.
 *
 * The claim under test is that campaigns, transactional sends and auto-replies
 * all land in the same queue, under the same pacing, retries and daily cap, and
 * that the checks a caller must not be able to skip - opt-out, capability,
 * idempotency - live below every caller rather than in each one.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { ErrorCode, normalizeError } from '../src/messaging/errors.js';
import { MESSAGE_TYPES, messageJob, priorityOf, uniqueKey } from '../src/messaging/job.js';
import { capabilityFor } from '../src/messaging/service.js';
import { MessageQueue, queueItem } from '../src/campaign/queue.js';
import { TransportConnectionError, TransportError } from '../src/transports/base.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-messaging-'));
let app;
let server;
let base;
let db;
let token;

const call = async (token2, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(token2 ? { authorization: `Bearer ${token2}` } : { authorization: '' }),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text && json ? JSON.parse(text) : (text || null) };
};

const waitFor = async (predicate, timeoutMs = 6000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
};

before(async () => {
    db = new Database(path.join(tmp, 'm.db'));
    app = createTestApp({
        db,
        dataDir: tmp,
        config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, safetyEnabled: false },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    token = sessionFor(app, { tenantId: 1, role: 'owner' });
    await call(token, 'POST', '/api/connection/connect');
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the message job', () => {
    it('refuses to exist without a tenant and a channel', () => {
        const ok = { tenantId: 1, channelId: 1, recipient: '919876543210', text: 'hi' };
        assert.ok(messageJob(ok));
        assert.throws(() => messageJob({ ...ok, tenantId: undefined }), /tenantId/);
        assert.throws(() => messageJob({ ...ok, channelId: undefined }), /channelId/);
        assert.throws(() => messageJob({ ...ok, recipient: '' }), /recipient/);
        assert.throws(() => messageJob({ ...ok, text: '', media: null }), /text or media/);
        assert.throws(() => messageJob({ ...ok, messageType: 'telepathy' }), /messageType/);
    });

    it('derives the same key for the same content, so a redelivery is one message', () => {
        const spec = { tenantId: 1, channelId: 1, recipient: '919876543210', text: 'hello', messageType: 'auto_reply' };
        assert.equal(messageJob(spec).idempotencyKey, messageJob(spec).idempotencyKey);
        assert.notEqual(messageJob(spec).idempotencyKey, messageJob({ ...spec, text: 'other' }).idempotencyKey);
        assert.notEqual(messageJob(spec).idempotencyKey, messageJob({ ...spec, channelId: 2 }).idempotencyKey);
        assert.notEqual(uniqueKey(), uniqueKey(), 'uniqueKey is for traffic meant to repeat');
    });

    it('ranks a reply ahead of a campaign', () => {
        assert.ok(priorityOf('auto_reply') < priorityOf('campaign'));
        assert.ok(priorityOf('transactional') < priorityOf('campaign'));
        for (const type of MESSAGE_TYPES) assert.equal(typeof priorityOf(type), 'number');
        assert.equal(priorityOf('something-new'), priorityOf('campaign'), 'unknown types do not jump the queue');
    });

    it('maps each kind of traffic to the capability it needs', () => {
        assert.equal(capabilityFor('campaign'), 'campaigns');
        assert.equal(capabilityFor('auto_reply'), 'auto_replies');
        assert.equal(capabilityFor('workflow'), 'workflow_messages');
        assert.equal(capabilityFor('reminder'), 'transactional_messages');
        assert.equal(capabilityFor('transactional'), 'transactional_messages');
    });
});

describe('the queue', () => {
    it('serves a reply before a campaign backlog, and keeps FIFO within a priority', () => {
        const queue = new MessageQueue({ dedupe: false });
        for (let i = 0; i < 5; i++) {
            queue.put(queueItem({ recipient: `91900000000${i}`, message: `campaign ${i}`, messageType: 'campaign', priority: 4 }));
        }
        queue.put(queueItem({ recipient: '919111111111', message: 'reply', messageType: 'auto_reply', priority: 0 }));
        queue.put(queueItem({ recipient: '919222222222', message: 'receipt', messageType: 'transactional', priority: 1 }));

        assert.equal(queue.get().message, 'reply', 'the reply goes first');
        assert.equal(queue.get().message, 'receipt');
        // The campaign rows then drain in the order they were queued.
        for (let i = 0; i < 5; i++) assert.equal(queue.get().message, `campaign ${i}`);
        assert.equal(queue.get(), null);
    });

    it('counts what is waiting, by kind', () => {
        const queue = new MessageQueue({ dedupe: false });
        queue.put(queueItem({ recipient: '9191', message: 'a', messageType: 'campaign', priority: 4 }));
        queue.put(queueItem({ recipient: '9192', message: 'b', messageType: 'campaign', priority: 4 }));
        queue.put(queueItem({ recipient: '9193', message: 'c', messageType: 'auto_reply', priority: 0 }));
        assert.deepEqual(queue.pendingByType(), { auto_reply: 1, campaign: 2 });
    });
});

describe('provider errors', () => {
    it('speaks one vocabulary whatever the transport threw', () => {
        assert.equal(normalizeError(new TransportConnectionError('session closed', { retryable: true })).code, ErrorCode.DISCONNECTED);
        assert.equal(normalizeError(Object.assign(new Error('slow down'), { code: 131048 })).code, ErrorCode.RATE_LIMITED);
        assert.equal(normalizeError(Object.assign(new Error('bad token'), { code: 190 })).code, ErrorCode.AUTH);
        assert.equal(normalizeError(Object.assign(new Error('nope'), { code: 131026 })).code, ErrorCode.INVALID_RECIPIENT);
        assert.equal(normalizeError(new Error('Rate limit exceeded')).code, ErrorCode.RATE_LIMITED);
        assert.equal(normalizeError(new Error('socket hang up')).code, ErrorCode.PROVIDER_UNAVAILABLE);
        assert.equal(normalizeError(new Error('outside the 24 hour window')).code, ErrorCode.TEMPLATE_REQUIRED);
        assert.equal(normalizeError(new Error('Stopped by operator')).code, ErrorCode.CANCELLED);
        assert.equal(normalizeError(new Error('something odd')).code, ErrorCode.UNKNOWN);
        assert.equal(normalizeError(null).code, ErrorCode.UNKNOWN);
    });

    it('says which failures are worth retrying', () => {
        assert.equal(normalizeError(Object.assign(new Error('x'), { code: 131048 })).retryable, true);
        assert.equal(normalizeError(Object.assign(new Error('x'), { code: 190 })).retryable, false);
        assert.equal(normalizeError(new Error('socket hang up')).retryable, true);
        assert.equal(normalizeError(new Error('not a valid whatsapp number')).retryable, false);
        // An unrecognised TransportError keeps the transport's own verdict.
        assert.equal(normalizeError(new TransportError('weird', { retryable: true })).retryable, true);
        assert.equal(normalizeError(new TransportError('weird', { retryable: false })).retryable, false);
    });
});

describe('one pipeline', () => {
    it('accepts a transactional send once per idempotency key', async () => {
        const key = uniqueKey('test');
        const first = await call(token, 'POST', '/api/messages',
            { recipient: '+919000001001', message: 'only once' }, { 'idempotency-key': key });
        assert.equal(first.status, 200);

        const second = await call(token, 'POST', '/api/messages',
            { recipient: '+919000001001', message: 'only once' }, { 'idempotency-key': key });
        assert.equal(second.status, 409);
        assert.equal(second.body.reason, 'duplicate');
        assert.equal(second.body.messageId, first.body.messageId,
            'the retry gets the original message id back, not a second message');

        const rows = db.forTenant(1).history({ limit: 200 })
            .filter((r) => r.recipient.endsWith('9000001001'));
        assert.equal(rows.length, 1, 'exactly one row exists for that key');
    });

    it('stamps every row with what produced it', async () => {
        await call(token, 'POST', '/api/messages', { recipient: '+919000001002', message: 'typed' });
        const row = db.forTenant(1).history({ limit: 200 }).find((r) => r.recipient.endsWith('9000001002'));
        assert.equal(row.messageType, 'transactional');
        assert.equal(row.direction, 'outbound');
        assert.ok(row.idempotencyKey, 'a key is derived when the caller does not supply one');
        assert.ok(row.channelId, 'and the channel it went out on is recorded');
    });

    it('refuses to send to a number that opted out, whoever asks', async () => {
        await call(token, 'POST', '/api/optouts', { phone: '+919000001003', reason: 'test' });
        const blocked = await call(token, 'POST', '/api/messages',
            { recipient: '+919000001003', message: 'should not go' });
        assert.equal(blocked.status, 409);
        assert.equal(blocked.body.reason, 'opted_out');

        const rows = db.forTenant(1).history({ limit: 200 })
            .filter((r) => r.recipient.endsWith('9000001003'));
        assert.equal(rows.length, 0, 'a suppressed job never becomes a row');
        await call(token, 'DELETE', '/api/optouts/919000001003');
    });

    it('sends an auto-reply through the queue, not straight at the transport', async () => {
        await call(token, 'POST', '/api/auto-replies',
            { keyword: 'pipeline', matchType: 'EXACT', replyBody: 'queued reply', isActive: true, cooldownSec: 0 });

        const runtime = app.locals.runtimeFor(1).runtimeFor(
            app.locals.runtimeFor(1).channels.getDefault());
        await runtime.state.autoReply.handleInbound({
            messageId: 'inbound-pipeline-1', sender: '919000001004', senderName: 'Test', body: 'pipeline',
        });

        assert.ok(await waitFor(() => db.forTenant(1).history({ limit: 200 })
            .some((r) => r.recipient.endsWith('9000001004') && r.messageType === 'auto_reply')),
        'the reply was recorded as an auto_reply job');
    });

    it('answers the same inbound message once, however often it is redelivered', async () => {
        const runtime = app.locals.runtimeFor(1).runtimeFor(
            app.locals.runtimeFor(1).channels.getDefault());
        const inbound = {
            messageId: 'inbound-pipeline-2', sender: '919000001005', senderName: 'Test', body: 'pipeline',
        };
        await runtime.state.autoReply.handleInbound(inbound);
        // A second delivery of the same webhook, past the cooldown.
        runtime.state.autoReply.recentReplies.clear();
        await runtime.state.autoReply.handleInbound(inbound);

        await waitFor(() => false, 300);
        const rows = db.forTenant(1).history({ limit: 200 })
            .filter((r) => r.recipient.endsWith('9000001005'));
        assert.equal(rows.length, 1, 'the redelivery was deduped by idempotency key');
    });

    it('reports the queue', async () => {
        const { status, body } = await call(token, 'GET', '/api/queue');
        assert.equal(status, 200);
        const queue = body.queue;
        assert.equal(typeof queue.pending, 'number');
        assert.equal(typeof queue.inFlight, 'number');
        assert.equal(typeof queue.byType, 'object');
        assert.ok(queue.counts.accepted > 0, 'accepted jobs are counted');
        assert.ok(queue.counts.duplicate > 0, 'so are the ones deduped');
        assert.ok(queue.counts.suppressed > 0, 'and the ones an opt-out suppressed');
        assert.ok(queue.statuses, 'with a breakdown by delivery status');
        assert.equal(queue.channelId, 1);
    });
});
