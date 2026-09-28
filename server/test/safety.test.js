/**
 * Sending safety: pacing that widens with batch size, and the daily cap that
 * pauses a campaign instead of failing it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp, createApp } from '../src/app.js';
import { CampaignManager } from '../src/campaign/manager.js';
import {
    DailyQuota,
    dayEnd,
    dayStart,
    estimateSeconds,
    nextDelay,
    paceFor,
} from '../src/campaign/safety.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-safety-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const config = (overrides = {}) => {
    const base = { ...DEFAULTS, ...overrides };
    delete base.misc;
    return base;
};

describe('adaptive pacing', () => {
    it('slows down as the batch grows', () => {
        const small = paceFor(5, config());
        const medium = paceFor(120, config());
        const huge = paceFor(5000, config());
        assert.ok(small.maxSeconds < medium.maxSeconds, 'a bigger batch waits longer');
        assert.ok(medium.maxSeconds < huge.maxSeconds);
        assert.ok(small.minSeconds >= 1, 'even a tiny batch is spaced out');
    });

    it('varies the gap instead of using a fixed interval', () => {
        const pace = paceFor(100, config());
        const gaps = new Set();
        for (let i = 1; i <= 20; i += 1) {
            const { seconds, resting } = nextDelay(pace, i);
            if (resting) continue;
            assert.ok(seconds >= pace.minSeconds && seconds <= pace.maxSeconds,
                `${seconds} outside [${pace.minSeconds}, ${pace.maxSeconds}]`);
            gaps.add(Math.round(seconds * 1000));
        }
        assert.ok(gaps.size > 10, 'a predictable metronome is exactly what gets flagged');
    });

    it('sends the first message immediately, then paces', () => {
        const pace = paceFor(50, config());
        assert.equal(nextDelay(pace, 0).seconds, 0);
        assert.ok(nextDelay(pace, 1).seconds > 0);
    });

    it('takes a long rest every N messages', () => {
        const pace = paceFor(100, config({ restEvery: 10, restMinMinutes: 2, restMaxMinutes: 3 }));
        const rest = nextDelay(pace, 10);
        assert.equal(rest.resting, true);
        assert.ok(rest.seconds >= 120 && rest.seconds <= 180, `${rest.seconds}s`);
        assert.equal(nextDelay(pace, 11).resting, false);
    });

    it('honours an explicit override of the tier', () => {
        const pace = paceFor(1000, config({ minDelaySeconds: 3, maxDelaySeconds: 4 }));
        assert.deepEqual([pace.minSeconds, pace.maxSeconds], [3, 4]);
    });

    it('estimates how long a batch will take', () => {
        const pace = paceFor(100, config({ restEvery: 0 }));
        const estimate = estimateSeconds(100, pace);
        assert.equal(estimate.min, 99 * pace.minSeconds);
        assert.equal(estimate.max, 99 * pace.maxSeconds);
        assert.ok(estimate.typical > estimate.min && estimate.typical < estimate.max);
        assert.equal(estimateSeconds(1, pace).typical, 0, 'one message waits for nothing');
    });
});

describe('daily cap', () => {
    const db = new Database(path.join(tmp, 'quota.db'));
    after(() => db.close());

    const insert = (id, status, createdAt) => db.insert({
        messageId: id, recipient: '919876543210', message: 'hi', status, createdAt, updatedAt: createdAt,
    });

    it('counts only what really left the machine', () => {
        const today = new Date().toISOString();
        insert('a1', Status.SENT, today);
        insert('a2', Status.DELIVERED, today);
        insert('a3', Status.SANDBOX, today);
        insert('a4', Status.FAILED, today);
        insert('a5', Status.QUEUED, today);
        const quota = new DailyQuota(db, config({ dailyLimit: 10 }));
        assert.equal(quota.usedToday(), 2, 'SANDBOX, FAILED and QUEUED are not deliveries');
        assert.equal(quota.remaining(), 8);
        assert.equal(quota.exhausted(), false);
    });

    it('ignores yesterday, so the budget resets', () => {
        const yesterday = new Date(dayStart().getTime() - 3600 * 1000).toISOString();
        insert('b1', Status.SENT, yesterday);
        insert('b2', Status.READ, yesterday);
        const quota = new DailyQuota(db, config({ dailyLimit: 10 }));
        assert.equal(quota.usedToday(), 2, "yesterday's sends do not spend today's budget");
    });

    it('reports exhaustion and when it lifts', () => {
        const quota = new DailyQuota(db, config({ dailyLimit: 2 }));
        assert.equal(quota.exhausted(), true);
        const status = quota.status();
        assert.equal(status.remaining, 0);
        assert.equal(status.resetsAt, dayEnd().toISOString());
    });

    it('treats the limit as off when safety is disabled or the limit is 0', () => {
        assert.equal(new DailyQuota(db, config({ safetyEnabled: false, dailyLimit: 1 })).remaining(),
            Infinity);
        assert.equal(new DailyQuota(db, config({ dailyLimit: 0 })).remaining(), Infinity);
    });
});

describe('the engine under the cap', () => {
    const db = new Database(path.join(tmp, 'engine.db'));
    after(() => db.close());

    /** A transport that claims real delivery, so safety applies. */
    class FakeLive {
        name = 'fake live';
        realDelivery = true;
        supportsReceipts = false;
        sent = [];

        isConnected() {
            return true;
        }

        async sendMessage(recipient, message) {
            this.sent.push([recipient, message]);
            return { providerId: `p${this.sent.length}`, status: Status.SENT };
        }

        getStatus() {
            return null;
        }

        async disconnect() {}
    }

    it('pauses at the cap and leaves the rest QUEUED for tomorrow', async () => {
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, config({
            dailyLimit: 2,
            rateLimitPerSecond: 1000,
            pacingMode: 'fixed',   // pacing is covered above; this is about the cap
        }));
        const events = [];
        manager.on('event', (event) => events.push(event));

        manager.enqueueContacts(
            [{ name: 'A', phone: '919811111111' }, { name: 'B', phone: '919822222222' },
             { name: 'C', phone: '919833333333' }, { name: 'D', phone: '919844444444' }],
            'Hi {name}');
        manager.start();

        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !events.some((e) => e.type === 'quotaReached')) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        await manager.shutdown();

        assert.equal(transport.sent.length, 2, 'the cap is a ceiling, not a suggestion');
        assert.ok(events.some((e) => e.type === 'quotaReached'));
        assert.equal(manager.queue.isPaused || manager.queue.isStopped, true);
        const queued = db.history({ limit: 10 }).filter((r) => r.status === Status.QUEUED);
        assert.ok(queued.length >= 1, 'unsent rows stay QUEUED, not FAILED');
    });

    it('refuses to resume into an exhausted budget', () => {
        const manager = new CampaignManager(db, new FakeLive(), config({ dailyLimit: 1 }));
        manager.pausedByQuota = true;
        assert.equal(manager.resume(), false);
        manager.quota.config = config({ dailyLimit: 10_000 });
        assert.equal(manager.resume(), true);
    });
});

