/**
 * Levels that go down as well as up (todo.md section 2): the growth cap over the best recent clean day, the
 * promotion health gate, demotion, probation, idle decay and the level audit rows. Demotion, probation and
 * the gate obey sending.brakesMode: shadow notes them, enforce applies them.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { BRAKES, healthCheck, levelFor } from '../src/campaign/humanize.js';
import { DEFAULT_SENDING, DailyQuota, dayStart } from '../src/campaign/safety.js';
import { DEFAULTS, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { createChannelOps } from '../src/policy/channelOps.js';
import { Status } from '../src/protocol.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-growth-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let file = 0;
const freshDb = () => new Database(path.join(tmp, `g${(file += 1)}.db`));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const qr = () => {
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, dailyLimit: 0 };
    delete config.misc;
    return config;
};
// The reply brake needs replies the fixtures do not write: lift it so it cannot mark a brake day.
const tables = (brakesMode = 'shadow') => ({ ...DEFAULT_SENDING, brakes: { ...BRAKES, replyMinReached: 1e6, brakesMode } });
const ENFORCE = { ...BRAKES, brakesMode: 'enforce' };

const today = dayStart(new Date());
const noonOf = (daysAgo) => new Date(today.getTime() - daysAgo * DAY + 12 * HOUR).toISOString();
let seq = 0;
/** `n` campaign messages sent at noon `daysAgo` days back (0 = today). */
function day(db, daysAgo, n, status = Status.DELIVERED) {
    const at = noonOf(daysAgo);
    for (let i = 0; i < n; i += 1) {
        seq += 1;
        db.insert({ messageId: `g${seq}`, recipient: `9180${String(seq).padStart(7, '0')}`, message: 'm', status, messageType: 'campaign', createdAt: at, sentAt: at });
    }
}
/** A brake that really applied on that day (DailyQuota writes these). */
const brakeDay = (db, daysAgo, code = 'failures') => db.addSafetyEvent({ kind: 'brake_day', phone: code, messageId: `t@${daysAgo}`, at: noonOf(daysAgo) });
/** A QR number whose questions started it at `level`, a month ago unless `answeredAt`. */
function quotaOn(db, level = 7, mode = 'shadow', answeredAt = ago(30 * DAY)) {
    const quota = new DailyQuota(db, qr());
    quota.tables = () => tables(mode);
    quota.levelStart = () => ({ level, answers: {}, at: answeredAt });
    return quota;
}
const ledgerOf = (db) => db.sendingLedger({ dayStart: today, now: new Date() });

