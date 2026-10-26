/**
 * Sending safety: how fast a campaign is allowed to go, and how much it may
 * send in a day.
 *
 * Bulk sending is what gets a WhatsApp number banned, and a fixed interval is
 * the easiest pattern to spot: 300 messages, exactly 5.0s apart, is not a
 * person.  Two controls cover it:
 *
 *   1. Adaptive pacing - the gap between messages is drawn at random from the
 *      number's level range (humanize.js LEVELS).  Every so often the run
 *      takes a longer rest, the way a person putting a phone down would.
 *   2. A daily cap - the level's day, and no more than 35% over the best
 *      recent clean day (growthFrom).  When it is reached the campaign PAUSES
 *      rather than failing: the queued rows stay QUEUED and the run can
 *      continue tomorrow.
 *
 * Neither hides anything from WhatsApp.  They simply keep the volume and the
 * timing inside what a human account plausibly does, which is also the
 * difference between messaging contacts and spamming them.
 */

import { withinSendingWindow } from '../channels.js';
import { QR_TRANSPORTS } from '../config.js';
import { SUCCESS_STATUSES } from '../protocol.js';
import {
    BLOCK_PAUSE_MIN_SENT, BLOCK_PAUSE_PERCENT, BRAKES, HALTING_BRAKES, LEVELS, levelFor, wallClock,
} from './humanize.js';

const DAY_MS = 24 * 3600 * 1000;
/** Same words as the web's draft.ts OPT_OUT_TEXT; a STOP reply is handled by autoreply/optout.js. */
export const OPT_OUT_TEXT = 'Reply STOP to stop messages';
/** QR numbers: identical text never goes to more people than this, whatever the policy says. */
const QR_VARY_ABOVE = 15;

/**
 * The sending tables a DailyQuota reads through its `tables` hook: built in
 * here, replaced per tenant by platform policy (policy/levels.js sendingTables).
 * `maxLevel` null = no cap. `planDaily`: the plan's per-number day (channels.dailyCap), null = none.
 */
export const DEFAULT_SENDING = Object.freeze({
    levels: LEVELS,
    brakes: BRAKES,
    maxLevel: null,
    planDaily: null,
    blockPausePercent: BLOCK_PAUSE_PERCENT,
    blockPauseMinSent: BLOCK_PAUSE_MIN_SENT,
    qrVaryAbove: QR_VARY_ABOVE,
    /** Super admin only (sending.skipQuietTime): bulk ignores the daily rest windows and quiet hours. */
    skipQuiet: false,
    /** Super admin only (sending.skipLinkWait): no wait after a fresh link; a ban still rests the number. */
    skipLinkWait: false,
    /** Super admin (sending.carouselImages): send a carousel as one image per card instead of the swipe carousel. */
    carouselImages: false,
});

/** A safety rule refused the request. `status` is what the HTTP layer answers. */
export class SafetyError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/**
 * Identical text to hundreds of people is the strongest spam signal there is.
 * With `requireVariationAbove` set, a bigger campaign must vary per recipient:
 * a {a|b} spin or a {name}-style placeholder. Rows carrying their own message
 * are varied unless that same text repeats on more than the threshold. Returns the refusal text, or null.
 */
export function variationError(template, contacts, config = {}) {
    const above = Number(config.requireVariationAbove) || 0;
    const count = Array.isArray(contacts) ? contacts.length : 0;
    if (!above || count <= above) return null;
    const varied = (text) => /\{[^{}]*\|[^{}]*\}/.test(text) || /\{\s*[\w.]+\s*\}/.test(text);
    const own = contacts.map((c) => String(c?.extra?.message ?? c?.extra?.custom_message ?? '').trim());
    const repeats = new Map();
    let most = 0;
    for (const text of own) {
        if (!text || varied(text)) continue;
        repeats.set(text, (repeats.get(text) ?? 0) + 1);
        most = Math.max(most, repeats.get(text));
    }
    const refusal = `Campaigns to more than ${above} people must vary the message: add spintax like {Hi|Hello} `
        + 'or a placeholder like {name}. Identical bulk text gets numbers reported and blocked.';
    if (most > above) return refusal;
    if (varied(String(template ?? '')) || own.every(Boolean)) return null;
    return refusal;
}