describe('safety API', () => {
    let server;
    let base;
    let db;
    let app;

    before(async () => {
        db = new Database(path.join(tmp, 'api.db'));
        app = createApp({ db, config: config({ transport: TRANSPORT_SANDBOX, dailyLimit: 50 }) });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
    });

    it('previews the pacing for a batch before it is started', async () => {
        const small = await (await fetch(`${base}/api/safety?contacts=5`)).json();
        const large = await (await fetch(`${base}/api/safety?contacts=800`)).json();
        assert.equal(small.safety.limit, 50);
        assert.equal(small.safety.remaining, 50);
        assert.ok(large.safety.maxSeconds > small.safety.maxSeconds);
        assert.ok(large.safety.estimateSeconds.typical > small.safety.estimateSeconds.typical);
    });

    it('tells the operator how much of a batch the daily budget covers', async () => {
        await fetch(`${base}/api/connection/connect`, { method: 'POST' });
        const contacts = Array.from({ length: 60 }, (_, i) => ({
            name: `C${i}`, phone: `9198${String(i).padStart(8, '0')}`,
        }));
        const response = await fetch(`${base}/api/campaign/start`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contacts, template: 'Hi {name}', onePerNumber: true }),
        });
        const body = await response.json();
        assert.equal(body.queued, 60);
        assert.equal(body.overQuota, 10, '60 queued against a 50 budget');
        assert.ok(body.safety.estimateSeconds.typical > 0);
        await fetch(`${base}/api/campaign/stop`, { method: 'POST' });
    });
});
