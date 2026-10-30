/**
 * Delivery health (todo.md section 1 and 3): the delivery and stuck brakes on one 2-24h window, the shadow
 * rollout (logged, never applied), the block judged once at 48h, the 429 backoff, and health-aware routing.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BRAKES, LEVELS, deliveryBrakes } from '../src/campaign/humanize.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULT_SENDING, DailyQuota } from '../src/campaign/safety.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { ErrorCode, normalizeError } from '../src/messaging/errors.js';
import { quotaLeft } from '../src/policy/channelOps.js';
import { Status } from '../src/protocol.js';
import { TransportSendError } from '../src/transports/base.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-health-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
let file = 0;
const freshDb = () => new Database(path.join(tmp, `h${(file += 1)}.db`));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const qr = (extra = {}) => {
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, rateLimitPerSecond: 1000, pacingMode: 'fixed', humanTiming: false, ...extra };
    delete config.misc;
    return config;
};
const enforce = () => ({ ...DEFAULT_SENDING, brakes: { ...BRAKES, brakesMode: 'enforce' } });
const codes = (allowance) => allowance.brakes.map((b) => b.code);

let seq = 0;
/** One outbound message sent `hours` ago. FAILED keeps its send time, as a failed ack after SENT does. */
function msg(db, { status = Status.DELIVERED, hours, to = null, type = 'campaign' }) {
    seq += 1;
    const id = `x${seq}`;
    const at = ago(hours * HOUR);
    db.insert({ messageId: id, recipient: to ?? `9170${String(seq).padStart(7, '0')}`, message: 'm', status: status === Status.FAILED ? Status.SENT : status, messageType: type, createdAt: at, sentAt: at });
    if (status === Status.FAILED) db.db.prepare("UPDATE messages SET status = 'FAILED' WHERE message_id = ?").run(id);
    return id;
}
const many = (db, n, opts) => Array.from({ length: n }, () => msg(db, opts));

class FakeLive {
    name = 'fake live';
    realDelivery = true;
    supportsReceipts = false;
    supportsRegistrationCheck = false;
    sent = [];
    fail = null;
    isConnected() { return true; }
    async checkRegistered() { return new Map(); }
    async sendMessage(to, text) {
        this.sent.push({ to, text });
        if (this.fail) throw this.fail;
        return { providerId: `p${this.sent.length}`, status: Status.SENT };
    }
    getStatus() { return null; }
    async disconnect() {}
}

const rows = (db, kind) => db.db.prepare('SELECT phone AS code, message_id AS until, detail FROM safety_events WHERE kind = ? ORDER BY id').all(kind);

describe('delivery and stuck brakes: one 2-24h window', () => {
    it('counts only messages sent 2-24h ago, so old stuck messages cannot push the rate past 100%', () => {
        const db = freshDb();
        many(db, 10, { hours: 3 });
        many(db, 8, { status: Status.SENT, hours: 5 });
        many(db, 2, { status: Status.FAILED, hours: 6 });
        // Outside the window: still landing (under 2h), and old stuck ones (over 24h). Old math counted those
        // 50 stuck against 20 sends: 250%.
        many(db, 5, { status: Status.SENT, hours: 1 });
        many(db, 50, { status: Status.SENT, hours: 30 });
        const win = db.deliveryWindow();
        assert.deepEqual(win, { sentWin: 20, deliveredWin: 10, failedWin: 2, stuckWin: 8 });
        assert.ok(win.stuckWin <= win.sentWin);
        assert.deepEqual(deliveryBrakes(win).map((b) => b.code), ['delivery', 'stuck'], '50% delivered, 40% stuck');
        db.close();
    });

    it('needs 20 sends for the delivery brake; trips stuck above 20% and delivery under 85%', () => {
        assert.deepEqual(deliveryBrakes({ sentWin: 19, deliveredWin: 10, stuckWin: 0 }), []);
        assert.deepEqual(deliveryBrakes({ sentWin: 20, deliveredWin: 17, stuckWin: 3 }), [], '85% and 15% pass');
        assert.deepEqual(deliveryBrakes({ sentWin: 20, deliveredWin: 16, stuckWin: 4 }).map((b) => b.code), ['delivery']);
        assert.deepEqual(deliveryBrakes({ sentWin: 40, deliveredWin: 31, stuckWin: 9 }).map((b) => b.code), ['delivery', 'stuck']);
        assert.deepEqual(deliveryBrakes({ sentWin: 20, deliveredWin: 20, stuckWin: 0 }), []);
    });

    it('a healthy window with old stuck messages trips nothing', () => {
        const db = freshDb();
        many(db, 20, { hours: 4 });
        many(db, 40, { status: Status.SENT, hours: 26 });
        assert.deepEqual(deliveryBrakes(db.deliveryWindow()), []);
        db.close();
    });
});