/** QR numbers: the policy's variation threshold, never above `ceiling` (0 = unset = `ceiling`). */
export const qrVaryAbove = (config = {}, ceiling = QR_VARY_ABOVE) => Math.min(Number(config.requireVariationAbove) || ceiling, ceiling);

/**
 * Is bulk traffic allowed right now? The channel's own sending window, and the
 * platform's quiet hours (`quietHoursStart`..`quietHoursEnd`, channel timezone,
 * may wrap midnight; equal = off). Both reuse `withinSendingWindow`.
 */
export function bulkWindowOpen(channel, config = {}, at = new Date()) {
    if (channel && !withinSendingWindow(channel, at)) return false;
    const start = Math.floor(Number(config.quietHoursStart) || 0);
    const end = Math.floor(Number(config.quietHoursEnd) || 0);
    if (start === end) return true;
    const window = (from, to) => withinSendingWindow({
        timezone: channel?.timezone || 'UTC', businessHours: { start: `${from}:00`, end: `${to}:00` },
    }, at);
    // 21 -> 9 is quiet overnight, so 9..21 is open; 1 -> 6 is quiet inside one day.
    return start > end ? window(end, start) : !window(start, end);
}

export const SAFETY_DEFAULTS = Object.freeze({
    safetyEnabled: true,
    dailyLimit: 250,
    pacingMode: 'adaptive', // 'adaptive' | 'fixed'
    minDelaySeconds: 0,     // 0 = the level's gap
    maxDelaySeconds: 0,
    restEvery: 40,          // messages between long pauses (0 = never rest)
    restMinMinutes: 2,
    restMaxMinutes: 5,
});

/**
 * Operator-facing speed presets. `balanced` is the level's gaps as-is; `safe`
 * stretches every gap by half again; `fast` halves them but never goes under
 * the policy floor (`config.minDelaySeconds`, set by tenant/platform policy).
 * On a sending level (QR numbers) the level's gap is the floor: `fast` runs as `balanced`.
 */
export const PACING_PRESETS = Object.freeze(['safe', 'balanced', 'fast']);

export const pickPreset = (preset) => (PACING_PRESETS.includes(preset) ? preset : 'balanced');

/**
 * The pacing that applies to a batch of `batchSize` messages. A QR number's level row (humanize.js) sets the gap
 * and the rests; batch size does not. Without one (the sandbox, which never waits) only a policy gap applies.
 */
export function paceFor(batchSize, config = {}, preset = 'balanced', sendTier = null) {
    const onLevel = sendTier?.level !== undefined;
    if (onLevel && preset === 'fast') preset = 'balanced';
    const tier = sendTier ?? { minSeconds: 0, maxSeconds: 0 };
    // A policy gap replaces the tier's; on a level it only ever slows it down.
    let min = config.minDelaySeconds > 0 ? Math.max(config.minDelaySeconds, onLevel ? tier.minSeconds : 0) : tier.minSeconds;
    let max = config.maxDelaySeconds > 0
        ? Math.max(config.maxDelaySeconds, min, onLevel ? tier.maxSeconds : 0)
        : Math.max(tier.maxSeconds, min);
    if (preset === 'safe') {
        min *= 1.5;
        max *= 1.5;
    } else if (preset === 'fast') {
        const floor = config.minDelaySeconds > 0 ? config.minDelaySeconds : 0;
        min = Math.max(floor, min * 0.5);
        max = Math.max(min, max * 0.5);
    }
    return {
        preset: pickPreset(preset),
        batchSize,
        minSeconds: min,
        maxSeconds: max,
        restEvery: Math.max(0, sendTier?.restEvery ?? config.restEvery ?? SAFETY_DEFAULTS.restEvery),
        restMinSeconds: (sendTier?.restMinMinutes ?? config.restMinMinutes ?? SAFETY_DEFAULTS.restMinMinutes) * 60,
        restMaxSeconds: (sendTier?.restMaxMinutes ?? config.restMaxMinutes ?? SAFETY_DEFAULTS.restMaxMinutes) * 60,
    };
}

