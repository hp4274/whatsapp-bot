/**
 * Numbers with no WhatsApp account.
 *
 * Claims under test: the engine asks the transport about this number and the
 * next ones in the queue in one batch, marks the unregistered ones
 * NOT_ON_WHATSAPP without sending, and they use no daily cap and count as no
 * failure; a failed or unsupported check sends as before; the transport's own
 * last-moment refusal lands on the same status; Baileys reads "missing from
 * the answer" as not registered only when the answer is unambiguous; and the
 * campaign funnel, CSV, retry-failed and the quick send all treat them apart.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignManager, NOT_ON_WHATSAPP_TEXT } from '../src/campaign/manager.js';
import { campaignKey } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';
import { BaileysTransport } from '../src/transports/baileys.js';
import { NOT_ON_WHATSAPP_CODE, TransportSendError } from '../src/transports/base.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-notwa-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return false;
};

const engineConfig = (extra = {}) => ({
    ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', retryDelay: 0.01, transport: TRANSPORT_SANDBOX,
    humanTiming: false, ...extra,
});

/** A real-delivery transport whose check says no to `unregistered`. */
function checkingTransport({ unregistered = [], check } = {}) {
    const transport = {
        name: 'fake', realDelivery: true, supportsReceipts: false, supportsRegistrationCheck: true,
        sends: [], checks: [],
        isConnected: () => true,
        async checkRegistered(phones) {
            transport.checks.push([...phones]);
            if (check) return check(phones);
            return new Map(phones.map((p) => [p, !unregistered.includes(p)]));
        },
        async sendMessage(to, text, opts) {
            transport.sends.push({ to, opts });
            return { providerId: `p${transport.sends.length}`, status: Status.SENT };
        },
        getStatus: () => null,
        async disconnect() {},
    };
    return transport;
}

const people = (...phones) => phones.map((phone, i) => ({ name: `P${i}`, phone }));