describe('growth cap: 35% over the best recent clean day', () => {
    it('six days at 100 then one at 30: the next day is capped at 135, not 40', () => {
        const db = freshDb();
        for (let d = 7; d >= 2; d -= 1) day(db, d, 100);
        day(db, 1, 30);
        const ledger = ledgerOf(db);
        assert.deepEqual([ledger.bestCleanDay7, ledger.lastDayDelivered, ledger.hasHistory, ledger.brakeIn7d], [100, 30, true, false]);
        const a = quotaOn(db).allowance();
        assert.equal(a.level.level, 7, 'level 7 allows 200');
        assert.equal(a.budgets.bulk.limit, 135);
        assert.deepEqual([a.growth.mode, a.growth.multiplier], ['grow', 1.35]);
        db.close();
    });

    it('leaves a brake day out of the best day, and drops the multiplier to 1.15 after a brake', () => {
        const db = freshDb();
        for (let d = 6; d >= 2; d -= 1) day(db, d, 50);
        day(db, 1, 120);
        brakeDay(db, 1);
        const ledger = ledgerOf(db);
        assert.deepEqual([ledger.bestCleanDay7, ledger.brakeIn7d], [50, true], 'the braked 120 is not the best day');
        assert.equal(quotaOn(db).limitOn(), 57, '50 x 1.15');

        const clean = freshDb();
        for (let d = 7; d >= 1; d -= 1) day(clean, d, 100);
        assert.equal(quotaOn(clean).limitOn(), 135);
        brakeDay(clean, 0);
        assert.equal(quotaOn(clean).limitOn(), 115, 'a brake today counts as within the 7 days: 100 x 1.15');
        db.close();
        clean.close();
    });

    it('counts delivered, not attempted', () => {
        const db = freshDb();
        day(db, 1, 60);
        day(db, 1, 30, Status.SENT);
        day(db, 1, 10, Status.FAILED);
        assert.equal(ledgerOf(db).bestCleanDay7, 60);
        assert.equal(quotaOn(db).limitOn(), 81);
        db.close();
    });

    it('shadow rows never affect the cap, and a shadow brake marks no brake day', () => {
        const db = freshDb();
        for (let d = 7; d >= 1; d -= 1) day(db, d, 100);
        for (const d of [3, 1, 0]) db.addSafetyEvent({ kind: 'shadow', phone: 'delivery', messageId: noonOf(d - 0.5), at: noonOf(d) });
        db.addSafetyEvent({ kind: 'shadow', phone: 'level:demote_delivery', messageId: 'x', at: noonOf(1) });
        // A running delivery hold, logged in shadow mode only: never a brake.
        db.addSafetyEvent({ kind: 'shadow', phone: 'stuck', messageId: new Date(Date.now() + HOUR).toISOString() });
        const ledger = ledgerOf(db);
        assert.deepEqual([ledger.bestCleanDay7, ledger.brakeIn7d], [100, false]);
        const quota = quotaOn(db);
        assert.equal(quota.limitOn(), 135);
        assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM safety_events WHERE kind = 'brake_day'").get().n, 0);

        // The same hold enforced is a brake: it marks today, and the multiplier drops.
        db.addSafetyEvent({ kind: 'brake', phone: 'stuck', messageId: new Date(Date.now() + HOUR).toISOString() });
        const enforced = quotaOn(db, 7, 'enforce');
        assert.equal(enforced.allowance().budgets.bulk.limit, 0, 'the hold stops bulk');
        assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM safety_events WHERE kind = 'brake_day' AND phone = 'stuck'").get().n, 1);
        assert.equal(enforced.allowance().growth.multiplier, 1.15);
        db.close();
    });

    it('all 7 days braked: holds flat at the latest day, never falls back to startDaily, never below 10', () => {
        const db = freshDb();
        for (let d = 7; d >= 2; d -= 1) day(db, d, 80);
        day(db, 1, 25);
        for (let d = 7; d >= 1; d -= 1) brakeDay(db, d);
        const a = quotaOn(db).allowance();
        assert.deepEqual([a.growth.mode, a.growth.multiplier, a.budgets.bulk.limit], ['flat', 1, 25], 'not 200 (its start), not 80 x 1.15');

        const low = freshDb();
        for (let d = 7; d >= 1; d -= 1) {
            day(low, d, 4);
            brakeDay(low, d);
        }
        assert.equal(quotaOn(low).limitOn(), 10, 'level 1\'s day is the floor');
        db.close();
        low.close();
    });

    it('startDaily applies only with no delivered bulk history', () => {
        const db = freshDb();
        // Answered an hour ago: a month-old answer with nothing delivered since would idle it a level.
        const fresh = quotaOn(db, 5, 'shadow', ago(HOUR)).allowance();
        assert.deepEqual([fresh.growth.mode, fresh.budgets.bulk.limit], ['start', 100]);
        day(db, 0, 20);
        assert.equal(quotaOn(db, 5, 'shadow', ago(HOUR)).limitOn(), 100, 'today\'s sends are not history yet');
        const next = freshDb();
        day(next, 1, 20);
        assert.equal(quotaOn(next, 5).limitOn(), 27, 'one small day: 20 x 1.35, not the start\'s 100');
        db.close();
        next.close();
    });

    it('a promotion climbs 40 -> 54 -> 60, not 40 -> 60', () => {
        const db = freshDb();
        day(db, 1, 40);
        const a = quotaOn(db, 4).allowance();
        assert.equal(a.level.level, 4, 'level 4 allows 60');
        assert.equal(a.budgets.bulk.limit, 54);
        const next = freshDb();
        day(next, 2, 40);
        day(next, 1, 54);
        assert.equal(quotaOn(next, 4).limitOn(), 60);
        db.close();
        next.close();
    });
});

// ------------------------------------------------------------------ levels --

/** A ledger whose history earns `level` 5 (or 6), delivered the day before `at`. */
const L5 = { activeDays: 12, delivered: 220, bulkDelivered: 90 };
const L6 = { activeDays: 17, delivered: 500, bulkDelivered: 200 };
const GOOD = { sent: 100, delivered: 95, failed: 1, stuck: 4, reached: 50, replied: 10 };
const T = Date.parse('2026-10-20T00:00:00Z');
const at = (h) => new Date(T + h * HOUR);
const step = (needs, health, h, state, brakes = ENFORCE) => levelFor({ ...needs, health, lastDeliveredBefore: at(h - 24).toISOString() },
    { now: at(h), dayStart: at(h), brakes, state });