/**
 * How long to wait before sending message number `sentInRun + 1`.
 * Returns {seconds, resting} - `resting` marks the long pause, so the UI can
 * say why nothing is moving.
 */
export function nextDelay(pace, sentInRun, random = Math.random) {
    if (sentInRun <= 0) return { seconds: 0, resting: false }; // first one goes now
    if (pace.restEvery > 0 && sentInRun % pace.restEvery === 0) {
        const span = Math.max(0, pace.restMaxSeconds - pace.restMinSeconds);
        return { seconds: pace.restMinSeconds + random() * span, resting: true };
    }
    const span = Math.max(0, pace.maxSeconds - pace.minSeconds);
    return { seconds: pace.minSeconds + random() * span, resting: false };
}

/** Rough wall-clock cost of a batch, for the estimate shown before Start. */
export function estimateSeconds(count, pace) {
    if (count <= 1) return { min: 0, max: 0, typical: 0 };
    const gaps = count - 1;
    const rests = pace.restEvery > 0 ? Math.floor(gaps / pace.restEvery) : 0;
    const normal = gaps - rests;
    const restAvg = (pace.restMinSeconds + pace.restMaxSeconds) / 2;
    return {
        min: normal * pace.minSeconds + rests * pace.restMinSeconds,
        max: normal * pace.maxSeconds + rests * pace.restMaxSeconds,
        typical: normal * ((pace.minSeconds + pace.maxSeconds) / 2) + rests * restAvg,
    };
}

/**
 * Midnight for the day `at` falls in - the daily window boundary. `zone` (IANA)
 * is the sender's own clock, so the budget resets at THEIR 00:00; without one
 * it is the server's.
 */
export function dayStart(at = new Date(), zone = null) {
    if (zone) {
        // ponytail: a 24h day; a DST change inside it moves the boundary an hour, twice a year.
        const whole = Math.floor(at.getTime() / 1000) * 1000;
        return new Date(whole - wallClock(new Date(whole), zone).minute * 60_000);
    }
    const start = new Date(at);
    start.setHours(0, 0, 0, 0);
    return start;
}

export function dayEnd(at = new Date(), zone = null) {
    if (zone) return new Date(dayStart(at, zone).getTime() + DAY_MS);
    const end = dayStart(at);
    end.setDate(end.getDate() + 1);
    return end;
}

/** Brakes that close new chats (and `restricted` number checks too); the halting ones hold bulk as well. */
const CLOSES_NEW_CHATS = ['reports', 'blocks', 'failures', 'restricted', ...HALTING_BRAKES];

/** The lower of the plan's per-number day and the number's own `dailyLimit` (Infinity = neither is set). */
const dayCeiling = (config, planDaily) => Math.min(Number(config.dailyLimit) > 0 ? Number(config.dailyLimit) : Infinity,
    Number(planDaily) > 0 ? Number(planDaily) : Infinity);

/**
 * The level a day ceiling allows: the lowest level (1 up) whose day reaches it, or null (no cap). A 250-a-day
 * number then paces, and budgets its hour and new chats, as the level that sends 250, not as level 11 cut to 250.
 */
const ceilingLevel = (levels, ceiling) => (ceiling === Infinity ? null
    : levels.find((r) => r.level >= 1 && r.dailyLimit >= ceiling)?.level ?? null);