describe('shadow mode', () => {
    const badNumber = () => {
        const db = freshDb();
        many(db, 10, { hours: 3 });
        many(db, 10, { status: Status.SENT, hours: 3 });
        return db;
    };

    it('logs the delivery and stuck brakes as shadow rows and never stops sending', () => {
        const db = badNumber();
        const manager = new CampaignManager(db, new FakeLive(), qr());
        const before = manager.quota.allowance();
        manager.scanHealth();
        assert.deepEqual(rows(db, 'shadow').map((r) => r.code).sort(), ['delivery', 'stuck']);
        assert.equal(rows(db, 'brake').length, 0);
        manager.quota.invalidate();
        const a = manager.quota.allowance();
        assert.equal(codes(a).some((c) => ['delivery', 'stuck'].includes(c)), false);
        assert.equal(a.budgets.bulk.limit, before.budgets.bulk.limit);
        assert.ok(a.budgets.bulk.limit > 0);
        assert.equal(a.budgets.newChats.limit, LEVELS[1].newChats);
        manager.scanHealth();
        assert.equal(rows(db, 'shadow').length, 2, 'one row per trigger while it runs, not one per scan');
        // Switching to enforce does not apply what shadow mode logged.
        manager.quota.tables = enforce;
        manager.quota.invalidate();
        assert.equal(codes(manager.quota.allowance()).includes('delivery'), false);
        db.close();
    });

    it('enforce: the brakes hold bulk and new chats for 12 hours', () => {
        const db = badNumber();
        const manager = new CampaignManager(db, new FakeLive(), qr());
        manager.quota.tables = enforce;
        manager.quota.invalidate();
        manager.scanHealth();
        assert.deepEqual(rows(db, 'brake').map((r) => r.code).sort(), ['delivery', 'stuck']);
        const a = manager.quota.allowance();
        assert.ok(codes(a).includes('delivery') && codes(a).includes('stuck'));
        assert.equal(a.budgets.bulk.limit, 0);
        assert.equal(a.budgets.newChats.limit, 0);
        const until = Date.parse(a.brakes.find((b) => b.code === 'delivery').until);
        assert.ok(Math.abs(until - (Date.now() + 12 * HOUR)) < 60_000);
        // Back to shadow: an enforced row no longer applies.
        manager.quota.tables = () => DEFAULT_SENDING;
        manager.quota.invalidate();
        assert.ok(manager.quota.allowance().budgets.bulk.limit > 0);
        db.close();
    });

    it('the unstable brake runs 8 hours, and only once enforced', () => {
        const db = freshDb();
        const manager = new CampaignManager(db, new FakeLive(), qr());
        assert.equal(manager.recordBrake('unstable', 'dropped'), true);
        assert.equal(manager.recordBrake('unstable', 'dropped'), false, 'already running');
        assert.equal(rows(db, 'shadow')[0].code, 'unstable');
        manager.quota.tables = enforce;
        manager.quota.invalidate();
        assert.equal(manager.recordBrake('unstable', 'dropped'), true);
        const brake = manager.quota.allowance().brakes.find((b) => b.code === 'unstable');
        assert.ok(Math.abs(Date.parse(brake.until) - (Date.now() + 8 * HOUR)) < 60_000);
        assert.equal(manager.quota.allowance().budgets.bulk.limit, 0);
        assert.equal(manager.quota.allowance().level.level, 1, 'a pause, never a demotion');
        db.close();
    });
});

