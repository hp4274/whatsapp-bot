/**
 * WhatsApp channels: one tenant, many numbers, each behaving on its own.
 *
 * The point of these tests is Rule 2 - no message leaves without a resolved
 * tenant AND channel - so most of them try to send something they should not
 * be able to send.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CAPABILITIES, Channels, withinSendingWindow } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-channels-'));
let app;
let server;
let base;
let db;
let tokens = {};
let tenantB;

const call = async (token, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : { authorization: '' }),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text && json ? JSON.parse(text) : (text || null) };
};

/** Same call, but addressed to a specific channel. */
const onChannel = (token, id, method, url, body) =>
    call(token, method, url, body, { 'x-channel-id': String(id) });

before(async () => {
    db = new Database(path.join(tmp, 'c.db'));
    app = createTestApp({
        db,
        dataDir: tmp,
        config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const tenancy = app.locals.tenancy;
    tenantB = tenancy.createTenant('Business B', 'chan-b');
    tokens = {
        ownerA: sessionFor(app, { tenantId: 1, role: 'owner' }),
        agentA: sessionFor(app, { tenantId: 1, role: 'agent' }),
        ownerB: sessionFor(app, { tenantId: tenantB.id, role: 'owner' }),
    };
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('channel basics', () => {
    it('gives a fresh tenant exactly one default channel, seeded from its config', async () => {
        const { status, body } = await call(tokens.ownerA, 'GET', '/api/channels');
        assert.equal(status, 200);
        assert.equal(body.channels.length, 1);
        assert.equal(body.channels[0].isDefault, true);
        assert.equal(body.channels[0].status, 'active');
        assert.equal(body.channels[0].settings.transport, TRANSPORT_SANDBOX,
            'the channel adopts the config the tenant already had');
        assert.deepEqual(body.capabilities, CAPABILITIES);
    });

    it('lets one tenant own several numbers, each with its own settings', async () => {
        const made = await call(tokens.ownerA, 'POST', '/api/channels', {
            displayName: 'Support line',
            phoneNumber: '+911111111111',
            settings: { transport: TRANSPORT_SANDBOX, defaultCountryCode: '44' },
        });
        assert.equal(made.status, 201);
        const second = made.body.channel.id;
        assert.equal(made.body.channel.isDefault, false, 'the first channel stays the default');

        // Config edits land on the channel the request names, not on the other.
        await onChannel(tokens.ownerA, second, 'PUT', '/api/config', { defaultCountryCode: '44' });
        assert.equal((await onChannel(tokens.ownerA, second, 'GET', '/api/config')).body.config.defaultCountryCode, '44');
        assert.notEqual((await call(tokens.ownerA, 'GET', '/api/config')).body.config.defaultCountryCode, '44');
    });

    it('redacts provider credentials on the way out', async () => {
        const { body } = await call(tokens.ownerA, 'GET', '/api/channels');
        const target = body.channels[0];
        await call(tokens.ownerA, 'PUT', '/api/config', { accessToken: 'super-secret-token' });
        const after2 = await call(tokens.ownerA, 'GET', `/api/channels/${target.id}`);
        assert.equal(after2.body.channel.settings.accessToken, '********');
        assert.ok(!JSON.stringify(after2.body).includes('super-secret-token'));
    });

    it('moves the default, and refuses to delete the last channel', async () => {
        const list = (await call(tokens.ownerA, 'GET', '/api/channels')).body.channels;
        const second = list.find((c) => !c.isDefault);

        const moved = await call(tokens.ownerA, 'POST', `/api/channels/${second.id}/default`);
        assert.equal(moved.status, 200);
        const after2 = (await call(tokens.ownerA, 'GET', '/api/channels')).body.channels;
        assert.equal(after2.filter((c) => c.isDefault).length, 1, 'exactly one default at all times');
        assert.equal(after2.find((c) => c.isDefault).id, second.id);

        // Put it back, then prove the last one cannot go.
        await call(tokens.ownerA, 'POST', `/api/channels/${list[0].id}/default`);
        const removed = await call(tokens.ownerA, 'DELETE', `/api/channels/${second.id}`);
        assert.equal(removed.status, 200);
        const last = (await call(tokens.ownerA, 'GET', '/api/channels')).body.channels;
        assert.equal(last.length, 1);
        assert.equal((await call(tokens.ownerA, 'DELETE', `/api/channels/${last[0].id}`)).status, 409);
    });
});

describe('channel isolation', () => {
    it('does not let one tenant see or address another tenant\'s channel', async () => {
        const mine = (await call(tokens.ownerA, 'GET', '/api/channels')).body.channels[0];
        const theirs = (await call(tokens.ownerB, 'GET', '/api/channels')).body.channels[0];
        assert.notEqual(mine.id, theirs.id);

        assert.equal((await call(tokens.ownerB, 'GET', `/api/channels/${mine.id}`)).status, 404);
        assert.equal((await call(tokens.ownerB, 'PATCH', `/api/channels/${mine.id}`, { status: 'disabled' })).status, 404);
        assert.equal((await call(tokens.ownerB, 'DELETE', `/api/channels/${mine.id}`)).status, 404);

        // Addressing someone else's channel by id is a 404, not someone else's data.
        assert.equal((await onChannel(tokens.ownerB, mine.id, 'GET', '/api/config')).status, 404);
        assert.equal(
            (await onChannel(tokens.ownerB, mine.id, 'POST', '/api/messages', { recipient: '+919876543210', message: 'x' })).status,
            404);
    });

    it('keeps message history apart per channel', async () => {
        const second = (await call(tokens.ownerA, 'POST', '/api/channels', {
            displayName: 'Second line', settings: { transport: TRANSPORT_SANDBOX },
        })).body.channel;

        await call(tokens.ownerA, 'POST', '/api/connection/connect');
        await onChannel(tokens.ownerA, second.id, 'POST', '/api/connection/connect');

        await call(tokens.ownerA, 'POST', '/api/messages', { recipient: '+919000000001', message: 'from default' });
        await onChannel(tokens.ownerA, second.id, 'POST', '/api/messages', { recipient: '+919000000002', message: 'from second' });

        const rows = db.forTenant(1).history({ limit: 50 });
        const second2 = rows.filter((r) => r.recipient.endsWith('9000000002'));
        assert.ok(second2.length > 0, 'the second channel recorded its send');

        const scoped = db.forTenant(1).history({ limit: 50, channelId: second.id });
        assert.ok(scoped.length > 0);
        assert.ok(scoped.every((r) => !r.recipient.endsWith('9000000001')),
            'a channel-scoped read never shows another channel\'s messages');

        await call(tokens.ownerA, 'DELETE', `/api/channels/${second.id}`);
    });

    it('runs each number on its own connection', async () => {
        const second = (await call(tokens.ownerA, 'POST', '/api/channels', {
            displayName: 'Idle line', settings: { transport: TRANSPORT_SANDBOX },
        })).body.channel;

        await call(tokens.ownerA, 'POST', '/api/connection/connect');
        assert.equal((await call(tokens.ownerA, 'GET', '/api/connection')).body.connected, true);
        assert.equal((await onChannel(tokens.ownerA, second.id, 'GET', '/api/connection')).body.connected, false,
            'connecting one number does not connect the other');

        await call(tokens.ownerA, 'DELETE', `/api/channels/${second.id}`);
    });
});

describe('channel controls', () => {
    it('stops a disabled channel from sending, immediately', async () => {
        const channel = (await call(tokens.ownerA, 'POST', '/api/channels', {
            displayName: 'To disable', settings: { transport: TRANSPORT_SANDBOX },
        })).body.channel;
        await onChannel(tokens.ownerA, channel.id, 'POST', '/api/connection/connect');
        assert.equal(
            (await onChannel(tokens.ownerA, channel.id, 'POST', '/api/messages', { recipient: '+919000000003', message: 'ok' })).status,
            200);

        const off = await call(tokens.ownerA, 'PATCH', `/api/channels/${channel.id}`, { status: 'disabled' });
        assert.equal(off.body.channel.status, 'disabled');

        const blocked = await onChannel(tokens.ownerA, channel.id, 'POST', '/api/messages',
            { recipient: '+919000000003', message: 'nope' });
        assert.equal(blocked.status, 409);
        assert.match(blocked.body.errors[0], /disabled/);

        await call(tokens.ownerA, 'PATCH', `/api/channels/${channel.id}`, { status: 'active' });
        await call(tokens.ownerA, 'DELETE', `/api/channels/${channel.id}`);
    });

    it('refuses traffic a channel is not enabled for', async () => {
        const channel = (await call(tokens.ownerA, 'POST', '/api/channels', {
            displayName: 'Campaigns only',
            settings: { transport: TRANSPORT_SANDBOX },
            capabilities: ['campaigns'],
        })).body.channel;
        assert.deepEqual(channel.capabilities, ['campaigns']);
        await onChannel(tokens.ownerA, channel.id, 'POST', '/api/connection/connect');

        const blocked = await onChannel(tokens.ownerA, channel.id, 'POST', '/api/messages',
            { recipient: '+919000000004', message: 'transactional' });
        assert.equal(blocked.status, 409);
        assert.match(blocked.body.errors[0], /transactional_messages/);

        await call(tokens.ownerA, 'PATCH', `/api/channels/${channel.id}`, { capabilities: CAPABILITIES });
        assert.equal(
            (await onChannel(tokens.ownerA, channel.id, 'POST', '/api/messages', { recipient: '+919000000004', message: 'now ok' })).status,
            200);

        await call(tokens.ownerA, 'DELETE', `/api/channels/${channel.id}`);
    });

    it('refuses to send outside the channel\'s own sending window', async () => {
        // A window that is closed right now, wherever "now" is.
        const channel = (await call(tokens.ownerA, 'POST', '/api/channels', {
            displayName: 'Night shift',
            settings: { transport: TRANSPORT_SANDBOX },
            timezone: 'UTC',
            businessHours: closedWindow(),
        })).body.channel;
        await onChannel(tokens.ownerA, channel.id, 'POST', '/api/connection/connect');

        const blocked = await onChannel(tokens.ownerA, channel.id, 'POST', '/api/messages',
            { recipient: '+919000000005', message: 'too late' });
        assert.equal(blocked.status, 409);
        assert.match(blocked.body.errors[0], /sending window/);

        // Reopening it lets the same message through.
        await call(tokens.ownerA, 'PATCH', `/api/channels/${channel.id}`, { businessHours: null });
        assert.equal(
            (await onChannel(tokens.ownerA, channel.id, 'POST', '/api/messages', { recipient: '+919000000005', message: 'in hours' })).status,
            200);

        await call(tokens.ownerA, 'DELETE', `/api/channels/${channel.id}`);
    });

    it('records channel administration in the audit log', async () => {
        const superToken = sessionFor(app, { role: 'super_admin' });
        const channel = (await call(tokens.ownerA, 'POST', '/api/channels', {
            displayName: 'Audited', settings: { transport: TRANSPORT_SANDBOX },
        })).body.channel;
        await call(tokens.ownerA, 'PATCH', `/api/channels/${channel.id}`, { status: 'disabled' });

        const logs = (await call(superToken, 'GET', '/api/admin/audit-logs')).body.logs;
        const actions = logs.filter((l) => String(l.target) === String(channel.id)).map((l) => l.action);
        assert.ok(actions.includes('channel.create'), 'creation is audited');
        assert.ok(actions.includes('channel.update'), 'status changes are audited');

        await call(tokens.ownerA, 'PATCH', `/api/channels/${channel.id}`, { status: 'active' });
        await call(tokens.ownerA, 'DELETE', `/api/channels/${channel.id}`);
    });

    it('lets an agent read channels but not reconfigure them', async () => {
        assert.equal((await call(tokens.agentA, 'GET', '/api/channels')).status, 200);
        assert.equal((await call(tokens.agentA, 'POST', '/api/channels', { displayName: 'Nope' })).status, 403);
    });
});

describe('routing and windows', () => {
    it('routes to the default channel, and refuses a capability the channel lacks', () => {
        const channels = new Channels(db.forTenant(1));
        const fallback = channels.route({});
        assert.equal(fallback.isDefault, true);

        const limited = channels.create({
            displayName: 'FAQ only', settings: { transport: TRANSPORT_SANDBOX }, capabilities: ['faq'],
        });
        assert.throws(() => channels.route({ channelId: limited.id, capability: 'campaigns' }), /not enabled/);
        assert.equal(channels.route({ channelId: limited.id, capability: 'faq' }).id, limited.id);

        channels.update(limited.id, { status: 'disabled' });
        assert.throws(() => channels.route({ channelId: limited.id }), /disabled/);
        assert.throws(() => channels.route({ channelId: 999999 }), /not found/);
        channels.remove(limited.id);
    });

    it('reads the sending window in the channel\'s own timezone', () => {
        const base2 = { timezone: 'UTC', businessHours: null };
        assert.equal(withinSendingWindow(base2), true, 'no window means always open');

        // 2026-01-05 is a Monday. 12:00 UTC is 17:30 in Kolkata.
        const noonUtc = new Date('2026-01-05T12:00:00Z');
        assert.equal(withinSendingWindow(
            { timezone: 'UTC', businessHours: { start: '09:00', end: '17:00' } }, noonUtc), true);
        assert.equal(withinSendingWindow(
            { timezone: 'Asia/Kolkata', businessHours: { start: '09:00', end: '17:00' } }, noonUtc), false,
        'the same instant is out of hours one timezone over');
        assert.equal(withinSendingWindow(
            { timezone: 'UTC', businessHours: { start: '09:00', end: '17:00', days: ['sat', 'sun'] } }, noonUtc), false,
        'Monday is not in a weekend-only window');
    });
});

/** Business hours that are guaranteed to be closed at this instant, in UTC. */
function closedWindow() {
    const hour = new Date().getUTCHours();
    const start = (hour + 2) % 24;
    // Keep the window inside one day so it cannot wrap back onto "now".
    return start + 1 <= 23
        ? { start: pad(start), end: pad(start + 1) }
        : { start: '00:00', end: '00:01' };
}

const pad = (h) => `${String(h).padStart(2, '0')}:00`;