/**
 * The growth cap: the level's day is a destination, not a minimum. From the ledger (db.sendingLedger):
 *  - no delivered bulk before today (a new number, or history restarted by a ban or a number change): `startDaily`,
 *    the day the number started at (its questions' level, or level 1's);
 *  - else 35% over `bestCleanDay7`, the most bulk delivered in one day over the last 7, leaving out days a brake
 *    that really applied was on; 15% after any such brake in those 7 days, so a throttled number climbs back slowly;
 *  - no clean day in the 7 (a brake every day, or nothing sent): flat at the latest day's delivered count.
 * Never below `floor` (level 1's day) once there is history. `{ mode ('start' | 'grow' | 'flat'), cap, multiplier,
 * best, lastDay, brakeIn7d }`; allowanceFrom takes min(level day, cap).
 */
export function growthFrom(ledger = {}, { startDaily = LEVELS[1].dailyLimit, floor = LEVELS[1].dailyLimit } = {}) {
    const best = ledger.bestCleanDay7 ?? 0;
    const lastDay = ledger.lastDayDelivered ?? 0;
    const brakeIn7d = Boolean(ledger.brakeIn7d);
    const out = { best, lastDay, brakeIn7d };
    if (!ledger.hasHistory) return { mode: 'start', cap: startDaily, multiplier: null, ...out };
    if (!best) return { mode: 'flat', cap: Math.max(floor, lastDay), multiplier: 1, ...out };
    const multiplier = brakeIn7d ? 1.15 : 1.35;
    // The epsilon absorbs float error, so a product that should be whole (40 x 1.35 = 54) never floors one short.
    return { mode: 'grow', cap: Math.max(floor, Math.floor(best * multiplier + 1e-9)), multiplier, ...out };
}

/**
 * Today's budgets for a QR number, from its level (humanize.js levelFor) and
 * ledger (db.sendingLedger). `planDaily` (the plan's per-number day, read live
 * from channels.dailyCap) and `config.dailyLimit` (the number's own / the
 * tenant's safety ceiling) only ever lower a level. `perDay` / `newChatsPerDay`
 * are what a plan can count on at today's level: level 1's while the number rests.
 * The bulk budget is also held to the growth cap (growthFrom, `startDaily` its start).
 * `held`: the number's questions are unanswered (policy/levels.js startLevelFor), so no bulk yet.
 */
export function allowanceFrom(lv, ledger, config = {}, {
    resetsAt = null, levels = LEVELS, planDaily = null, held = false, startDaily = levels[1].dailyLimit,
} = {}) {
    const has = (code) => lv.brakes.some((b) => b.code === code);
    const half = (n) => (has('reply_rate') && n > 0 ? Math.max(1, Math.floor(n / 2)) : n);
    const ceiling = dayCeiling(config, planDaily);
    const planRow = levels[Math.max(1, lv.level)];
    // An admin cap of level 0 stops the number; level 0 otherwise borrows level 1's day (the rest after linking).
    const perDay = lv.capped && lv.level === 0 ? 0 : half(Math.min(planRow.dailyLimit, ceiling));
    const closing = lv.brakes.filter((b) => CLOSES_NEW_CHATS.includes(b.code));
    const growth = growthFrom(ledger, { startDaily, floor: levels[1].dailyLimit });
    const bulkLimit = lv.level && !held && !lv.brakes.some((b) => HALTING_BRAKES.includes(b.code)) ? Math.min(perDay, growth.cap) : 0;
    const chatLimit = closing.length ? 0 : half(lv.row.newChats);
    const hourLimit = half(lv.row.perHour);
    const chatsLeft = Math.max(0, chatLimit - ledger.newChatsToday);
    // When new chats open again: the last brake that shut them lifts (a rate brake has no end time, so tomorrow
    // stands in), else the rest ends, else tomorrow.
    const opens = closing.length ? closing.map((b) => b.until ?? resetsAt) : [lv.resting.endsAt ?? resetsAt];
    const opensAt = chatsLeft > 0 ? null : opens.sort().at(-1) ?? null;
    return {
        perDay,
        newChatsPerDay: half(planRow.newChats),
        growth,
        lookups: !has('restricted'),
        budgets: {
            bulk: { limit: bulkLimit, used: ledger.bulkToday, left: Math.max(0, bulkLimit - ledger.bulkToday), resetsAt },
            newChats: { limit: chatLimit, used: ledger.newChatsToday, left: chatsLeft, opensAt },
            hour: { limit: hourLimit, used: ledger.lastHour, left: Math.max(0, hourLimit - ledger.lastHour) },
        },
    };
}