describe('the block check: judged once, at 48h', () => {
    const blocks = (db) => db.db.prepare("SELECT phone FROM safety_events WHERE kind = 'block'").all().map((r) => r.phone);
    const checked = (db, id) => db.db.prepare('SELECT block_checked FROM messages WHERE message_id = ?').get(id).block_checked;

    it('counts a block when the number delivered at least 95% in hours 24-48 and the recipient was silent', () => {
        const db = freshDb();
        const id = msg(db, { status: Status.SENT, hours: 50, to: '919811100001' });
        many(db, 19, { hours: 10 });
        msg(db, { status: Status.SENT, hours: 10 });   // 19 of 20: exactly 95%
        new CampaignManager(db, new FakeLive(), qr()).scanHealth();
        assert.deepEqual(blocks(db), ['919811100001']);
        assert.equal(checked(db, id), 1);
        db.close();
    });

    it('below 95% the stuck message is never a block, and it is not judged again later', () => {
        const db = freshDb();
        const id = msg(db, { status: Status.SENT, hours: 50, to: '919811100002' });
        many(db, 18, { hours: 10 });
        many(db, 2, { status: Status.SENT, hours: 10 });   // 90%
        const manager = new CampaignManager(db, new FakeLive(), qr());
        manager.scanHealth();
        assert.deepEqual(blocks(db), []);
        assert.equal(checked(db, id), 1);
        many(db, 40, { hours: 9 });   // now the window reads 97%: too late, it was judged
        manager.scanHealth();
        assert.deepEqual(blocks(db), []);
        db.close();
    });

    it('is not judged before 48h, nor when the recipient wrote back in hours 24-48', () => {
        const db = freshDb();
        const young = msg(db, { status: Status.SENT, hours: 40, to: '919811100003' });
        msg(db, { status: Status.SENT, hours: 50, to: '919811100004' });
        db.insertInbound({ sender: '919811100004', body: 'hi', receivedAt: ago(20 * HOUR) });
        many(db, 20, { hours: 10 });
        new CampaignManager(db, new FakeLive(), qr()).scanHealth();
        assert.deepEqual(blocks(db), []);
        assert.equal(checked(db, young), null);
        db.close();
    });

    it('an idle number with old stuck messages builds up no blocks', () => {
        const db = freshDb();
        // Delivered well before, then nothing: no sends in any message's hours 24-48.
        many(db, 40, { hours: 200 });
        const recent = msg(db, { status: Status.SENT, hours: 60, to: '919811100005' });
        for (let i = 0; i < 10; i += 1) msg(db, { status: Status.SENT, hours: 100 + i * 24, to: `91981110010${i}` });
        const manager = new CampaignManager(db, new FakeLive(), qr());
        manager.scanHealth();
        manager.scanHealth();
        assert.deepEqual(blocks(db), []);
        assert.equal(checked(db, recent), 1, 'judged (no sends then), once');
        assert.equal(db.stuckSent().length, 0, 'older than 72h is never judged');
        db.close();
    });
});