describe('the engine', () => {
    let db;
    before(() => { db = new Database(path.join(tmp, 'engine.db')); });
    after(() => db?.close());

    it('checks in one batch, skips unregistered numbers and spends no daily cap on them', async () => {
        const transport = checkingTransport({ unregistered: ['919700000001', '919700000002'] });
        // A cap of 2: the two real numbers fill it, the two without WhatsApp must not.
        const manager = new CampaignManager(db, transport, engineConfig({ dailyLimit: 2 }));
        manager.enqueueContacts(people('919700000001', '919700000002', '919700000003', '919700000004'),
            'Hi {name}', { campaignId: 'notwa-engine' });
        manager.start();
        assert.ok(await waitFor(() => manager.stats.processed === 4));
        await manager.shutdown();

        assert.equal(transport.checks.length, 1, 'one lookup for the whole queue');
        assert.equal(transport.checks[0].length, 4);
        assert.deepEqual(transport.sends.map((s) => s.to).sort(), ['919700000003', '919700000004']);
        assert.ok(transport.sends.every((s) => s.opts.registered === true), 'the transport is told not to ask again');
        const rows = db.history({ campaignId: 'notwa-engine' });
        const by = Object.fromEntries(rows.map((r) => [r.recipient, r]));
        assert.equal(by['919700000001'].status, Status.NOT_ON_WHATSAPP);
        assert.equal(by['919700000001'].error, NOT_ON_WHATSAPP_TEXT);
        assert.equal(by['919700000001'].attempt, 0, 'never attempted');
        assert.equal(by['919700000003'].status, Status.SENT);
        assert.equal(manager.stats.notOnWhatsapp, 2);
        assert.equal(manager.stats.failed, 0);
        assert.equal(manager.stats.successful, 2);
        assert.equal(manager.pausedByQuota, false, 'the cap was not reached by numbers that got nothing');
        assert.equal(manager.quota.usedToday(), 2);
    });

    it('sends as usual when the check fails or the transport has none', async () => {
        const failing = checkingTransport({ check: () => { throw new Error('usync timed out'); } });
        const manager = new CampaignManager(db, failing, engineConfig());
        manager.enqueueContacts(people('919700000011', '919700000012'), 'Hi {name}', { campaignId: 'notwa-failcheck' });
        manager.start();
        assert.ok(await waitFor(() => manager.stats.processed === 2));
        await manager.shutdown();
        assert.equal(failing.sends.length, 2);
        assert.equal(failing.checks.length, 1, 'an unknown answer is remembered, not re-asked per message');
        assert.ok(failing.sends.every((s) => !s.opts.registered));

        const plain = checkingTransport({ unregistered: ['919700000021'] });
        plain.supportsRegistrationCheck = false;
        const other = new CampaignManager(db, plain, engineConfig());
        other.enqueueContacts(people('919700000021'), 'Hi {name}', { campaignId: 'notwa-nocheck' });
        other.start();
        assert.ok(await waitFor(() => other.stats.processed === 1));
        await other.shutdown();
        assert.equal(plain.checks.length, 0);
        assert.equal(plain.sends.length, 1);
    });

    it('lands the transport\'s own refusal on the same status, without retrying', async () => {
        const transport = checkingTransport({ check: () => new Map() });
        transport.sendMessage = async (to) => {
            transport.sends.push({ to });
            throw new TransportSendError(`${to} is not on WhatsApp`, { retryable: false, code: NOT_ON_WHATSAPP_CODE });
        };
        const manager = new CampaignManager(db, transport, engineConfig({ maxRetries: 3 }));
        manager.enqueueContacts(people('919700000031'), 'Hi {name}', { campaignId: 'notwa-late' });
        manager.start();
        assert.ok(await waitFor(() => manager.stats.processed === 1));
        await manager.shutdown();
        assert.equal(transport.sends.length, 1);
        assert.equal(db.history({ campaignId: 'notwa-late' })[0].status, Status.NOT_ON_WHATSAPP);
        assert.equal(manager.stats.failed, 0);
    });

    it('skips numbers its history already found without WhatsApp, and never asks about them again', async () => {
        const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
        const row = (id, recipient, status, at) => db.db.prepare(
            `INSERT INTO messages (message_id, tenant_id, recipient, message, status, created_at, updated_at)
             VALUES (?, 1, ?, 'hi', ?, ?, ?)`).run(id, recipient, status, at, at);
        row('hist-1', '919700000041', Status.NOT_ON_WHATSAPP, ago(2));
        row('hist-2', '+919700000042', Status.NOT_ON_WHATSAPP, ago(2)); // stored with its "+"
        row('hist-3a', '919700000043', Status.NOT_ON_WHATSAPP, ago(3));
        row('hist-3b', '919700000043', Status.DELIVERED, ago(1)); // joined WhatsApp since
        row('hist-4', '919700000044', Status.NOT_ON_WHATSAPP, ago(40)); // too old to trust

        const transport = checkingTransport();
        const manager = new CampaignManager(db, transport, engineConfig());
        const result = manager.enqueueContacts(people('+91 97000 00041', '919700000042', '919700000043', '919700000044', '919700000045'),
            'Hi {name}', { campaignId: 'notwa-history' });
        assert.equal(result.skippedNotOnWhatsapp, 2);
        assert.equal(result.skipped, 2);
        assert.equal(result.queued, 3);
        manager.start();
        assert.ok(await waitFor(() => manager.stats.processed === 3));
        await manager.shutdown();
        assert.deepEqual(db.history({ campaignId: 'notwa-history' }).map((r) => r.recipient).sort(),
            ['919700000043', '919700000044', '919700000045'], 'no row for a skipped number');
        assert.ok(transport.checks.flat().every((p) => !['919700000041', '919700000042'].includes(p)), 'no lookup spent on them');
    });
});

describe('Baileys checkRegistered', () => {
    const baileys = (onWhatsApp) => {
        const transport = new BaileysTransport({ ...DEFAULTS }, { sessionDir: path.join(tmp, 'baileys') });
        transport.sock = { onWhatsApp };
        transport.connected = true;
        return transport;
    };

    it('reads a number missing from the answer as not on WhatsApp, in batches of 50', async () => {
        const calls = [];
        const phones = Array.from({ length: 60 }, (_, i) => `9196000${String(i).padStart(5, '0')}`);
        const transport = baileys(async (...jids) => {
            calls.push(jids.length);
            // Baileys 7: only the numbers that have an account come back.
            return jids.filter((j) => !j.startsWith('919600000001')).map((jid) => ({ jid, exists: true }));
        });
        const answers = await transport.checkRegistered(phones);
        assert.deepEqual(calls, [50, 10]);
        assert.equal(answers.get('919600000001'), false);
        assert.equal(answers.get('919600000000'), true);
        assert.equal(answers.size, 60);
    });

    it('leaves numbers unknown when WhatsApp answers for a jid it was not asked about, or fails', async () => {
        const rewritten = baileys(async () => [{ jid: '5511888887777@s.whatsapp.net', exists: true }]);
        const answers = await rewritten.checkRegistered(['5511988887777', '5511900000000']);
        assert.equal(answers.has('5511988887777'), false, 'cannot tell which one it was');
        assert.equal(answers.has('5511900000000'), false);

        const broken = baileys(async () => { throw new Error('boom'); });
        assert.equal((await broken.checkRegistered(['919600000099'])).size, 0);
    });
});