/**
 * Brakes that make a day a brake day for the growth cap (growthFrom). The delivery, stuck and unstable ones reach
 * lv.brakes only once enforced, so shadow mode never marks a day. Not `ban` (the history restarts) or `idle`.
 */
const BRAKE_DAYS = ['reply_rate', 'reports', 'blocks', 'failures', 'restricted', ...HALTING_BRAKES];

/** A DailyQuota's tables until its owner sets them (policy/levels.js applySendingPolicy). */
const builtInTables = () => DEFAULT_SENDING;

/** Nothing sent yet: the ledger of a db handle without one (test doubles). */
const EMPTY_LEDGER = Object.freeze({ delivered: 0, bulkDelivered: 0, activeDays: 0, bulkToday: 0, lastHour: 0, newChatsToday: 0 });

/**
 * The daily cap.  Counted from the database, so a restart cannot reset it and
 * two campaigns in one day share one budget.  Only real deliveries count -
 * SANDBOX does not, because nothing left the machine.
 *
 * QR (Baileys) numbers run on sending levels: `tier()` is the level row, `limitOn()` / `remaining()` the bulk budget (0 means 0), and
 * `allowance()` everything else (new chats, the hour, brakes, content rules).
 */
export class DailyQuota {
    constructor(db, config) {
        this.db = db;
        this.config = config;
        /** () => the sender's IANA zone; the day (and so the reset) follows it. Set by the owner. */
        this.zone = () => null;
        /** () => the sending tables (DEFAULT_SENDING's shape). Set by the owner from platform policy. */
        this.tables = builtInTables;
        /** () => the admin's level pin for this number, `{ level, at }`, or null. Set by the owner. */
        this.levelPin = () => null;
        /**
         * () => the number's answered questions, `{ level, answers, at }`, or null. Set by the owner
         * (policy/levels.js applySendingPolicy); while unset nothing is asked, so nothing is held.
         */
        this.levelStart = null;
    }

    get limit() {
        return this.limitOn(new Date());
    }

    /** A QR-login number: sending levels apply. The sandbox keeps the plain `dailyLimit`. */
    get qr() {
        return QR_TRANSPORTS.includes(this.config.transport);
    }

    /** Drop the cached allowance: after a real send, a new transport, a new link or a ban. */
    invalidate() {
        this.allowanceCache = null;
    }

