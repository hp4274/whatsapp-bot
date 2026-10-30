/**
 * Sending levels: how a QR (Baileys) number earns its bulk, new-chat and
 * hourly budgets from its own delivered history, the brakes that slow it, the
 * rest after linking, and the content its level allows. The sandbox keeps the
 * plain daily limit.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { LEVELS, levelFor } from '../src/campaign/humanize.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULT_SENDING, DailyQuota, OPT_OUT_TEXT, dayStart } from '../src/campaign/safety.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-levels-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const DAY = 86_400_000;
const HOUR = 3_600_000;
let file = 0;
const freshDb = () => new Database(path.join(tmp, `l${(file += 1)}.db`));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !check()) await sleep(20);
    return check();
};
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const qr = (extra = {}) => {
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, rateLimitPerSecond: 1000, pacingMode: 'fixed', humanTiming: false, retryDelay: 0.01, ...extra };
    delete config.misc;
    return config;
};
const codes = (allowance) => allowance.brakes.map((b) => b.code);
const people = (phones) => phones.map((phone, i) => ({ name: `P${i}`, phone }));
// The built-in levels 1-4 let every message of the day go to a new chat; this table keeps level 2 at 5 new chats
// of its 35, so the new-chat budget is what holds.
const fewNewChats = () => ({ ...DEFAULT_SENDING, levels: LEVELS.map((r) => (r.level === 2 ? { ...r, newChats: 5 } : r)) });

class FakeLive {
    name = 'fake live';
    realDelivery = true;
    supportsReceipts = false;
    supportsRegistrationCheck = false;
    unregistered = new Set();
    sent = [];
    checks = [];
    isConnected() { return true; }
    async checkRegistered(phones) {
        this.checks.push([...phones]);
        return new Map(phones.map((p) => [p, !this.unregistered.has(p)]));
    }
    async sendMessage(to, text, opts = {}) {
        this.sent.push({ to, text, opts });
        return { providerId: `p${this.sent.length}`, status: Status.SENT };
    }
    getStatus() { return null; }
    async disconnect() {}
}

let seq = 0;
/** `perDay` delivered messages to new people on each of the `days` days before today. */
function history(db, { days, perDay, type = 'campaign' }) {
    for (let d = 1; d <= days; d += 1) {
        for (let i = 0; i < perDay; i += 1) {
            seq += 1;
            const at = ago(d * DAY);
            db.insert({ messageId: `h${seq}`, recipient: `9170${String(seq).padStart(7, '0')}`, message: 'm', status: Status.DELIVERED, messageType: type, createdAt: at, sentAt: at });
        }
    }
}
const sent = (db, id, recipient, at = new Date().toISOString(), extra = {}) => db.insert({
    messageId: id, recipient, message: 'm', status: Status.SENT, messageType: 'campaign', createdAt: at, sentAt: at, ...extra,
});

