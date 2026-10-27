/**
 * Configurable sending tables: the `table` policy field, the sending.* rules
 * (policy/levels.js), levelFor's cap and pin, and the DailyQuota hooks that
 * carry them to a number.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { BillingStore } from '../src/billing/store.js';
import { BRAKES, LEVELS, levelFor } from '../src/campaign/humanize.js';
import { DEFAULT_SENDING, DailyQuota, estimateSeconds, paceFor } from '../src/campaign/safety.js';
import { Channels } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { POLICY_FIELDS, PolicyStore, cleanValue, fillTables } from '../src/policy/index.js';
import { Tenancy } from '../src/tenancy.js';
import { applySendingPolicy, sendingTables } from '../src/policy/levels.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-policy-levels-'));
const opened = [];
const freshDb = (name) => {
    const db = new Database(path.join(tmp, name));
    opened.push(db);
    return db;
};
after(() => {
    for (const db of opened) db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const DAY = 86_400_000;
const field = (key) => POLICY_FIELDS.find((f) => f.key === key);
const copy = (rows) => JSON.parse(JSON.stringify(rows));
const ago = (ms) => new Date(Date.now() - ms).toISOString();
/**
 * A ledger that has earned level 5 and delivered yesterday. Its clean week at 1000 a day keeps the growth cap
 * (campaign/safety.js growthFrom) out of these level tests.
 */
const GROWN = Object.freeze({ hasHistory: true, bestCleanDay7: 1000 });
const LEVEL5 = Object.freeze({ activeDays: 12, delivered: 220, bulkDelivered: 90, lastDeliveredBefore: ago(DAY), ...GROWN });

describe('table policy fields', () => {
    it('the resolved defaults are the built-in tables', () => {
        const db = freshDb('d.db');
        const { values } = new PolicyStore(db).resolve(1);
        assert.deepEqual(values['sending.levels'], LEVELS);
        assert.equal(values['sending.maxLevel'], null);
        assert.deepEqual(sendingTables(values), { ...DEFAULT_SENDING, brakes: { ...BRAKES }, planDaily: 250 });
    });

    it('cleans rows: fixed and null cells keep the default, unknown keys go', () => {
        const rows = copy(LEVELS);
        rows[3].level = 99;
        rows[0].need = { days: 5, delivered: 5, bulk: 5 };
        rows[3].dailyLimit = '45';
        rows[3].junk = 'x';
        const out = cleanValue(field('sending.levels'), rows);
        assert.equal(out[3].level, 3);
        assert.equal(out[0].need, null);
        assert.equal(out[3].dailyLimit, 45);
        assert.equal('junk' in out[3], false);
    });

    it('refuses a wrong row count, bad cells and broken tables', () => {
        const levels = field('sending.levels');
        const bad = (mutate, pattern) => {
            const rows = copy(LEVELS);
            mutate(rows);
            assert.throws(() => cleanValue(levels, rows), pattern);
        };
        assert.throws(() => cleanValue(levels, copy(LEVELS).slice(1)), /exactly 12 rows/);
        bad((r) => { r[2].dailyLimit = -1; }, /between/);
        bad((r) => { r[2].name = ' '; }, /required/);
        bad((r) => { r[2].quietHours = [8, 6]; }, /from is above to/);
        bad((r) => { r[2].minSeconds = 500; }, /min gap is above max gap/);
        bad((r) => { r[5].need.delivered = 10; }, /must not be below level 4/);
    });

    it('an admin table is stored and resolved per tenant', () => {
        const db = freshDb('s.db');
        const store = new PolicyStore(db);
        const rows = copy(LEVELS);
        rows[1].dailyLimit = 3;
        store.set('tenant:1', { 'sending.levels': rows, 'sending.daytimeFrom': 8 });
        const tables = sendingTables(store.resolve(1).values);
        assert.equal(tables.levels[1].dailyLimit, 3);
        assert.equal(tables.brakes.daytimeFrom, 8);
        assert.deepEqual(sendingTables(store.resolve(2).values).levels, LEVELS);
    });

    it('refuses a backwards daytime window against the scope, a 0% pause and a fuzzy bool cell', () => {
        const store = new PolicyStore(freshDb('x.db'));
        assert.throws(() => store.set('global', { 'sending.daytimeFrom': 21 }), /start before it ends/);
        store.set('global', { 'sending.daytimeTo': 23 });
        assert.throws(() => store.set('global', { 'sending.daytimeFrom': 23 }), /start before it ends/);
        store.set('global', { 'sending.daytimeFrom': 22 });
        assert.throws(() => store.set('global', { 'sending.daytimeTo': null }), /start before it ends/, 'reset to 21 would run backwards');
        assert.throws(() => store.set('global', { 'sending.blockPausePercent': 0 }), /between 1 and 100/);
        // Checked over the layers beneath, not built-in defaults.
        store.set('global', { 'sending.daytimeFrom': null, 'sending.daytimeTo': 24 });
        store.set('plan:pro', { 'sending.daytimeFrom': 22 });
        store.set('tenant:7', { 'sending.daytimeFrom': 22 });
        store.set('global', { 'sending.daytimeTo': 18 });
        assert.throws(() => store.set('tenant:9', { 'sending.daytimeFrom': 19 }), /start before it ends/);
        assert.throws(() => store.set('tenant:9', { 'sending.daytimeTo': 8 }), /start before it ends/);
        const rows = copy(LEVELS);
        for (const [v, want] of [[true, true], ['false', false], ['1', true], ['0', false]]) {
            rows[2].media = v;
            assert.equal(cleanValue(field('sending.levels'), rows)[2].media, want, String(v));
        }
        for (const v of ['yes', 1, null, undefined]) {
            rows[2].media = v;
            assert.throws(() => cleanValue(field('sending.levels'), rows), /true or false/, String(v));
        }
    });
});