    /** A QR number's level, budgets, brakes and content rules today. Cached for 30s. */
    allowance(now = new Date()) {
        const t = now.getTime();
        if (!this.allowanceCache || Math.abs(t - this.allowanceCache.at) > 30_000) {
            const zone = this.zone();
            const start = dayStart(now, zone);
            const resetsAt = dayEnd(now, zone).toISOString();
            // The stored level state (policy/channelOps.js); health counts from the last demotion, so one bad
            // stretch demotes once and probation judges only what came after it.
            const state = this.qr ? this.db.levelState?.() ?? null : null;
            const ledger = this.db.sendingLedger?.({ dayStart: start, now, healthSince: state?.demotedAt ?? null }) ?? EMPTY_LEDGER;
            const tables = this.tables();
            const { levels } = tables;
            // A ban or a different number after the pin was set voids it (the ledger's anchor is the later
            // of the two): the number starts again from its history.
            const pin = this.levelPin();
            // A malformed pin (negative, fractional, a string) is no pin; levelFor clamps one above the top.
            const pinVoid = !Number.isInteger(pin?.level) || pin.level < 0
                || Date.parse(ledger.anchor ?? ledger.lastBanAt ?? '') > (Date.parse(pin.at ?? '') || 0);
            // The questions' start level, voided the same way: a ban or a new number asks them again.
            const answered = this.levelStart?.() ?? null;
            const startVoid = !Number.isInteger(answered?.level) || answered.level < 1
                || Date.parse(ledger.anchor ?? ledger.lastBanAt ?? '') > (Date.parse(answered.at ?? '') || 0);
            const held = Boolean(this.levelStart) && startVoid;
            // The day ceiling caps the level (and so a pin), not only the count: see ceilingLevel.
            const caps = [tables.maxLevel, ceilingLevel(levels, dayCeiling(this.config, tables.planDaily))].filter((c) => c != null);
            const lv = levelFor(ledger, {
                // A super admin can skip the wait after a fresh link (sending.skipLinkWait); a ban still rests it.
                linkedAt: tables.skipLinkWait ? '' : this.config.linkedAt, now, dayStart: start,
                levels, brakes: tables.brakes, cap: caps.length ? Math.min(...caps) : null, pin: pinVoid ? null : pin.level,
                start: startVoid ? null : answered.level, startedAt: startVoid ? '' : answered.at, state,
            });
            this.#record(lv, state, start, now);
            const startDaily = levels[startVoid ? 1 : Math.min(answered.level, levels.length - 1)].dailyLimit;
            this.allowanceCache = {
                at: t,
                value: {
                    ...allowanceFrom(lv, ledger, this.config, { resetsAt, levels, planDaily: tables.planDaily, held, startDaily }),
                    // The most a day can reach: the plan, the number's own limit and the top allowed level.
                    ceiling: Math.min(dayCeiling(this.config, tables.planDaily), levels[Math.min(levels.length - 1, tables.maxLevel ?? Infinity)].dailyLimit),
                    // Unanswered questions hold bulk (null while nothing is asked).
                    asked: this.levelStart ? !held : null,
                    row: lv.row,
                    level: {
                        level: lv.level, name: lv.row.name, of: levels.length - 1, earned: lv.earned,
                        pinned: lv.pinned, capped: lv.capped, cap: tables.maxLevel,
                        steps: levels.map((r) => ({ level: r.level, name: r.name, perDay: r.dailyLimit, newChats: r.newChats, need: r.need })),
                        resting: lv.resting, have: lv.have, next: lv.next,
                        start: startVoid ? null : { level: answered.level, answers: answered.answers ?? null, at: answered.at },
                        // What history alone gives, the 7-day health the promotion gate and demotion judge
                        // (humanize.js healthCheck), and the probation after a demotion (null when none).
                        ready: lv.ready, health: { ...lv.health, since: ledger.health?.since ?? null }, probation: lv.probation,
                    },
                    brakes: lv.brakes,
                    content: { varyAbove: qrVaryAbove(this.config, tables.qrVaryAbove), optOutLine: OPT_OUT_TEXT },
                    replies: { reached: ledger.reached ?? 0, replied: ledger.replied ?? 0 },
                    // Messages sent 2-24h ago (db.deliveryWindow): the delivery and stuck brakes, and routing's tie-break.
                    delivery: { sentWin: ledger.sentWin ?? 0, deliveredWin: ledger.deliveredWin ?? 0, failedWin: ledger.failedWin ?? 0, stuckWin: ledger.stuckWin ?? 0 },
                    lastSentAt: ledger.lastSentAt ?? null,
                },
            };
        }
        return this.allowanceCache.value;
    }