const reasons = (lv) => lv.changes.map((c) => `${c.kind}:${c.reason}`);

describe('promotion requires good health', () => {
    it('moves up when healthy, and holds when any line is missed', () => {
        const up = step(L5, GOOD, 0, { level: 3 });
        assert.deepEqual([up.earned, up.ready, up.state.level], [5, 5, 5]);
        assert.deepEqual(reasons(up), ['level:promote']);
        assert.deepEqual([up.changes[0].from, up.changes[0].to], [3, 5]);

        for (const [why, health] of [
            ['delivered under 92%', { sent: 100, delivered: 91, failed: 0, stuck: 9 }],
            ['stuck over 5%', { sent: 100, delivered: 93, failed: 0, stuck: 7 }],
            ['failed over 3%', { sent: 100, delivered: 93, failed: 4, stuck: 3 }],
            ['replies under 10% once 40 were reached', { ...GOOD, reached: 50, replied: 4 }],
        ]) {
            const held = step(L5, health, 0, { level: 3 });
            assert.deepEqual([held.earned, held.ready, held.state.level, held.level], [3, 5, 3, 3], why);
            assert.deepEqual(reasons(held), ['level:hold_health'], why);
        }
        assert.equal(step(L5, { ...GOOD, reached: 30, replied: 0 }, 0, { level: 3 }).earned, 5, 'replies are judged from 40 reached');
        assert.equal(step(L5, { sent: 10, delivered: 5, failed: 0, stuck: 5 }, 0, { level: 3 }).earned, 5, 'too few sends to rate');
        assert.equal(healthCheck({ ...GOOD, failed: 5, attempted: 105 }).passes, false, 'sends that failed before leaving count');
    });

    it('the ledger counts sends that failed before leaving', () => {
        const db = freshDb();
        day(db, 1, 100);
        day(db, 1, 10, Status.FAILED);
        const { health } = ledgerOf(db);
        assert.deepEqual([health.sent, health.attempted, health.failed], [100, 110, 10]);
        assert.equal(healthCheck(health).passes, false, '9% failed');
        db.close();
    });

    it('shadow mode notes the hold and promotes anyway; no stored state means no gate', () => {
        const bad = { sent: 100, delivered: 91, failed: 0, stuck: 9 };
        const shadow = step(L5, bad, 0, { level: 3 }, BRAKES);
        assert.deepEqual([shadow.earned, shadow.state.level], [5, 5]);
        assert.deepEqual(reasons(shadow), ['shadow:hold_health', 'level:promote']);
        assert.equal(step(L5, bad, 0, null).earned, 5);
    });
});

describe('demotion', () => {
    it('drops 2 levels under 85% delivered or over 20% stuck, 1 under 90% delivered or 5% replies', () => {
        const two = step(L6, { sent: 100, delivered: 80, failed: 0, stuck: 20 }, 0, { level: 6 });
        assert.deepEqual([two.level, two.state.level, two.state.demotedAt], [4, 4, at(0).toISOString()]);
        assert.deepEqual(reasons(two), ['level:demote_delivery']);
        assert.deepEqual(healthCheck({ sent: 100, delivered: 75, stuck: 25 }).drop, 2);
        assert.equal(healthCheck({ sent: 100, delivered: 86, stuck: 21 }, { ...BRAKES }).drop, 2, 'stuck over 20%');

        const one = step(L6, { sent: 100, delivered: 88, failed: 2, stuck: 10 }, 0, { level: 6 });
        assert.deepEqual([one.level, reasons(one)], [5, ['level:demote_delivery']]);
        const quiet = step(L6, { ...GOOD, reached: 100, replied: 3 }, 0, { level: 6 });
        assert.deepEqual([quiet.level, reasons(quiet)], [5, ['level:demote_replies']]);
        assert.equal(step(L6, { sent: 100, delivered: 50, failed: 0, stuck: 50 }, 0, { level: 2 }).level, 1, 'never below 1');
    });

    it('shadow mode only notes it', () => {
        const lv = step(L6, { sent: 100, delivered: 80, failed: 0, stuck: 20 }, 0, { level: 6 }, BRAKES);
        assert.deepEqual([lv.level, lv.state.level, lv.state.demotedAt], [6, 6, null]);
        assert.deepEqual(reasons(lv), ['shadow:demote_delivery']);
        assert.deepEqual([lv.changes[0].from, lv.changes[0].to, lv.changes[0].daily], [6, 4, true]);
    });
});

