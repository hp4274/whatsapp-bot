/**
 * Bulk-sending fixes: a stop or restart mid-wait never strands a row QUEUED (or cancels one a restart should keep),
 * a quick bulk send never wipes another run or the one-offs waiting, a refused resume says so, a campaign's page
 * shows only its own run's live counters, the preview renders as the send does, and a national number that happens
 * to start with the country code is still prefixed.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { classifyPhone } from '../src/campaign/importer.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { applySendingPolicy } from '../src/policy/levels.js';
import { Status } from '../src/protocol.js';
import { TransportSendError } from '../src/transports/base.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-bulk-fixes-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !(await check())) await sleep(20);
    return check();
};
let file = 0;
const freshDb = () => new Database(path.join(tmp, `m${(file += 1)}.db`));
const people = (phones) => phones.map((phone, i) => ({ name: `P${i}`, phone }));
const statusOf = (db, messageId) => db.db.prepare('SELECT status FROM messages WHERE message_id = ?').get(messageId)?.status;

class FakeLive {
    realDelivery = true;
    supportsReceipts = false;
    supportsRegistrationCheck = false;
    sent = [];
    isConnected() { return true; }
    async sendMessage(to) {
        this.sent.push(to);
        return { providerId: `p${this.sent.length}`, status: Status.SENT };
    }
    getStatus() { return null; }
    async disconnect() {}
}

describe('a stop or restart while a row waits', () => {
    const qr = () => {
        const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, rateLimitPerSecond: 1000, humanTiming: true };
        delete config.misc;
        return config;
    };
    // Recipient daytime all day and no rest windows: only the level's gap holds the second send.
    const awake = (manager) => applySendingPolicy(manager.quota, {
        'sending.daytimeFrom': 0, 'sending.daytimeTo': 24, 'sending.skipQuietTime': true,
    }, () => ({ level: 11, at: new Date().toISOString() }));

    /** A QR manager whose first send went out and whose next row (returned) now waits out its gap. */
    async function pacing(type = 'campaign') {
        const db = freshDb();
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr());
        awake(manager);
        if (type === 'campaign') {
            manager.enqueueContacts(people(['919811110001', '919811110002']), 'Hi {name}', { campaignId: 'run' });
        } else {
            manager.enqueueJob({ recipient: '919811110001', text: 'first', messageType: type, priority: 2 });
            manager.enqueueJob({ recipient: '919811110002', text: 'second', messageType: type, priority: 2 });
        }
        manager.start();
        assert.ok(await until(() => transport.sent.length === 1 && manager.waitingUntil));
        const item = manager.current;
        assert.ok(item, 'the second row is in flight, waiting its gap');
        return { db, manager, transport, item };
    }

    it('cancels the paced row on a stop instead of leaving it QUEUED forever', async () => {
        const { db, manager, item } = await pacing();
        try {
            manager.stop('Stopped by operator');
            assert.ok(await until(() => statusOf(db, item.messageId) === Status.CANCELLED), statusOf(db, item.messageId));
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('keeps the paced row QUEUED on a shutdown, for the restart to pick up', async () => {
        const { db, manager, item } = await pacing();
        await manager.shutdown();
        assert.equal(statusOf(db, item.messageId), Status.QUEUED);
        db.close();
    });

    it('puts a paced quick send back in the queue on a run\'s stop: it is not the run\'s message', async () => {
        const { db, manager, item } = await pacing('transactional');
        try {
            let again = false;
            manager.on('event', (e) => {
                if (e.type === 'pacing' && manager.current?.messageId === item.messageId) again = true;
            });
            manager.stop('Stopped by operator');
            assert.ok(await until(() => again), 'taken again once the queue reopened, and waiting its gap');
            assert.equal(statusOf(db, item.messageId), Status.QUEUED);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('keeps a row waiting for its retry QUEUED on a shutdown (no real delivery)', async () => {
        const db = freshDb();
        const transport = {
            realDelivery: false, supportsReceipts: false, isConnected: () => true, attempts: 0,
            async sendMessage() {
                transport.attempts += 1;
                throw new TransportSendError('busy, try again', { retryable: true });
            },
            getStatus: () => null,
            async disconnect() {},
        };
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, maxRetries: 3,
            retryDelay: 30, retryJitter: 0, safetyEnabled: false };
        delete config.misc;
        const manager = new CampaignManager(db, transport, config);
        manager.enqueueContacts(people(['919811110003']), 'Hi {name}', { campaignId: 'retry' });
        const [row] = db.db.prepare("SELECT message_id FROM messages WHERE campaign_id = 'retry'").all();
        manager.start();
        assert.ok(await until(() => transport.attempts === 1));
        await sleep(50);
        await manager.shutdown();
        assert.equal(statusOf(db, row.message_id), Status.QUEUED, 'the restart sends it, not lost as CANCELLED');
        db.close();
    });
});

describe('quick bulk sends, resume and campaign pages over HTTP', () => {
    let app;
    let db;
    let server;
    let base;
    let state;
    let release = () => {};
    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    /** Sends wait until `release()`: a run stays mid-way for as long as a test needs. */
    const hold = () => {
        const transport = state.manager.transport;
        const send = transport.sendMessage;
        let open;
        const gate = new Promise((resolve) => { open = resolve; });
        transport.sendMessage = async (...args) => {
            await gate;
            return send.apply(transport, args);
        };
        release = () => {
            open();
            transport.sendMessage = send;
        };
    };
    const settled = () => until(() => !state.manager.queue.pending && !state.manager.inFlight);

    before(async () => {
        db = new Database(path.join(tmp, 'app.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 };
        delete config.misc;
        app = createTestApp({ db, dataDir: tmp, config });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        const tenant = app.locals.runtimeFor(1);
        state = tenant.runtimeFor(tenant.channels.getDefault()).state;
    });

    after(async () => {
        release();
        await closeApp(app);
        server?.close();
        db?.close();
    });

    it('a quick bulk send keeps waiting one-offs and refuses while another run is still in the queue', async () => {
        hold();
        try {
            // The first quick send is in flight (held); the second waits in the queue.
            state.manager.enqueueJob({ recipient: '919822220001', text: 'first quick', messageType: 'transactional', priority: 2 });
            assert.ok(await until(() => state.manager.inFlight === 1));
            const waiting = state.manager.enqueueJob({
                recipient: '919822220002', text: 'second quick', messageType: 'transactional', priority: 2,
            });

            const first = await api('POST', '/api/campaign/start', {
                contacts: people(['919822220011', '919822220012']), template: 'Hi {name}',
            });
            assert.equal(first.status, 200);
            assert.equal(first.body.queued, 2);
            assert.ok(state.manager.queue.snapshot().some((i) => i.messageId === waiting), 'the waiting quick send kept its place');

            const second = await api('POST', '/api/campaign/start', {
                contacts: people(['919822220021']), template: 'Hello {name}',
            });
            assert.equal(second.status, 409);
            assert.match(second.body.errors[0], /still sending another bulk send/);
            assert.equal(state.manager.campaignId, first.body.campaignId, 'the first run is untouched');

            const reminders = await api('POST', '/api/payment-reminders/send', {
                reminders: [{ name: 'Dev', phone: '919822220031', remaining: '100' }],
            });
            assert.equal(reminders.status, 409);
        } finally {
            release();
        }
        assert.ok(await settled());
        const rows = db.db.prepare("SELECT status FROM messages WHERE recipient LIKE '9198222200%'").all();
        assert.ok(rows.length >= 4);
        assert.ok(rows.every((r) => r.status === Status.SANDBOX), JSON.stringify(rows.map((r) => r.status)));
    });

    it('answers 409 with the reason when the engine refuses a resume of a saved campaign\'s run', async () => {
        hold();
        const manager = state.manager;
        const bulkPolicy = manager.bulkPolicy;
        let campaign;
        try {
            campaign = state.campaigns.create({ name: 'Capped', body: 'Hi {name}', audience: people(['919833330001', '919833330002']) });
            state.campaigns.start(campaign.id);
            // The business cap holds the run: the engine pauses it and the record stays `running` (store.hold).
            manager.queue.pause();
            manager.pausedByQuota = true;
            manager.resumeRefusal = 'Your business has used its monthly cap.';
            manager.bulkPolicy = () => ({ capRemaining: () => ({ left: 0 }) });
            assert.equal(state.campaigns.get(campaign.id).status, 'running');

            const res = await api('POST', '/api/campaign/resume');
            assert.equal(res.status, 409);
            assert.match(res.body.errors[0], /monthly cap/);
            assert.equal(manager.queue.isPaused, true);
        } finally {
            manager.bulkPolicy = bulkPolicy;
            manager.resumeRefusal = null;
            manager.pausedByQuota = false;
            if (campaign) state.campaigns.cancel(campaign.id);
            release();
        }
        assert.ok(await settled());
    });

    it('shows a campaign\'s live counters only while the engine holds its own run', async () => {
        hold();
        let a;
        let b;
        try {
            a = state.campaigns.create({ name: 'Alpha', body: 'Hi {name}', audience: people(['919844440001', '919844440002']) });
            b = state.campaigns.create({ name: 'Beta', body: 'Hi {name}', audience: people(['919844440011']) });
            state.campaigns.start(a.id);
            // Beta reads `running` (left from before a restart) while the engine sends Alpha.
            db.db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(b.id);

            const own = await api('GET', `/api/campaigns/${a.id}/stats`);
            assert.equal(own.status, 200);
            assert.ok(own.body.live, 'Alpha is the run the engine holds');
            const other = await api('GET', `/api/campaigns/${b.id}/stats`);
            assert.equal(other.status, 200);
            assert.equal(other.body.live, null, 'not Alpha\'s numbers under Beta');
            const paused = await api('POST', `/api/campaigns/${b.id}/pause`);
            assert.equal(paused.status, 200);
            assert.equal(paused.body.stats, null);
        } finally {
            if (b) state.campaigns.cancel(b.id);
            if (a) state.campaigns.cancel(a.id);
            release();
        }
        assert.ok(await settled());
    });

    it('previews the text exactly as the send renders it', async () => {
        const campaign = state.campaigns.create({
            name: 'Preview', body: 'Hi {name}, your code {coupon}  is ready',
            audience: [{ name: 'Asha', phone: '919855550001' }],
        });
        const res = await api('POST', `/api/campaigns/${campaign.id}/preview`, {});
        assert.equal(res.status, 200);
        assert.equal(res.body.previews[0].preview, 'Hi Asha, your code is ready');
        assert.deepEqual(res.body.missing, ['coupon'], 'the blank is still reported');
    });
});

describe('a country code on a number without +', () => {
    it('India: 91 + 10 digits stays, a 10-digit national number (even one starting 91) gets 91', () => {
        assert.equal(classifyPhone('919876543210', { countryCode: '91' }).phone, '919876543210');
        assert.equal(classifyPhone('9876543210', { countryCode: '91' }).phone, '919876543210');
        assert.equal(classifyPhone('9198765432', { countryCode: '91' }).phone, '919198765432');
        assert.equal(classifyPhone('09876543210', { countryCode: '91' }).phone, '919876543210');
    });

    it('Singapore: 65 + 8 digits is not prefixed twice; an 8-digit national number is', () => {
        assert.equal(classifyPhone('6591234567', { countryCode: '65' }).phone, '6591234567');
        assert.equal(classifyPhone('91234567', { countryCode: '65' }).phone, '6591234567');
        assert.equal(classifyPhone('65123456', { countryCode: '65' }).phone, '6565123456', 'a national number starting 65');
    });

    it('a country without fixed lengths keeps the old rule', () => {
        assert.equal(classifyPhone('4915123456789', { countryCode: '49' }).phone, '4915123456789');
        assert.equal(classifyPhone('015123456789', { countryCode: '49' }).phone, '4915123456789');
    });
});