describe('levelFor cap and pin', () => {
    it('min(cap, pin ?? natural)', () => {
        assert.equal(levelFor(LEVEL5).level, 5);
        const capped = levelFor(LEVEL5, { cap: 3 });
        assert.deepEqual([capped.level, capped.natural, capped.capped, capped.row.level], [3, 5, true, 3]);
        const pinned = levelFor(LEVEL5, { pin: 7 });
        assert.deepEqual([pinned.level, pinned.earned, pinned.pinned], [7, 5, true]);
        assert.equal(levelFor(LEVEL5, { pin: 7, cap: 6 }).level, 6);
    });

    it('a pin skips the rest and the idle step-down, but not the brakes', () => {
        const fresh = { activeDays: 0, delivered: 0, bulkDelivered: 0, reached: 50, replied: 1 };
        const lv = levelFor(fresh, { linkedAt: new Date().toISOString(), pin: 2 });
        assert.equal(lv.level, 2);
        assert.equal(lv.natural, 0, 'the rest still shows as the natural level');
        assert.equal(lv.resting.active, false);
        assert.ok(lv.brakes.some((b) => b.code === 'reply_rate'));
        const idle = { ...LEVEL5, lastDeliveredBefore: ago(10 * DAY) };
        assert.equal(levelFor(idle).level, 2, 'one level per 3 quiet days: 10 days drop 3');
        assert.equal(levelFor(idle, { pin: 5 }).level, 5);
        assert.ok(!levelFor(idle, { pin: 5 }).brakes.some((b) => b.code === 'idle'));
    });

    it('reads its tables and brakes from the arguments', () => {
        const levels = copy(LEVELS);
        levels[5].need = { days: 100, delivered: 100000, bulk: 100000 };
        for (const row of levels.slice(6)) row.need = levels[5].need;
        assert.equal(levelFor(LEVEL5, { levels }).level, 4);
        const ledger = { ...LEVEL5, reached: 50, replied: 5 };
        assert.ok(levelFor(ledger).brakes.some((b) => b.code === 'reply_rate'));
        assert.ok(!levelFor(ledger, { brakes: { ...BRAKES, replyMinPercent: 5 } }).brakes.some((b) => b.code === 'reply_rate'));
    });
});