describe('rate limits (429)', () => {
    it('classifies Baileys\' rate-overlimit', () => {
        assert.equal(normalizeError(new Error('rate-overlimit')).code, ErrorCode.RATE_LIMITED);
        assert.equal(normalizeError(new TransportSendError('x', { code: 'RATE_LIMITED' })).code, ErrorCode.RATE_LIMITED);
        assert.equal(normalizeError(new TransportSendError('rate-overlimit')).retryable, true);
    });

    it('the manager waits 90 seconds or more before trying again, and sends nothing meanwhile', async () => {
        const db = freshDb();
        const transport = new FakeLive();
        transport.fail = new TransportSendError('rate-overlimit', { retryable: true, code: 'RATE_LIMITED' });
        const manager = new CampaignManager(db, transport,
            { ...DEFAULTS, transport: TRANSPORT_SANDBOX, safetyEnabled: false, humanTiming: false, rateLimitPerSecond: 1000, pacingMode: 'fixed' });
        manager.enqueueContacts([{ name: 'A', phone: '919800000001' }, { name: 'B', phone: '919800000002' }], 'Hi {name}', { campaignId: 'c429' });
        manager.start();
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !transport.sent.length) await sleep(10);
        await sleep(300);
        assert.equal(transport.sent.length, 1, 'no retry and no next message within the backoff');
        const row = db.db.prepare("SELECT status, error FROM messages WHERE recipient = ?").get(transport.sent[0].to);
        assert.equal(row.status, Status.QUEUED);
        const wait = Number(row.error.match(/retry in about (\d+)s/)?.[1]);
        assert.ok(wait >= 90, row.error);
        await manager.shutdown();
        const after = db.db.prepare("SELECT status FROM messages WHERE recipient = ?").get(transport.sent[0].to);
        assert.equal(after.status, Status.QUEUED, 'a restart mid-backoff keeps the row for restoreRun');
        db.close();
    });

    it('a 429 with no retry left still holds the next message back', async () => {
        const db = freshDb();
        const transport = new FakeLive();
        transport.fail = new TransportSendError('rate-overlimit', { retryable: true, code: 'RATE_LIMITED' });
        const manager = new CampaignManager(db, transport,
            { ...DEFAULTS, transport: TRANSPORT_SANDBOX, safetyEnabled: false, humanTiming: false, rateLimitPerSecond: 1000, pacingMode: 'fixed', maxRetries: 0 });
        manager.enqueueContacts([{ name: 'A', phone: '919800000001' }, { name: 'B', phone: '919800000002' }], 'Hi {name}', { campaignId: 'c429b' });
        manager.start();
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline && !transport.sent.length) await sleep(10);
        await sleep(300);
        assert.equal(transport.sent.length, 1, 'the next recipient waits out the backoff');
        const row = db.db.prepare("SELECT status FROM messages WHERE recipient = ?").get(transport.sent[0].to);
        assert.equal(row.status, Status.FAILED);
        await manager.shutdown();
        db.close();
    });
});

describe('health-aware routing', () => {
    const channel = (id) => ({ id, status: 'active', capabilities: [], isDefault: id === 1, settings: qr() });

    it('skips a QR number under an enforced brake; ties go to the higher delivered rate; shadow ignores new brakes', () => {
        const db = freshDb();
        const t = db.forTenant(1);
        const [one, two, three] = [1, 2, 3].map((id) => t.forChannel(id));
        many(one, 10, { hours: 3 });
        many(two, 5, { hours: 3 });
        many(two, 5, { status: Status.SENT, hours: 3 });
        many(three, 10, { hours: 3 });
        one.addSafetyEvent({ kind: 'brake', phone: 'delivery', messageId: new Date(Date.now() + HOUR).toISOString(), detail: 'held' });
        const enforced = { 'sending.brakesMode': 'enforce' };
        const score = (ch, sending) => quotaLeft(t, ch, null, {}, sending);
        assert.equal(score(channel(1), enforced), -1, 'braked');
        assert.ok(score(channel(3), enforced) > score(channel(2), enforced), 'same quota left: 100% delivered beats 50%');
        assert.equal(Math.floor(score(channel(3), enforced)), Math.floor(score(channel(2), enforced)));
        const pick = (sending) => Channels.prototype.pick.call(
            { list: () => [1, 2, 3].map(channel), getDefault: () => channel(1) }, 'quota', null, (ch) => score(ch, sending)).id;
        assert.equal(pick(enforced), 3);
        assert.ok(score(channel(1), {}) >= 0, 'shadow: the delivery row is not a brake');
        assert.equal(pick({}), 1, 'shadow: the default, tied with 3, keeps it');
        db.close();
    });

    it('skips numbers under the failure, block and restricted brakes in either mode', () => {
        const db = freshDb();
        const t = db.forTenant(1);
        const one = t.forChannel(1);
        one.addSafetyEvent({ kind: 'restrict', phone: '1555', messageId: new Date(Date.now() + HOUR).toISOString(), detail: '475' });
        assert.equal(quotaLeft(t, channel(1), null, {}, {}), -1);
        assert.ok(quotaLeft(t, channel(2), null, {}, {}) >= 0);
        assert.equal(one.safetyEvents().length, 0, 'a restriction is the number\'s own state, not someone complaining');
        db.close();
    });
});