describe('resting after linking', () => {
    it('sends no bulk for 24 hours while replies go out', async () => {
        const db = freshDb();
        const transport = new FakeLive();
        const linkedAt = ago(HOUR);
        const manager = new CampaignManager(db, transport, qr({ linkedAt }));
        const events = [];
        manager.on('event', (e) => events.push(e));
        try {
            const status = manager.safetyStatus();
            assert.equal(status.level.level, 0);
            assert.equal(status.level.resting.active, true);
            assert.equal(Date.parse(status.level.resting.endsAt), Date.parse(linkedAt) + 24 * HOUR);
            assert.equal(status.limit, 0);
            assert.equal(status.remaining, 0, 'on a QR number 0 means none, not "no cap"');
            assert.equal(manager.quota.planLimit(), LEVELS[1].dailyLimit, 'a plan counts on level 1');

            manager.enqueueContacts(people(['919811111111']), 'Hi {name}', { campaignId: 'rest' });
            manager.enqueueJob({ recipient: '919833333333', text: 'Thanks, we got it', messageType: 'auto_reply', priority: 0 });
            manager.start();
            assert.ok(await until(() => manager.pausedByQuota && transport.sent.length === 1));
            assert.deepEqual(transport.sent.map((s) => s.to), ['919833333333']);
            assert.match(events.find((e) => e.type === 'quotaReached').message, /resting.*starts automatically at \d\d:\d\d/);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('does not rest a relinked number that has history', () => {
        const db = freshDb();
        history(db, { days: 6, perDay: 7 });
        const a = new DailyQuota(db, qr({ linkedAt: new Date().toISOString() })).allowance();
        assert.equal(a.level.resting.active, false);
        assert.equal(a.level.level, 3);
        db.close();
    });
});

describe('levelling', () => {
    const now = new Date();
    const start = dayStart(now);
    const lv = (ledger) => levelFor({ lastDeliveredBefore: ago(DAY), ...ledger }, { now, dayStart: start });

    it('earns a level only when days, deliveries and bulk are all there', () => {
        assert.equal(lv({ activeDays: 1, delivered: 5000, bulkDelivered: 5000 }).level, 1, 'volume alone never promotes');
        assert.equal(lv({ activeDays: 60, delivered: 7, bulkDelivered: 0 }).level, 1, 'nor time alone');
        assert.equal(lv({ activeDays: 3, delivered: 8, bulkDelivered: 0 }).level, 2);
        assert.equal(lv({ activeDays: 9, delivered: 100, bulkDelivered: 39 }).level, 3, 'level 4 needs delivered bulk too');
        const four = lv({ activeDays: 9, delivered: 100, bulkDelivered: 40 });
        assert.equal(four.level, 4);
        assert.deepEqual(four.next, { level: 5, name: 'Steady', need: { days: 12, delivered: 220, bulk: 90 } });
        assert.equal(lv({ activeDays: 40, delivered: 2500, bulkDelivered: 1000 }).next.level, 9);
        assert.equal(lv({ activeDays: 45, delivered: 12000, bulkDelivered: 6000 }).next, null, 'level 11 is the top');
    });

    it('counts only what reached the phone', () => {
        const db = freshDb();
        for (let d = 1; d <= 3; d += 1) for (let i = 0; i < 5; i += 1) sent(db, `one-tick-${d}-${i}`, `91950000${d}${i}`, ago(d * DAY));
        const a = new DailyQuota(db, qr()).allowance();
        assert.deepEqual(a.level.have, { activeDays: 0, delivered: 0, bulk: 0 }, 'a one-tick message never counts');
        assert.equal(a.level.level, 1);
        db.close();
    });

    it('restarts after a ban, and rests longer when bans repeat', () => {
        const db = freshDb();
        history(db, { days: 6, perDay: 7 });
        const quota = new DailyQuota(db, qr());
        assert.equal(quota.allowance().level.level, 3);
        const lastBan = () => Date.parse(db.db.prepare("SELECT MAX(at) AS at FROM safety_events WHERE kind = 'ban'").get().at);

        db.addSafetyEvent({ kind: 'ban', phone: '15550000001', messageId: '2026-10-01' });
        quota.invalidate();
        let a = quota.allowance();
        assert.equal(a.level.level, 0);
        assert.equal(a.level.have.delivered, 0, 'the history restarts at the ban');
        assert.equal(Date.parse(a.level.resting.endsAt) - lastBan(), 24 * HOUR);
        assert.ok(codes(a).includes('ban'));

        db.addSafetyEvent({ kind: 'ban', phone: '15550000001', messageId: '2026-10-02' });
        quota.invalidate();
        a = quota.allowance();
        assert.equal(Date.parse(a.level.resting.endsAt) - lastBan(), 48 * HOUR, 'a second ban in 30 days rests 48 hours');
        db.close();
    });

    it('starts a day one level lower after three quiet days, never below 1', () => {
        const quiet = lv({ activeDays: 6, delivered: 40, bulkDelivered: 0, lastDeliveredBefore: new Date(start.getTime() - 4 * DAY).toISOString() });
        assert.equal(quiet.earned, 3);
        assert.equal(quiet.level, 2);
        assert.deepEqual(quiet.brakes.map((b) => b.code), ['idle']);
        assert.equal(lv({ activeDays: 6, delivered: 40, bulkDelivered: 0 }).brakes.length, 0, 'a delivery yesterday keeps the level');
        assert.equal(lv({ activeDays: 1, delivered: 2, lastDeliveredBefore: null }).brakes.length, 0, 'level 1 has nowhere to drop');
    });
});

describe('brakes', () => {
    it('halves the budgets while too few people reply, and opt-outs are not replies', () => {
        const db = freshDb();
        const reached = Array.from({ length: 40 }, (_, i) => `9180000${String(i).padStart(5, '0')}`);
        for (const [i, phone] of reached.entries()) {
            db.insert({ messageId: `rr${i}`, recipient: phone, message: 'm', status: Status.DELIVERED, messageType: 'campaign', createdAt: ago(3 * HOUR), sentAt: ago(3 * HOUR) });
            if (i < 5) db.insertInbound({ sender: phone, body: 'ok', receivedAt: ago(HOUR) });
        }
        const quota = new DailyQuota(db, qr());
        let a = quota.allowance();
        assert.ok(codes(a).includes('reply_rate'), '5 of 40 is under 15%');
        assert.equal(a.budgets.bulk.limit, 10, 'half of level 1\'s 20 a day');
        assert.equal(a.budgets.newChats.limit, 10, 'half of its 20 new chats');
        assert.equal(a.budgets.hour.limit, 4, 'half of its 8 an hour');

        db.insertInbound({ sender: reached[5], body: 'thanks', receivedAt: ago(HOUR) });
        quota.invalidate();
        assert.equal(codes(quota.allowance()).includes('reply_rate'), false, '6 of 40 is 15%');

        db.addOptOut(reached[0]);
        quota.invalidate();
        a = quota.allowance();
        assert.ok(codes(a).includes('reply_rate'), 'a STOP is not a reply that helps');
        db.close();
    });

    it('closes new chats for 72 hours after a burst of reports', () => {
        const db = freshDb();
        for (const phone of ['911', '912', '913']) db.addSafetyEvent({ kind: 'report', phone, messageId: 'm' });
        const quota = new DailyQuota(db, qr());
        let a = quota.allowance();
        const brake = a.brakes.find((b) => b.code === 'reports');
        assert.ok(brake);
        const last = Date.parse(db.db.prepare("SELECT MAX(at) AS at FROM safety_events WHERE kind = 'report'").get().at);
        assert.equal(Date.parse(brake.until), last + 72 * HOUR);
        assert.equal(a.budgets.newChats.limit, 0);
        assert.equal(a.budgets.newChats.opensAt, brake.until);

        db.db.prepare("UPDATE safety_events SET at = ? WHERE kind = 'report'").run(ago(73 * HOUR));
        quota.invalidate();
        a = quota.allowance();
        assert.equal(codes(a).includes('reports'), false);
        assert.equal(a.budgets.newChats.limit, LEVELS[1].newChats);
        db.close();
    });

    it('closes new chats while blocks and reports pass 2% of the week', () => {
        const db = freshDb();
        history(db, { days: 4, perDay: 10 });
        db.addSafetyEvent({ kind: 'block', phone: '919999000001', messageId: 'b1' });
        const quota = new DailyQuota(db, qr());
        assert.ok(codes(quota.allowance()).includes('blocks'), '1 of 40 is 2.5%');
        assert.equal(quota.allowance().budgets.newChats.limit, 0);
        db.clearBlocks('919999000001');
        quota.invalidate();
        assert.equal(codes(quota.allowance()).includes('blocks'), false);
        db.close();
    });

    it('closes new chats while over 3% of the last day failed, counted by when they failed', () => {
        const db = freshDb();
        for (let i = 0; i < 19; i += 1) sent(db, `ok${i}`, `91960000${String(i).padStart(4, '0')}`, ago(2 * HOUR));
        // Queued three days ago, failed now: the failure is today's.
        db.insert({ messageId: 'bad', recipient: '919600009999', message: 'm', status: Status.FAILED, createdAt: ago(3 * DAY), updatedAt: new Date().toISOString() });
        const quota = new DailyQuota(db, qr());
        assert.ok(codes(quota.allowance()).includes('failures'), '1 of 20 is 5%');
        db.db.prepare("UPDATE messages SET updated_at = ? WHERE message_id = 'bad'").run(ago(25 * HOUR));
        quota.invalidate();
        assert.equal(codes(quota.allowance()).includes('failures'), false);
        db.close();
    });

    it('stops new chats and lookups while WhatsApp restricts the number', () => {
        const db = freshDb();
        const until = new Date(Date.now() + 20 * HOUR).toISOString();
        db.addSafetyEvent({ kind: 'restrict', phone: '15550000001', messageId: until, detail: '475' });
        const quota = new DailyQuota(db, qr());
        let a = quota.allowance();
        const brake = a.brakes.find((b) => b.code === 'restricted');
        assert.equal(brake.until, until);
        assert.match(brake.text, /475/);
        assert.equal(a.lookups, false);
        assert.equal(a.budgets.newChats.limit, 0);
        db.db.prepare("UPDATE safety_events SET message_id = ? WHERE kind = 'restrict'").run(ago(HOUR));
        quota.invalidate();
        a = quota.allowance();
        assert.equal(a.lookups, true);
        assert.equal(codes(a).includes('restricted'), false);
        db.close();
    });
});

describe('new chats', () => {
    it('a 463 row (one contact\'s missing privacy token) holds nobody: older builds recorded those as restrictions', async () => {
        const db = freshDb();
        history(db, { days: 3, perDay: 3 });
        db.addSafetyEvent({ kind: 'restrict', phone: '15550000001', messageId: new Date(Date.now() + 20 * HOUR).toISOString(), detail: '463' });
        assert.equal(db.restrictedUntil(), null);
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr());
        try {
            assert.equal(codes(manager.quota.allowance()).includes('restricted'), false);
            manager.enqueueContacts(people(['919900000021', '919900000022']), 'Hi {name}', { campaignId: 'old463' });
            manager.start();
            assert.ok(await until(() => transport.sent.length === 2), 'nobody waits');
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    for (const safetyEnabled of [true, false]) it(`while WhatsApp restricts the number (475), only people who wrote in are sent to; the rest wait (safety ${safetyEnabled ? 'on' : 'off'})`, async () => {
        const db = freshDb();
        history(db, { days: 3, perDay: 3 });
        const wrote = '919900000011';
        const messaged = '919900000012'; // we sent to them before, they never replied: WhatsApp refuses them too
        const stranger = '919900000013';
        db.insertInbound({ sender: wrote, body: 'hi', receivedAt: ago(DAY) });
        sent(db, 'earlier', messaged, ago(2 * DAY)); // outside the 24h per-recipient cap
        db.addSafetyEvent({ kind: 'restrict', phone: '15550000001', messageId: new Date(Date.now() + 20 * HOUR).toISOString(), detail: '475' });
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr({ safetyEnabled }));
        try {
            manager.enqueueContacts(people([wrote, messaged, stranger]), 'Hi {name}', { campaignId: 'restricted' });
            manager.start();
            assert.ok(await until(() => transport.sent.length === 1));
            await sleep(300);
            assert.deepEqual(transport.sent.map((s) => s.to), [wrote]);
            assert.equal(manager.queue.pending, 2, 'held, not failed');
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('hold strangers past the day\'s budget while people who know the number keep flowing', async () => {
        const db = freshDb();
        history(db, { days: 3, perDay: 3 }); // level 2: 5 new chats a day on fewNewChats
        const warm = ['919900000001', '919900000002'];
        for (const phone of warm) db.insertInbound({ sender: phone, body: 'hi', receivedAt: ago(DAY) });
        const strangers = Array.from({ length: 7 }, (_, i) => `91980000000${i}`);
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr());
        manager.quota.tables = fewNewChats;
        manager.quota.invalidate();
        try {
            assert.equal(manager.quota.allowance().level.level, 2);
            manager.enqueueContacts(people([...warm, ...strangers]), 'Hi {name}', { campaignId: 'cold' });
            manager.start();
            assert.ok(await until(() => transport.sent.length === 7));
            await sleep(300);
            assert.equal(transport.sent.length, 7, 'five new chats and the two people who wrote in');
            assert.ok(warm.every((p) => transport.sent.some((s) => s.to === p)));
            assert.equal(manager.queue.pending, 2, 'the other strangers wait for tomorrow');
            assert.equal(manager.pausedByQuota, false, 'a hold, not a pause');
            assert.equal(manager.quota.allowance().budgets.newChats.left, 0);

            // A transactional message to a stranger waits too; one to someone who wrote in goes.
            manager.enqueueJob({ recipient: '919811112222', text: 'Your order', messageType: 'transactional' });
            manager.enqueueJob({ recipient: warm[0], text: 'Your order shipped', messageType: 'transactional' });
            assert.ok(await until(() => transport.sent.length === 8));
            await sleep(300);
            assert.equal(transport.sent.length, 8);
            assert.equal(transport.sent.at(-1).to, warm[0]);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('looks up strangers one at a time, never people it knows, and a failed lookup spends a new chat', async () => {
        const db = freshDb();
        history(db, { days: 3, perDay: 3 }); // level 2: 5 new chats on fewNewChats
        const warm = '919900000009';
        db.insertInbound({ sender: warm, body: 'hi', receivedAt: ago(DAY) });
        const junk = Array.from({ length: 5 }, (_, i) => `91970000000${i}`);
        const real = ['919700000101', '919700000102'];
        const transport = new FakeLive();
        transport.supportsRegistrationCheck = true;
        transport.unregistered = new Set(junk);
        const manager = new CampaignManager(db, transport, qr());
        manager.quota.tables = fewNewChats;
        manager.quota.invalidate();
        try {
            manager.enqueueContacts(people([warm, ...junk, ...real]), 'Hi {name}', { campaignId: 'lookups' });
            manager.start();
            assert.ok(await until(() => manager.stats.processed === 6));
            await sleep(300);
            assert.equal(manager.stats.processed, 6, 'five strangers settled, then the budget is spent');
            assert.equal(manager.queue.pending, 2);
            assert.ok(transport.checks.every((c) => c.length === 1), 'one number per lookup');
            assert.equal(transport.checks.length, 5);
            assert.equal(transport.checks.flat().includes(warm), false);
            assert.equal(transport.sent.find((s) => s.to === warm).opts.registered, true, 'the transport skips its own lookup');
        } finally {
            await manager.shutdown();
            db.close();
        }
    });
});

describe('pacing', () => {
    it('holds bulk past the hourly budget while replies go, and the hour is not cut at midnight', async () => {
        const db = freshDb();
        const warm = '919900000001';
        db.insertInbound({ sender: warm, body: 'hi', receivedAt: ago(DAY) });
        for (let i = 0; i < 8; i += 1) sent(db, `hr${i}`, `91981000000${i}`, ago(30 * 60_000)); // level 1's hour
        // Midnight ten minutes ago: those eight are yesterday's, but still this hour's.
        const fakeMidnight = db.sendingLedger({ dayStart: new Date(Date.now() - 10 * 60_000) });
        assert.equal(fakeMidnight.bulkToday, 0);
        assert.equal(fakeMidnight.lastHour, 8);

        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr());
        try {
            assert.equal(manager.quota.allowance().budgets.hour.left, 0);
            manager.enqueueContacts(people([warm]), 'Hi {name}', { campaignId: 'hour' });
            manager.enqueueJob({ recipient: '919833333333', text: 'Thanks', messageType: 'auto_reply', priority: 0 });
            manager.start();
            assert.ok(await until(() => transport.sent.length === 1));
            await sleep(300);
            assert.deepEqual(transport.sent.map((s) => s.to), ['919833333333']);
            assert.equal(manager.queue.pending, 1);
            assert.equal(manager.queue.isPaused, false);

            db.db.prepare("UPDATE messages SET sent_at = ? WHERE message_id LIKE 'hr%'").run(ago(61 * 60_000));
            manager.quota.invalidate();
            assert.ok(await until(() => transport.sent.length === 2), 'the next hour lets it through');
            assert.equal(transport.sent[1].to, warm);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('waits out the gap from the number\'s last send after a restart, lookup included', async () => {
        const db = freshDb();
        sent(db, 'last', '919900000001', ago(10_000));
        const transport = new FakeLive();
        transport.supportsRegistrationCheck = true;
        const manager = new CampaignManager(db, transport, qr({ pacingMode: 'adaptive' }));
        const events = [];
        manager.on('event', (e) => events.push(e));
        try {
            manager.enqueueContacts(people(['919811110000']), 'Hi {name}', { campaignId: 'gap' });
            manager.start();
            assert.ok(await until(() => events.some((e) => e.type === 'pacing')));
            await sleep(200);
            assert.equal(transport.sent.length, 0);
            assert.equal(transport.checks.length, 0, 'a stranger is looked up after the gap, not before');
            const wait = events.find((e) => e.type === 'pacing').seconds;
            // Level 1: 90-300s, times the day's 0.8-1.3 rhythm, less the 10s already gone.
            assert.ok(wait >= 60 && wait <= 380, `waits ${wait}s`);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });

    it('sends at once after a quiet spell', async () => {
        const db = freshDb();
        sent(db, 'long-ago', '919900000001', ago(2 * HOUR));
        const transport = new FakeLive();
        const manager = new CampaignManager(db, transport, qr({ pacingMode: 'adaptive' }));
        try {
            manager.enqueueContacts(people(['919811110000']), 'Hi {name}', { campaignId: 'quiet' });
            manager.start();
            assert.ok(await until(() => transport.sent.length === 1, 1500));
        } finally {
            await manager.shutdown();
            db.close();
        }
    });
});

describe('a daily-cap pause', () => {
    for (const operator of [false, true]) {
        it(operator ? 'stays paused after an operator Pause' : 'lifts itself the next day', async () => {
            const db = freshDb();
            const warm = ['919900000001', '919900000002', '919900000003'];
            for (const phone of warm) db.insertInbound({ sender: phone, body: 'hi', receivedAt: ago(DAY) });
            sent(db, 'cap1', '919810000001');
            sent(db, 'cap2', '919810000002');
            const transport = new FakeLive();
            const manager = new CampaignManager(db, transport, qr({ dailyLimit: 2 }));
            const events = [];
            manager.on('event', (e) => events.push(e));
            try {
                manager.enqueueContacts(people(warm), 'Hi {name}', { campaignId: `cap-${operator}` });
                manager.start();
                assert.ok(await until(() => manager.pausedByQuota));
                assert.match(events.find((e) => e.type === 'quotaReached').message,
                    /^Today's allowance of 2 is used\. Sending continues automatically at \d\d:\d\d\.$/);
                if (operator) manager.pause();
                // The next day: yesterday's sends no longer count.
                db.db.prepare("UPDATE messages SET sent_at = ? WHERE message_id LIKE 'cap%'").run(ago(25 * HOUR));
                manager.quota.invalidate();
                manager.quotaCheckedAt = 0;
                if (operator) {
                    await sleep(1500);
                    assert.equal(transport.sent.length, 0);
                    assert.equal(manager.queue.isPaused, true);
                } else {
                    assert.ok(await until(() => transport.sent.length === 2));
                    assert.equal(manager.queue.pending, 1, 'and pauses again at the new day\'s cap');
                }
            } finally {
                await manager.shutdown();
                db.close();
            }
        });
    }
});

describe('content rules', () => {
    it('no longer gates links or media by level: a level 1 number may send them', () => {
        const db = freshDb();
        const manager = new CampaignManager(db, new FakeLive(), qr());
        const queued = manager.enqueueContacts([
            { name: 'A', phone: '919811111111', extra: { message: 'See https://shop.example/x and bit.ly/y' } },
            { name: 'B', phone: '919811111112', extra: { site: 'http://shop.example' } },
        ], 'Hi {name}, see {site}', { reset: {}, media: { mediaId: 'm' } }).queued;
        assert.equal(queued, 2);
        db.close();
    });

    it('refuses identical text to more than 15, whatever the policy says, and sends the text as written', () => {
        const db = freshDb();
        const many = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `9198200${String(i).padStart(5, '0')}` }));
        const manager = new CampaignManager(db, new FakeLive(), qr({ requireVariationAbove: 50 }));
        assert.throws(() => manager.enqueueContacts(many(16), 'Hello there'), /more than 15 people must vary/);
        assert.equal(manager.enqueueContacts(many(15), 'Hello there', { campaignId: 'fifteen' }).queued, 15);
        // No STOP line is added for new people: the campaign's "Add opt-out line" box decides.
        assert.ok(db.history({ campaignId: 'fifteen' }).every((r) => r.message === 'Hello there'));
        db.insertInbound({ sender: '919830000009', body: 'hi' });
        manager.enqueueContacts([{ name: 'W', phone: '919830000009' }], 'Hi {name}', { campaignId: 'warm' });
        assert.equal(db.history({ campaignId: 'warm' })[0].message, 'Hi W');
        manager.enqueueContacts([{ name: 'S', phone: '919830000001', extra: { message: 'Reply stop to opt out' } }], 'Hi', { campaignId: 'own' });
        assert.equal(db.history({ campaignId: 'own' })[0].message, 'Reply stop to opt out', 'already has a way out');
        assert.throws(() => manager.enqueueContacts(many(16).map((c) => ({ ...c, extra: { message: 'Same offer for all' } })), 'Hi {name}'),
            /more than 15 people must vary/, 'the same per-row text is still identical bulk');

        const plainDb = freshDb();
        const plain = new CampaignManager(plainDb, new FakeLive(), { ...qr({ requireVariationAbove: 50 }), transport: TRANSPORT_SANDBOX });
        assert.equal(plain.enqueueContacts(many(16), 'Hello there').queued, 16, 'off QR the policy threshold and the text stand');
        plainDb.close();
        db.close();
    });
});

describe('scope and API', () => {
    it('keeps the plain daily limit off QR numbers', () => {
        const db = freshDb();
        const quota = new DailyQuota(db, { ...DEFAULTS, transport: TRANSPORT_SANDBOX });
        assert.equal(quota.qr, false);
        assert.equal(quota.tier(), null);
        assert.equal(quota.limit, DEFAULTS.dailyLimit);
        assert.equal(quota.status().level, undefined);
        db.close();
    });

    it('shows the level, budgets and brakes, guards linkedAt, and records one ban a day', async () => {
        const db = freshDb();
        const sock = {
            ev: new EventEmitter(),
            user: { id: '15550000001:7@s.whatsapp.net' },
            sends: 0,
            async sendMessage(jid) { sock.sends += 1; return { key: { id: `L${sock.sends}`, remoteJid: jid, fromMe: true } }; },
            async onWhatsApp(...jids) { sock.checks?.push(jids); return jids.map((jid) => ({ jid, exists: true })); },
            async logout() {},
            async end() {},
        };
        const createSocket = async () => {
            setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
            return sock;
        };
        const dataDir = fs.mkdtempSync(path.join(tmp, 'app-'));
        const app = createTestApp({ db, config: qr(), dataDir, deps: { sessionDir: dataDir, setTimeoutFn: (fn) => setTimeout(fn, 0), createSocket } });
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const api = async (method, url, body) => {
            const res = await fetch(base + url, {
                method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
            });
            return { status: res.status, body: await res.json() };
        };
        try {
            assert.equal((await api('POST', '/api/connection/connect')).body.connected, true);
            const tenant = app.locals.runtimeFor(1);
            const { state } = tenant.runtimeFor(tenant.channels.getDefault());
            // Its questions answered at level 1 (no head start: below startLevelFor's lowest), so bulk is not held.
            app.locals.channelOps.setStart(state.channel.id, 1, { age: 0, usage: 0 });
            state.manager.quota.invalidate();

            let { safety } = (await api('GET', '/api/safety?contacts=45')).body;
            assert.equal(safety.level.level, 1);
            assert.equal(safety.level.steps.length, LEVELS.length);
            assert.deepEqual(Object.keys(safety.budgets), ['bulk', 'newChats', 'hour']);
            assert.equal(safety.content.optOutLine, OPT_OUT_TEXT);
            assert.equal(safety.estimateSeconds.days, 3, '20 today, 20 tomorrow, 5 the day after');
            assert.match(safety.estimateSeconds.finishesOn, /^\d{4}-\d{2}-\d{2}$/);

            // A number an earlier lookup found without WhatsApp is refused up front; no fresh lookup is made here.
            state.manager.registry.set('919811119999', { registered: false, at: Date.now() });
            sock.checks = [];
            const gone = await api('POST', '/api/messages', { recipient: '919811119999', message: 'Hello' });
            assert.equal(gone.status, 422);
            assert.equal(gone.body.reason, 'not_on_whatsapp');
            assert.equal((await api('POST', '/api/messages', { recipient: '919811119998', message: 'Hello' })).status, 200);
            assert.equal(sock.checks.length, 0, 'the queue looks up, after the gap');

            assert.equal((await api('PUT', '/api/config', { linkedAt: '2020-01-01T00:00:00Z' })).body.config.linkedAt, '');
            await api('PUT', '/api/config', { humanTiming: true });
            assert.equal(state.config.humanTiming, false, 'humanTiming is not a tenant setting');

            // A fresh scan: the number rests, and new chats with it.
            state.transport.events.emit('qr', 'QR-CODE');
            state.transport.events.emit('ready', { connected: true, account: '15550000001' });
            safety = (await api('GET', '/api/safety')).body.safety;
            assert.equal(safety.level.resting.active, true);

            const plan = (await api('POST', '/api/campaigns/spread-check', { count: 30, from: '2026-01-01', to: '2099-01-01' })).body.plan;
            assert.deepEqual(plan.level, { level: 0, name: 'Resting' });
            assert.equal(plan.dailyLimit, LEVELS[1].dailyLimit, 'a resting number plans at level 1, not "no cap"');
            assert.equal(plan.newChatsPerDay, LEVELS[1].newChats);
            assert.equal(plan.worstDays, 2, '30 strangers at 20 new chats a day');

            const cold = await api('POST', '/api/messages', { recipient: '919811110001', message: 'Hello' });
            assert.equal(cold.status, 429);
            assert.equal(cold.body.reason, 'new_chats');
            assert.ok(cold.body.opensAt);
            assert.match(cold.body.errors[0], /People who wrote to you still get your messages/);
            state.db.insertInbound({ sender: '919811110002', body: 'hi', receivedAt: ago(HOUR) });
            assert.equal((await api('POST', '/api/messages', { recipient: '919811110002', message: 'Hello' })).status, 200);

            state.transport.events.emit('restricted', { code: 475, until: new Date(Date.now() + DAY).toISOString() });
            safety = (await api('GET', '/api/safety')).body.safety;
            assert.ok(safety.brakes.some((b) => b.code === 'restricted'));
            const health = (await api('GET', '/api/safety/health')).body;
            assert.ok(['newchats', 'replies'].every((key) => health.causes.some((c) => c.key === key)));
            const card = (await api('GET', '/api/channels')).body.channels[0].health;
            assert.equal('warmup' in card, false);
            // The business sees today's day and a plain reason, never the level or its brakes.
            assert.equal('level' in card, false);
            assert.deepEqual(Object.keys(card.usage).sort(), ['asked', 'blocked', 'growing', 'planLimit', 'sentToday', 'todayLimit']);
            assert.match(card.usage.blocked, /WhatsApp is limiting/);

            // A 403 repeated by a reconnect is the same day's ban.
            state.transport.events.emit('state', { state: 'banned', detail: 'banned' });
            state.transport.events.emit('state', { state: 'banned', detail: 'banned' });
            assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM safety_events WHERE kind = 'ban'").get().n, 1);
            // ...with one snapshot of how the number looked just before it.
            const snaps = db.db.prepare("SELECT detail FROM safety_events WHERE kind = 'ban_snapshot'").all();
            assert.equal(snaps.length, 1);
            const snap = JSON.parse(snaps[0].detail);
            assert.ok(snap.level >= 0 && snap.brakes.includes('restricted') && 'replies48h' in snap && 'bulk' in snap.budgets);

            // Switching the transport drops the live QR socket: it must not keep sending under other rules.
            const swap = await api('PUT', '/api/config', { transport: TRANSPORT_SANDBOX });
            assert.equal(swap.status, 200);
            assert.equal(state.transport, null);
            assert.equal(state.manager.transport.realDelivery, false, 'nothing real is left to send on');
        } finally {
            await closeApp(app);
            await new Promise((resolve) => server.close(resolve));
            db.close();
        }
    });
});

describe('super admin: skip new-link wait', () => {
    it('a tenant with sending.skipLinkWait sends right after linking; a ban still rests the number', async () => {
        const { sendingTables } = await import('../src/policy/levels.js');
        assert.equal(sendingTables({}).skipLinkWait, false);
        assert.equal(sendingTables({ 'sending.skipLinkWait': true }).skipLinkWait, true);

        const db = freshDb();
        const quota = new DailyQuota(db, qr({ linkedAt: ago(HOUR) }));
        assert.equal(quota.allowance().level.resting.active, true, 'by default a fresh link waits');
        const tables = quota.tables();
        quota.tables = () => ({ ...tables, skipLinkWait: true });
        quota.invalidate();
        assert.equal(quota.allowance().level.resting.active, false);
        db.close();
    });
});

describe('super admin: skip quiet time', () => {
    it('a tenant with sending.skipQuietTime has no rest windows and no quiet time in estimates', async () => {
        const { sendingTables } = await import('../src/policy/levels.js');
        assert.equal(sendingTables({}).skipQuiet, false);
        assert.equal(sendingTables({ 'sending.skipQuietTime': true }).skipQuiet, true);

        const db = freshDb();
        const manager = new CampaignManager(db, new FakeLive(), qr({ humanTiming: true }));
        try {
            assert.ok(manager.safetyStatus().quiet, 'by default the number keeps its daily rest windows');
            const tables = manager.quota.tables();
            manager.quota.tables = () => ({ ...tables, skipQuiet: true });
            const status = manager.safetyStatus(200);
            assert.equal(status.quiet, null);
            assert.equal(status.estimateSeconds.quietSeconds, 0);
        } finally {
            await manager.shutdown();
            db.close();
        }
    });
});