describe('DailyQuota hooks', () => {
    const qr = (extra = {}) => ({ ...DEFAULTS, transport: TRANSPORT_BAILEYS, ...extra });
    const quotaFor = (ledger, config = qr()) => new DailyQuota({ sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0, ...ledger }) }, config);

    it('defaults match the built-in tables', () => {
        const quota = quotaFor(LEVEL5);
        assert.equal(quota.tables(), DEFAULT_SENDING);
        assert.equal(quota.allowance().level.level, 5);
        assert.equal(quota.allowance().content.varyAbove, 15);
    });

    it('tables: an edited level, a cap and a vary ceiling reach the budgets', () => {
        const levels = copy(LEVELS);
        levels[5].dailyLimit = 7;
        const quota = quotaFor(LEVEL5);
        quota.tables = () => ({ ...DEFAULT_SENDING, levels, qrVaryAbove: 5 });
        assert.equal(quota.limitOn(), 7);
        assert.equal(quota.allowance().content.varyAbove, 5);
        quota.tables = () => ({ ...DEFAULT_SENDING, maxLevel: 2 });
        quota.invalidate();
        const a = quota.allowance();
        assert.deepEqual([a.level.level, a.level.earned, a.level.capped, a.budgets.bulk.limit], [2, 5, true, LEVELS[2].dailyLimit]);
        // A cap of 0 stops the number: no borrowed level-1 day.
        quota.tables = () => ({ ...DEFAULT_SENDING, maxLevel: 0 });
        quota.invalidate();
        assert.deepEqual([quota.allowance().level.level, quota.allowance().perDay], [0, 0]);
    });

    it('a pin applies, and a ban after the pin voids it', () => {
        const quota = quotaFor(LEVEL5);
        quota.levelPin = () => ({ level: 7, at: ago(DAY) });
        assert.equal(quota.allowance().level.level, 7);
        assert.equal(quota.allowance().level.pinned, true);
        const banned = quotaFor({ ...LEVEL5, lastBanAt: ago(3600_000) });
        banned.levelPin = () => ({ level: 7, at: ago(DAY) });
        assert.equal(banned.allowance().level.pinned, false);
        const later = quotaFor({ ...LEVEL5, lastBanAt: ago(2 * DAY) });
        later.levelPin = () => ({ level: 7, at: ago(DAY) });
        assert.equal(later.allowance().level.level, 7, 'a pin set after the ban stands');
    });

    it('a different number linked after the pin voids it', () => {
        const relinked = quotaFor({ ...LEVEL5, anchor: ago(3600_000) });
        relinked.levelPin = () => ({ level: 7, at: ago(DAY) });
        assert.equal(relinked.allowance().level.pinned, false);
        const same = quotaFor({ ...LEVEL5, anchor: ago(2 * DAY) });
        same.levelPin = () => ({ level: 7, at: ago(DAY) });
        assert.equal(same.allowance().level.pinned, true, 'a pin set after the number took over stands');
    });

    it('a malformed pin is ignored instead of breaking every send', () => {
        for (const level of [-1, 2.5, '2.5', '3', null]) {
            const quota = quotaFor(LEVEL5);
            quota.levelPin = () => ({ level, at: ago(DAY) });
            assert.deepEqual([quota.allowance().level.level, quota.allowance().level.pinned], [5, false], String(level));
        }
    });

    it('applySendingPolicy wires the tables and the pin from policy values', () => {
        const quota = applySendingPolicy(quotaFor(LEVEL5), { 'sending.maxLevel': 3 }, () => ({ level: 4, at: ago(DAY) }));
        const a = quota.allowance();
        assert.deepEqual([a.level.level, a.level.cap, a.level.pinned], [3, 3, true]);
    });

    it('brakes off drops every brake but WhatsApp\'s restriction, until it ends or a ban voids it', () => {
        const braked = { ...LEVEL5, ok24: 10, failed24: 10, restrictedUntil: new Date(Date.now() + DAY).toISOString() };
        const codes = (q) => q.allowance().brakes.map((b) => b.code).sort();
        const on = quotaFor(braked);
        assert.deepEqual(codes(on), ['failures', 'restricted']);
        const off = quotaFor(braked);
        off.levelPin = () => ({ level: null, brakesOff: { until: new Date(Date.now() + DAY).toISOString(), at: ago(3600_000) } });
        assert.deepEqual(codes(off), ['restricted']);
        assert.equal(off.allowance().level.pinned, false, 'brakes off alone pins no level');
        assert.ok(off.allowance().level.brakesOff);
        const ended = quotaFor(braked);
        ended.levelPin = () => ({ level: null, brakesOff: { until: ago(60_000), at: ago(DAY) } });
        assert.deepEqual([codes(ended), ended.allowance().level.brakesOff], [['failures', 'restricted'], null]);
        const banned = quotaFor({ ...braked, lastBanAt: ago(60_000) });
        banned.levelPin = () => ({ level: null, brakesOff: { until: new Date(Date.now() + DAY).toISOString(), at: ago(3600_000) } });
        assert.equal(banned.allowance().level.brakesOff, null);
    });

    it('strong engagement only logs (shadow) the level 25% lower volume needs would reach', () => {
        const ledger = {
            activeDays: 17, delivered: 400, bulkDelivered: 160, lastDeliveredBefore: ago(DAY),
            health: { sent: 100, delivered: 98, reached: 40, replied: 15 },
        };
        const lv = levelFor(ledger, { state: { level: 5 } });
        assert.equal(lv.level, 5, 'nothing applied');
        const note = lv.changes.find((c) => c.reason === 'engaged');
        assert.deepEqual([note?.kind, note?.to], ['shadow', 6]);
        const quiet = levelFor({ ...ledger, health: { ...ledger.health, replied: 8 } }, { state: { level: 5 } });
        assert.equal(quiet.changes.some((c) => c.reason === 'engaged'), false, '20% replied is not engaged enough');
    });

    it('a business ban hold keeps each number at the level it had reached', () => {
        const hold = new Date(Date.now() + DAY).toISOString();
        const quota = new DailyQuota({
            sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0, ...LEVEL5 }),
            levelState: () => ({ level: 3 }),
            tenantBanHold: () => hold,
        }, qr());
        assert.deepEqual([quota.allowance().level.level, quota.allowance().level.banHold], [3, hold]);
        const free = new DailyQuota({
            sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0, ...LEVEL5 }),
            levelState: () => ({ level: 3 }),
            tenantBanHold: () => null,
        }, qr());
        assert.equal(free.allowance().level.level, 5);
    });

    it('tenantBanHold: a 2nd ban within 30 days across numbers holds 14 days from it', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-banhold-'));
        const db = new Database(path.join(dir, 'b.db'));
        try {
            const ban = (channelId, at) => db.db.prepare(
                "INSERT INTO safety_events (tenant_id, channel_id, kind, phone, message_id, at) VALUES (1, ?, 'ban', ?, ?, ?)",
            ).run(channelId, `n${channelId}`, at.slice(0, 10), at);
            ban(1, ago(40 * DAY));
            ban(2, ago(5 * DAY));
            assert.equal(db.tenantBanHold(), null, '35 days apart is not a pattern');
            const second = ago(2 * DAY);
            ban(3, second);
            assert.equal(Date.parse(db.tenantBanHold()), Date.parse(second) + 14 * DAY);
        } finally {
            db.close();
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('skipGrowth lets the bulk day reach the level day at once', () => {
        const ledger = { ...LEVEL5, hasHistory: true, bestCleanDay7: 10 };
        const quota = quotaFor(ledger);
        assert.equal(quota.allowance().budgets.bulk.limit, 13, '35% over the best day');
        quota.tables = () => ({ ...DEFAULT_SENDING, skipGrowth: true });
        quota.invalidate();
        assert.equal(quota.allowance().budgets.bulk.limit, LEVELS[5].dailyLimit);
        assert.equal(sendingTables({ 'sending.skipGrowthCap': true }).skipGrowth, true);
    });

});