describe('probation after a demotion', () => {
    const BAD = { sent: 100, delivered: 80, failed: 0, stuck: 20 };

    it('no promotion for 48h, then two passing checks at least 6h apart', () => {
        let lv = step(L6, BAD, 0, { level: 6 });
        assert.equal(lv.state.level, 4);
        lv = step(L6, GOOD, 47, lv.state);
        assert.deepEqual([lv.level, lv.state.cleanChecks, reasons(lv)], [4, 0, ['level:hold_probation']]);
        assert.deepEqual(lv.probation, { since: at(0).toISOString(), until: at(48).toISOString(), cleanChecks: 0, needs: 2 });
        lv = step(L6, GOOD, 49, lv.state);
        assert.deepEqual([lv.level, lv.state.cleanChecks], [4, 1]);
        lv = step(L6, GOOD, 52, lv.state);
        assert.deepEqual([lv.level, lv.state.cleanChecks], [4, 1], 'under 6h after the last check');
        lv = step(L6, GOOD, 55, lv.state);
        // The demotion is kept (it bounds the health window) until it is 7 days old; probation is over.
        assert.deepEqual([lv.level, lv.state.demotedAt, lv.state.cleanChecks, lv.probation], [6, at(0).toISOString(), 2, null]);
        assert.deepEqual(reasons(lv), ['level:promote']);
        lv = step(L6, GOOD, 61, lv.state);
        assert.deepEqual([lv.level, lv.probation, reasons(lv)], [6, null, []]);
        lv = step(L6, GOOD, 7 * 24 + 1, lv.state);
        assert.deepEqual([lv.level, lv.state.demotedAt, lv.state.cleanChecks], [6, null, 0], 'forgotten once 7 days old');
    });

    it('a failing check starts the count again; one with too few sends counts neither way', () => {
        let lv = step(L6, BAD, 0, { level: 6 });
        lv = step(L6, GOOD, 49, lv.state);
        assert.equal(lv.state.cleanChecks, 1);
        lv = step(L6, { sent: 100, delivered: 91, failed: 0, stuck: 9 }, 55, lv.state);
        assert.deepEqual([lv.level, lv.state.cleanChecks], [4, 0], 'held, not demoted again: 91% is above 90%');
        lv = step(L6, { sent: 5, delivered: 5, failed: 0, stuck: 0 }, 61, lv.state);
        assert.deepEqual([lv.level, lv.state.cleanChecks], [4, 0]);
        lv = step(L6, GOOD, 62, lv.state);
        assert.equal(lv.state.cleanChecks, 1);
        lv = step(L6, GOOD, 68, lv.state);
        assert.equal(lv.level, 6);
    });
});

describe('idle decay', () => {
    const idleAt = (days, start = null) => levelFor({ ...L5, health: GOOD, lastDeliveredBefore: at(-days * 24).toISOString() },
        { now: at(0), dayStart: at(0), start, startedAt: start ? at(-90 * 24).toISOString() : '' });

    it('one level after 3 quiet days, one more every further 3, down to the starting level', () => {
        assert.deepEqual([2, 4, 7, 10, 30].map((d) => idleAt(d).level), [5, 4, 3, 2, 1]);
        assert.equal(idleAt(30, 3).level, 3, 'not below its start');
        const lv = idleAt(7);
        assert.deepEqual(lv.changes.map((c) => [c.kind, c.reason, c.from, c.to, c.daily]), [['level', 'idle', 5, 3, true]]);
    });
});