    /**
     * Writes what an allowance computed, once (the unique key dedupes a repeat): the level state that changed, its
     * audit rows (kind 'level', or 'shadow' with phone 'level:<reason>'; db.levelEvents), and a brake_day row
     * for each brake that really applied today, which the growth cap reads (db.sendingLedger). Only while safety
     * holds a QR number back. The channel is in each key: the unique index has none.
     */
    #record(lv, state, start, now) {
        // Not before the owner wires the real tables (the CampaignManager constructor's tier() runs on the built-in
        // ones, unseeded and in shadow): that pass would undo a seeded level or an enforced demotion on every start.
        if (!this.qr || !this.config.safetyEnabled || !this.db.addSafetyEvent || this.tables === builtInTables) return;
        if (lv.state && JSON.stringify(lv.state) !== JSON.stringify(state)) this.db.saveLevelState?.(lv.state);
        const at = now.toISOString().replace(/\.\d{3}Z$/, '+00:00'); // utcNow's shape, which the ledger compares as text
        const key = (stamp) => `${this.db.channelId ?? ''}@${stamp}`;
        for (const c of lv.changes) {
            this.db.addSafetyEvent({
                kind: c.kind, phone: c.kind === 'shadow' ? `level:${c.reason}` : c.reason, messageId: key(c.daily ? start.toISOString() : at),
                detail: JSON.stringify({ from: c.from, to: c.to, text: c.text }), at,
            });
        }
        for (const b of lv.brakes) {
            if (BRAKE_DAYS.includes(b.code)) this.db.addSafetyEvent({ kind: 'brake_day', phone: b.code, messageId: key(start.toISOString()), at });
        }
    }

    /** The pacing row: a QR number's level row, or null (pacing by batch size). */
    tier(now = Date.now()) {
        return this.qr ? this.allowance(new Date(now)).row : null;
    }

    /** The cap for the day `now` falls in (0 = none): a QR number's level, else `dailyLimit`. */
    limitOn(now = new Date()) {
        if (this.qr) return this.allowance(now).budgets.bulk.limit;
        return Math.max(0, Number(this.config.dailyLimit) || 0);
    }

    /**
     * The daily cap a plan can count on at today's level (0 = none). On QR, level 1's while the number rests, and
     * never above today's growth cap (it grows day by day, so this is conservative).
     */
    planLimit(now = new Date()) {
        if (!this.config.safetyEnabled) return 0;
        if (!this.qr) return this.limitOn(now);
        const a = this.allowance(now);
        return Math.min(a.perDay, a.growth.cap);
    }

    usedToday(now = new Date()) {
        if (this.qr) return this.allowance(now).budgets.bulk.used;
        const zone = this.zone();
        return this.db.countSentBetween(dayStart(now, zone).toISOString(), dayEnd(now, zone).toISOString());
    }

    remaining(now = new Date()) {
        if (!this.config.safetyEnabled) return Infinity;
        if (this.qr) return this.allowance(now).budgets.bulk.left;
        const limit = this.limitOn(now);
        if (limit === 0) return Infinity;
        return Math.max(0, limit - this.usedToday(now));
    }

    exhausted(now = new Date()) {
        return this.remaining(now) <= 0;
    }

    /** Everything the UI needs to explain the budget. */
    status(now = new Date()) {
        const enabled = Boolean(this.config.safetyEnabled);
        if (this.qr) {
            const a = this.allowance(now);
            const { bulk } = a.budgets;
            return {
                enabled, limit: bulk.limit, used: bulk.used, remaining: enabled ? bulk.left : null, resetsAt: bulk.resetsAt,
                level: a.level, budgets: a.budgets, brakes: a.brakes, content: a.content, ceiling: a.ceiling, asked: a.asked, growth: a.growth,
            };
        }
        const used = this.usedToday(now);
        const limit = this.limitOn(now);
        const limited = enabled && limit > 0;
        return {
            enabled,
            limit,
            used,
            remaining: limited ? Math.max(0, limit - used) : null,
            resetsAt: dayEnd(now, this.zone()).toISOString(),
        };
    }
}

export { SUCCESS_STATUSES };