describe('the ladder to 1000 a day', () => {
    const qr = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, dailyLimit: 0 };
    const quotaFor = (ledger, values = {}, config = qr) => applySendingPolicy(
        new DailyQuota({ sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0, ...ledger }) }, config), values);
    /** Every need of level 11 met, delivered yesterday. */
    const TOP = Object.freeze({ activeDays: 45, delivered: 12000, bulkDelivered: 6000, lastDeliveredBefore: ago(DAY), ...GROWN });
    const ENTERPRISE = { 'channels.dailyCap': 1000 };

    it('levels 9-11 are 400 / 650 / 1000 a day, with links and media as at level 8', () => {
        assert.equal(LEVELS.length, 12);
        assert.deepEqual(LEVELS.slice(9).map((r) => r.dailyLimit), [400, 650, 1000]);
        for (const row of LEVELS.slice(9)) assert.deepEqual([row.links, row.media], [LEVELS[8].links, LEVELS[8].media]);
        assert.equal(field('sending.maxLevel').max, LEVELS.length - 1);
        assert.equal(cleanValue(field('sending.levels'), copy(LEVELS)).length, 12, 'the built-in table passes its own checks');
    });

    it('a full day of levels 9-11 fits the 12-hour recipient daytime', () => {
        const daytime = (BRAKES.daytimeTo - BRAKES.daytimeFrom) * 3600;
        for (const row of LEVELS.slice(9)) {
            // Typical gaps and rests, the average day multiplier (0.8-1.3), and every quiet window in the day.
            const pace = paceFor(row.dailyLimit, {}, 'balanced', row);
            const busy = estimateSeconds(row.dailyLimit, pace).typical * 1.05 + row.quietHours[1] * 3600;
            assert.ok(busy <= daytime, `level ${row.level}: ${Math.round(busy / 360) / 10}h`);
            assert.ok(row.dailyLimit / row.perHour <= 12, `level ${row.level}: the hourly budget fits`);
            assert.ok(row.perHour <= 100 && row.maxSeconds <= 50, `level ${row.level}: no faster than ~100 an hour`);
        }
    });

    it('level 11 gives 1000 a day only when every need is met', () => {
        assert.deepEqual([quotaFor(TOP, ENTERPRISE).allowance().level.level, quotaFor(TOP, ENTERPRISE).limitOn()], [11, 1000]);
        for (const short of [{ activeDays: 44 }, { delivered: 11999 }, { bulkDelivered: 5999 }]) {
            const quota = quotaFor({ ...TOP, ...short }, ENTERPRISE);
            assert.deepEqual([quota.allowance().level.level, quota.limitOn()], [10, 650], JSON.stringify(short));
        }
        // The brakes still apply at the top: a low reply rate halves the day.
        assert.equal(quotaFor({ ...TOP, reached: 100, replied: 5 }, ENTERPRISE).limitOn(), 500);
    });

    it('the plan day caps the level, read live from policy', () => {
        const starter = quotaFor(TOP, { 'channels.dailyCap': 250 });
        assert.deepEqual([starter.allowance().level.level, starter.limitOn(), starter.planLimit()], [8, 250, 250]);
        let values = { 'channels.dailyCap': 500 };
        const live = quotaFor(TOP, () => values);
        assert.equal(live.limitOn(), 500);
        values = ENTERPRISE;
        live.invalidate();
        assert.equal(live.limitOn(), 500, 'policy is re-read every 5s');
        // The number's own (or the tenant's safety) day still only ever lowers it.
        assert.equal(quotaFor(TOP, ENTERPRISE, { ...qr, dailyLimit: 300 }).limitOn(), 300);
        // A number below the plan day keeps its level's day.
        assert.equal(quotaFor(LEVEL5, ENTERPRISE).limitOn(), LEVELS[5].dailyLimit);
    });

    it('the day ceiling caps the level row too: pace, hour and new chats stay those of the plan day', () => {
        const starter = quotaFor(TOP, { 'channels.dailyCap': 250 }).allowance();
        assert.equal(starter.row, LEVELS[8]);
        assert.deepEqual([starter.budgets.hour.limit, starter.budgets.newChats.limit], [LEVELS[8].perHour, LEVELS[8].newChats]);
        const business = quotaFor(TOP, { 'channels.dailyCap': 500 });
        assert.deepEqual([business.allowance().level.level, business.limitOn()], [10, 500]);
        // The number's own day caps the level the same way, and a pin cannot climb past either.
        assert.equal(quotaFor(TOP, ENTERPRISE, { ...qr, dailyLimit: 300 }).allowance().level.level, 9);
        const pinned = quotaFor(LEVEL5, { 'channels.dailyCap': 250 });
        pinned.levelPin = () => ({ level: 11, at: ago(DAY) });
        assert.deepEqual([pinned.allowance().level.level, pinned.allowance().level.pinned], [8, true]);
    });

    it('applying policy drops an allowance cached from the built-in tables', () => {
        const quota = new DailyQuota({ sendingLedger: () => ({ bulkToday: 0, lastHour: 0, newChatsToday: 0, ...TOP }) }, qr);
        assert.equal(quota.limitOn(), 1000, 'no plan day yet');
        applySendingPolicy(quota, { 'channels.dailyCap': 250 });
        assert.equal(quota.limitOn(), 250);
    });

    it('a lapsed tenant dailyLimit override falls back to no own ceiling, not 250', () => {
        const db = freshDb('lapsed.db');
        const tenancy = new Tenancy(db);
        const t = tenancy.createTenant('Lapsed', 'lapsed');
        tenancy.setCustomSafety(t.id, { dailyLimit: 300 });
        const tenant = tenancy.getTenant(t.id);
        assert.equal(tenancy.customSafetyActive(tenant), false);
        const enforced = tenancy.enforcedSafety(tenant);
        assert.equal(enforced.dailyLimit, 0);
        assert.equal(quotaFor(TOP, ENTERPRISE, { ...qr, ...enforced }).limitOn(), 1000);
        tenancy.setSafety(t.id, { dailyLimit: 200 });
        assert.equal(tenancy.enforcedSafety(tenancy.getTenant(t.id)).dailyLimit, 200, 'an admin value still wins');
    });

    it('each built-in plan resolves to its own day: Starter stops at 250, Enterprise reaches 1000', () => {
        const db = freshDb('plans.db');
        const store = new PolicyStore(db);
        new BillingStore(db.forTenant(1)).subscribe(1, 'starter');
        new BillingStore(db.forTenant(2)).subscribe(2, 'enterprise');
        assert.equal(sendingTables(store.resolve(1).values).planDaily, 250);
        assert.equal(sendingTables(store.resolve(2).values).planDaily, 1000);
        assert.equal(quotaFor(TOP, store.resolve(1).values).limitOn(), 250);
        assert.equal(quotaFor(TOP, store.resolve(2).values).limitOn(), 1000);
        store.set('tenant:2', { 'channels.dailyCap': 400 });
        assert.equal(quotaFor(TOP, store.resolve(2).values).limitOn(), 400, 'a tenant override wins over the plan');
    });

    it('runs a levels table saved with the old row count as saved, held at its old top, and reports it', () => {
        const db = freshDb('stale.db');
        const store = new PolicyStore(db);
        const old = copy(LEVELS.slice(0, 9));
        old[1].dailyLimit = 3;
        db.db.prepare("INSERT INTO platform_policy (scope, key, value, updated_at) VALUES ('tenant:1', 'sending.levels', ?, '')")
            .run(JSON.stringify(old));
        const tables = sendingTables(store.resolve(1).values);
        assert.deepEqual([tables.levels.length, tables.levels[1].dailyLimit, tables.maxLevel], [12, 3, 8]);
        assert.equal(sendingTables({ ...store.resolve(1).values, 'sending.maxLevel': 5 }).maxLevel, 5, 'a lower cap stands');
        assert.equal(quotaFor(TOP, store.resolve(1).values).allowance().level.level, 8);
        assert.equal(fillTables(store.values('tenant:1'))['sending.levels'].length, 12, 'the editor gets every row');
        assert.deepEqual(store.staleTables(), [{ scope: 'tenant:1', key: 'sending.levels', rows: 9, expected: 12 }]);
        store.set('tenant:1', { 'sending.levels': copy(LEVELS) });
        assert.deepEqual(store.staleTables(), [], 'saving again clears it');
    });
});