describe('level audit rows', () => {
    /** A number started at level 6 a month ago, under the given mode, with 31 sends of which 21 were delivered. */
    function setup(channelId, mode) {
        const db = freshDb();
        createChannelOps({ db, tenancy: null, runtimes: new Map() });
        const ch = db.forTenant(1).forChannel(channelId);
        const sent = (hours, status) => {
            seq += 1;
            ch.insert({ messageId: `a${seq}`, recipient: `9181${String(seq).padStart(7, '0')}`, message: 'm', status, messageType: 'campaign', createdAt: ago(hours * HOUR), sentAt: ago(hours * HOUR) });
        };
        sent(30, Status.DELIVERED);
        for (let i = 0; i < 20; i += 1) sent(3 + (i % 10), Status.DELIVERED);
        for (let i = 0; i < 10; i += 1) sent(4, Status.SENT);
        ch.saveLevelState({ level: 6, demotedAt: null, cleanChecks: 0, checkedAt: null });
        return { db, ch, quota: quotaOn(ch, 6, mode) };
    }

    it('enforce: a demotion is applied and audited once, then probation holds', () => {
        const { db, ch, quota } = setup(1, 'enforce');
        const a = quota.allowance();
        assert.equal(a.level.level, 4);
        assert.equal(a.level.probation.cleanChecks, 0);
        assert.equal(ch.levelState().level, 4);
        assert.ok(ch.levelState().demotedAt);
        quota.invalidate();
        assert.equal(quota.allowance().level.level, 4, 'health now counts from the demotion: no second drop');
        const events = ch.levelEvents(ago(DAY));
        assert.deepEqual(events.filter((e) => e.reason.startsWith('demote')).map((e) => [e.shadow, e.reason, e.from, e.to]),
            [[false, 'demote_delivery', 6, 4]]);
        assert.ok(events.some((e) => e.reason === 'hold_probation'));
        assert.equal(ch.safetyEvents().length, 0, 'level rows are not a person\'s block or report');
        db.close();
    });

    it('shadow: the demotion is a shadow row, never applied, and not a brake', () => {
        const { db, ch, quota } = setup(2, 'shadow');
        assert.equal(quota.allowance().level.level, 6);
        assert.deepEqual([ch.levelState().level, ch.levelState().demotedAt], [6, null]);
        const [row] = ch.levelEvents(ago(DAY));
        assert.deepEqual([row.shadow, row.reason, row.from, row.to], [true, 'demote_delivery', 6, 4]);
        assert.equal(ch.brakeEvents(ago(DAY)).length, 0);
        quota.invalidate();
        quota.allowance();
        assert.equal(ch.levelEvents(ago(DAY)).length, 1, 'once a day');
        db.close();
    });

    /** A channel of a fresh db (channel_ops migrated), and a sender of `n` sends `hours` ago, `bad` of them one tick. */
    function channel(channelId) {
        const db = freshDb();
        createChannelOps({ db, tenancy: null, runtimes: new Map() });
        const ch = db.forTenant(1).forChannel(channelId);
        const sends = (hours, n, bad = 0) => {
            for (let i = 0; i < n; i += 1) {
                seq += 1;
                ch.insert({ messageId: `p${seq}`, recipient: `9182${String(seq).padStart(7, '0')}`, message: 'm', status: i < bad ? Status.SENT : Status.DELIVERED,
                    messageType: 'campaign', createdAt: ago(hours * HOUR), sentAt: ago(hours * HOUR) });
            }
        };
        return { db, ch, sends };
    }

    it('enforce: a probation promotion is not undone by the sends from before the demotion', () => {
        const { db, ch, sends } = channel(3);
        sends(96, 100, 20); // the bad stretch, before the demotion: 80% delivered
        sends(26, 100, 2); // after it: 98%; over all 7 days 89%, under the 90% line
        ch.saveLevelState({ level: 4, demotedAt: ago(72 * HOUR), cleanChecks: 1, checkedAt: ago(7 * HOUR) });
        const quota = quotaOn(ch, 6, 'enforce');
        assert.equal(quota.allowance().level.level, 6, 'the second passing check promotes');
        quota.invalidate();
        const again = quota.allowance(new Date(Date.now() + 60_000));
        assert.deepEqual([again.level.level, again.level.probation, ch.levelState().level], [6, null, 6]);
        assert.ok(!ch.levelEvents(ago(DAY)).some((e) => e.reason.startsWith('demote')));
        db.close();
    });

    it('enforce: people reached within the day are not judged on replies yet', () => {
        const { db, ch, sends } = channel(4);
        sends(30, 1); // delivered before today: not idle
        sends(1, 60);
        ch.saveLevelState({ level: 6, demotedAt: null, cleanChecks: 0, checkedAt: null });
        const quota = new DailyQuota(ch, qr());
        quota.tables = () => ({ ...DEFAULT_SENDING, brakes: ENFORCE });
        quota.levelStart = () => ({ level: 6, answers: {}, at: ago(30 * DAY) });
        assert.equal(quota.allowance().level.level, 6);
        assert.equal(ch.levelState().level, 6);
        db.close();
    });

    it('a quota on the built-in tables (before the policy is wired) writes nothing', () => {
        const { db, ch, sends } = channel(5);
        sends(26, 100);
        const stored = { level: 4, demotedAt: ago(DAY), cleanChecks: 0, checkedAt: null };
        ch.saveLevelState(stored);
        new DailyQuota(ch, qr()).tier();
        assert.deepEqual(ch.levelState(), stored);
        assert.equal(ch.levelEvents(ago(DAY)).length, 0);
        db.close();
    });
});