describe('campaigns and the quick send', () => {
    let app;
    let server;
    let base;
    let db;
    let transport;

    before(async () => {
        db = new Database(path.join(tmp, 'app.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX };
        delete config.misc;
        app = createTestApp({ db, config });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        const rt = app.locals.runtimeFor(1);
        transport = rt.runtimeFor(rt.channels.getDefault()).state.transport;
        transport.notOnWhatsappPrefix = '91955';
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
    });

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* CSV */ }
        return { status: res.status, body: parsed };
    };

    it('shows them apart in the funnel and the CSV, and never retries them', async () => {
        const audience = people('919550000001', '919550000002', '919660000003');
        const { id } = (await api('POST', '/api/campaigns', { name: 'Not on WA', body: 'Hi {name}', audience })).body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/start`)).status, 200);
        assert.ok(await waitFor(() => db.history({ campaignId: campaignKey(id) })
            .filter((r) => [Status.SANDBOX, Status.NOT_ON_WHATSAPP].includes(r.status)).length === 3));

        const { funnel, recipients, failures } = (await api('GET', `/api/campaigns/${id}/analytics`)).body;
        assert.equal(funnel.notOnWhatsapp, 2);
        assert.equal(funnel.failed, 0);
        assert.equal(funnel.sent, 1);
        assert.deepEqual(failures, []);
        assert.equal(recipients.find((r) => r.phone === '919550000001').status, Status.NOT_ON_WHATSAPP);
        const campaign = (await api('GET', `/api/campaigns/${id}`)).body.campaign;
        assert.equal(campaign.status, 'done');

        const csv = await api('GET', `/api/campaigns/${id}/export.csv`);
        assert.match(csv.body, /919550000001,P0,NOT_ON_WHATSAPP/);

        const retry = await api('POST', `/api/campaigns/${id}/retry-failed`);
        assert.equal(retry.status, 409, 'nothing failed: numbers without WhatsApp are not retried');
    });

    it('closes a later run whose whole audience is known not to be on WhatsApp, and says why', async () => {
        const audience = people('919550000001', '919550000002'); // found without WhatsApp by the test above
        const { id } = (await api('POST', '/api/campaigns', { name: 'Again', body: 'Hi {name}', audience })).body.campaign;
        const started = await api('POST', `/api/campaigns/${id}/start`);
        assert.equal(started.status, 200);
        assert.equal(started.body.skippedNotOnWhatsapp, 2);
        const campaign = (await api('GET', `/api/campaigns/${id}`)).body.campaign;
        assert.equal(campaign.status, 'done');
        assert.match(campaign.options.statusReason, /2 not on WhatsApp/);
    });

    it('refuses a quick send to a number that is not on WhatsApp', async () => {
        const refused = await api('POST', '/api/messages', { recipient: '919550000009', message: 'Hello' });
        assert.equal(refused.status, 422);
        assert.deepEqual(refused.body.errors, [NOT_ON_WHATSAPP_TEXT]);
        assert.equal(db.history({}).filter((r) => r.recipient === '919550000009').length, 0, 'nothing queued');

        const ok = await api('POST', '/api/messages', { recipient: '919660000009', message: 'Hello' });
        assert.equal(ok.status, 200);

        transport.checkFails = true;
        const unknown = await api('POST', '/api/messages', { recipient: '919770000009', message: 'Hello' });
        assert.equal(unknown.status, 200, 'a failed check sends as usual');
        transport.checkFails = false;
    });
});