describe('admin level pin route', () => {
    let app;
    let server;
    let base;
    let sup;
    let tenant;
    let other;
    let db;
    let qrId;
    let plainId;
    const call = async (token, method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };
    const pin = (id, level) => call(sup, 'PUT', `/api/admin/numbers/${id}/level`, { level });
    const audits = (action) => db.db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY id').all(action);

    before(async () => {
        db = freshDb('pin.db');
        app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        sup = sessionFor(app, { role: 'super_admin' });
        const { tenancy } = app.locals;
        tenant = tenancy.createTenant('Pin Shop', 'pin-shop');
        other = tenancy.createTenant('Pin Other', 'pin-other');
        const channels = new Channels(db.forTenant(tenant.id));
        qrId = channels.create({ displayName: 'QR', settings: { transport: TRANSPORT_BAILEYS, autoConnect: false } }).id;
        plainId = channels.create({ displayName: 'Sandbox', settings: { transport: TRANSPORT_SANDBOX, autoConnect: false } }).id;
        new Channels(db.forTenant(other.id)).create({ displayName: 'Other', settings: { transport: TRANSPORT_SANDBOX, autoConnect: false } });
    });

    after(async () => {
        await closeApp(app);
        server?.close();
    });

    it('is super admin only and refuses a bad level or a non-QR number', async () => {
        const owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
        assert.equal((await call(owner, 'PUT', `/api/admin/numbers/${qrId}/level`, { level: 2 })).status, 403);
        for (const level of [LEVELS.length, -1, 2.5, '3', true]) {
            assert.equal((await pin(qrId, level)).status, 400, String(level));
        }
        assert.match((await pin(plainId, 2)).body.errors[0], /QR-login numbers only/);
        // No `level` key is a mistake, not an unpin.
        assert.equal((await call(sup, 'PUT', `/api/admin/numbers/${qrId}/level`, {})).status, 400);
        assert.equal(audits('channel.admin.level_pin').length, 0);
        assert.equal(audits('channel.admin.level_unpin').length, 0);
    });

    it('ends a QR number\'s wait after linking, super admin only, audited', async () => {
        const channels = new Channels(db.forTenant(tenant.id));
        const waitId = channels.create({ displayName: 'Fresh', settings: { transport: TRANSPORT_BAILEYS, autoConnect: false, linkedAt: new Date().toISOString() } }).id;
        const endWait = (token, id) => call(token, 'POST', `/api/admin/numbers/${id}/end-link-wait`);
        const owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
        assert.equal((await endWait(owner, waitId)).status, 403);
        assert.match((await endWait(sup, plainId)).body.errors[0], /QR-login numbers only/);

        const waitOf = async () => (await call(sup, 'GET', '/api/admin/health-detail')).body.channels
            .find((c) => c.id === waitId).level.linkWaitUntil;
        assert.ok(await waitOf(), 'the admin row shows the wait, so the End wait button appears');

        const res = await endWait(sup, waitId);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.resting, false);
        assert.equal(await waitOf(), null);
        assert.equal(channels.get(waitId).settings.linkedAt, '');
        assert.equal(audits('channel.admin.end_link_wait').length, 1);
    });

    it('pins above the earned level, audits it and shows it in health', async () => {
        const res = await pin(qrId, 7);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual(res.body, { earned: 1, pinned: 7, cap: null, effective: 7, aboveEarned: true });
        const [row] = audits('channel.admin.level_pin');
        assert.equal(row.tenant_id, tenant.id);
        assert.equal(row.target, String(qrId));
        assert.equal(row.detail, 'earned 1, pin 7, cap none');
        const health = (await call(sup, 'GET', '/api/admin/health-detail')).body.channels;
        const { level, earned, of, pinned, cap, start, asked, ready, growth, probation } = health.find((c) => c.id === qrId).level;
        assert.deepEqual({ level, earned, of, pinned, cap, start, asked }, {
            level: 7, earned: 1, of: LEVELS.length - 1, pinned: 7, cap: null, start: null, asked: false,
        }, 'never asked: its 2 questions wait');
        assert.deepEqual([ready, growth.mode, growth.cap, probation], [1, 'start', LEVELS[1].dailyLimit, null]);
        assert.equal(health.find((c) => c.id === plainId).level, null);
    });

    it('the tenant cap still wins over a pin', async () => {
        app.locals.policy.set(`tenant:${tenant.id}`, { 'sending.maxLevel': 3 });
        const res = await pin(qrId, 6);
        assert.deepEqual(res.body, { earned: 1, pinned: 6, cap: 3, effective: 3, aboveEarned: true });
        app.locals.policy.set(`tenant:${tenant.id}`, { 'sending.maxLevel': null });
    });

    it('null clears the pin', async () => {
        const res = await pin(qrId, null);
        assert.deepEqual(res.body, { earned: 1, pinned: null, cap: null, effective: 1, aboveEarned: false });
        assert.equal(audits('channel.admin.level_unpin').length, 1);
        assert.equal(app.locals.channelOps.pinOf(qrId), null);
    });

    it('turns a number\'s brakes off for a while and back on, super admin only, audited', async () => {
        const brakes = (token, hours) => call(token, 'PUT', `/api/admin/numbers/${qrId}/brakes`, { hours });
        const owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
        assert.equal((await brakes(owner, 24)).status, 403);
        for (const hours of [0, 721, 2.5, '24', true]) assert.equal((await brakes(sup, hours)).status, 400, String(hours));
        assert.equal((await call(sup, 'PUT', `/api/admin/numbers/${qrId}/brakes`, {})).status, 400, 'no key is a mistake, not "on"');
        assert.match((await call(sup, 'PUT', `/api/admin/numbers/${plainId}/brakes`, { hours: 1 })).body.errors[0], /QR-login numbers only/);

        const res = await brakes(sup, 24);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.ok(Date.parse(res.body.brakesOff.until) > Date.now() + 23 * 3_600_000);
        const shown = async () => (await call(sup, 'GET', '/api/admin/health-detail')).body.channels.find((c) => c.id === qrId).level.brakesOff;
        assert.ok(await shown());
        assert.equal(audits('channel.admin.brakes_off').length, 1);

        assert.deepEqual((await brakes(sup, null)).body, { brakesOff: null });
        assert.equal(await shown(), null);
        assert.equal(audits('channel.admin.brakes_on').length, 1);
    });

    it('moving a number clears its pin and its answers', async () => {
        await pin(qrId, 4);
        app.locals.channelOps.setStart(qrId, 8, { skipped: true });
        assert.equal(app.locals.channelOps.pinOf(qrId).level, 4);
        const moved = await call(sup, 'POST', `/api/admin/numbers/${qrId}/move`, { tenantId: other.id });
        assert.equal(moved.status, 200, JSON.stringify(moved.body));
        assert.equal(app.locals.channelOps.pinOf(qrId), null);
        assert.equal(app.locals.channelOps.startOf(qrId), null, 'the new business answers or skips with its own consent');
    });

    it('the policy route lists a table saved with the old row count', async () => {
        db.db.prepare("INSERT INTO platform_policy (scope, key, value, updated_at) VALUES (?, 'sending.levels', ?, '')")
            .run(`tenant:${other.id}`, JSON.stringify(copy(LEVELS.slice(0, 9))));
        const res = await call(sup, 'GET', '/api/admin/policy');
        assert.deepEqual(res.body.stale, [{ scope: `tenant:${other.id}`, key: 'sending.levels', rows: 9, expected: LEVELS.length }]);
        const pinned = await pin(qrId, LEVELS.length - 1);
        assert.equal(pinned.status, 200);
        assert.equal(pinned.body.effective, 8, 'the old table holds numbers at its old top meanwhile');
        // The editor gets every row, so saving the table back as it is clears the notice.
        const view = await call(sup, 'GET', `/api/admin/policy/tenant/${other.id}`);
        assert.equal(view.body.overrides['sending.levels'].length, LEVELS.length);
        const saved = await call(sup, 'PUT', `/api/admin/policy/tenant:${other.id}`, { values: { 'sending.levels': view.body.overrides['sending.levels'] } });
        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.deepEqual((await call(sup, 'GET', '/api/admin/policy')).body.stale, []);
    });
});
