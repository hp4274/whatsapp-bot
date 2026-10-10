/**
 * Sending safety: how fast a campaign is allowed to go, and how much it may
 * send in a day.
 *
 * Bulk sending is what gets a WhatsApp number banned, and a fixed interval is
 * the easiest pattern to spot: 300 messages, exactly 5.0s apart, is not a
 * person.  Two controls cover it:
 *
 *   1. Adaptive pacing - the gap between messages is drawn at random from a
 *      range, and the range widens with the size of the batch.  A handful of
 *      messages goes out briskly; a thousand crawls.  Every so often the run
 *      takes a longer rest, the way a person putting a phone down would.
 *   2. A daily cap - a hard ceiling on real messages per calendar day.  When
 *      it is reached the campaign PAUSES rather than failing: the queued rows
 *      stay QUEUED and the run can continue tomorrow.
 *
 * Neither hides anything from WhatsApp.  They simply keep the volume and the
 * timing inside what a human account plausibly does, which is also the
 * difference between messaging contacts and spamming them.
 */

import { withinSendingWindow } from '../channels.js';
import { SUCCESS_STATUSES } from '../protocol.js';

/** Day-one cap for a new number under warm-up (unless `config.warmupStart`); it doubles each day after. */
export const WARMUP_START = 30;
const DAY_MS = 24 * 3600 * 1000;

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
 * are already varied. Returns the refusal text, or null.
 */
export function variationError(template, contacts, config = {}) {
    const above = Number(config.requireVariationAbove) || 0;
    const count = Array.isArray(contacts) ? contacts.length : 0;
    if (!above || count <= above) return null;
    const text = String(template ?? '');
    if (/\{[^{}]*\|[^{}]*\}/.test(text) || /\{\s*[\w.]+\s*\}/.test(text)) return null;
    if (contacts.every((c) => String(c?.extra?.message ?? c?.extra?.custom_message ?? '').trim())) return null;
    return `Campaigns to more than ${above} people must vary the message: add spintax like {Hi|Hello} `
        + 'or a placeholder like {name}. Identical bulk text gets numbers reported and blocked.';
}

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

/**
 * Gap between messages, by batch size.  Bigger campaign, slower drip.
 * Numbers are seconds and deliberately conservative for a personal number.
 */
export const PACING_TIERS = [
    { upTo: 10, minSeconds: 4, maxSeconds: 12 },
    { upTo: 50, minSeconds: 8, maxSeconds: 22 },
    { upTo: 200, minSeconds: 15, maxSeconds: 40 },
    { upTo: 1000, minSeconds: 25, maxSeconds: 65 },
    { upTo: Infinity, minSeconds: 40, maxSeconds: 95 },
];

export const SAFETY_DEFAULTS = Object.freeze({
    safetyEnabled: true,
    dailyLimit: 250,
    pacingMode: 'adaptive', // 'adaptive' | 'fixed'
    minDelaySeconds: 0,     // 0 = take the tier for this batch size
    maxDelaySeconds: 0,
    restEvery: 40,          // messages between long pauses (0 = never rest)
    restMinMinutes: 2,
    restMaxMinutes: 5,
});

/**
 * Operator-facing speed presets. `balanced` is the tier table as-is; `safe`
 * stretches every gap by half again; `fast` halves them but never goes under
 * the policy floor (`config.minDelaySeconds`, set by tenant/platform policy).
 */
export const PACING_PRESETS = Object.freeze(['safe', 'balanced', 'fast']);

export const pickPreset = (preset) => (PACING_PRESETS.includes(preset) ? preset : 'balanced');

/** The pacing that applies to a batch of `batchSize` messages. */
export function paceFor(batchSize, config = {}, preset = 'balanced') {
    const tier = PACING_TIERS.find((t) => batchSize <= t.upTo) ?? PACING_TIERS.at(-1);
    let min = config.minDelaySeconds > 0 ? config.minDelaySeconds : tier.minSeconds;
    let max = config.maxDelaySeconds > 0
        ? Math.max(config.maxDelaySeconds, min)
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
        restEvery: Math.max(0, config.restEvery ?? SAFETY_DEFAULTS.restEvery),
        restMinSeconds: (config.restMinMinutes ?? SAFETY_DEFAULTS.restMinMinutes) * 60,
        restMaxSeconds: (config.restMaxMinutes ?? SAFETY_DEFAULTS.restMaxMinutes) * 60,
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

/** Local midnight for the day `at` falls in - the daily window boundary. */
export function dayStart(at = new Date()) {
    const start = new Date(at);
    start.setHours(0, 0, 0, 0);
    return start;
}

export function dayEnd(at = new Date()) {
    const end = dayStart(at);
    end.setDate(end.getDate() + 1);
    return end;
}

/**
 * The daily cap.  Counted from the database, so a restart cannot reset it and
 * two campaigns in one day share one budget.  Only real deliveries count -
 * SANDBOX does not, because nothing left the machine.
 */
export class DailyQuota {
    constructor(db, config) {
        this.db = db;
        this.config = config;
    }

    get limit() {
        return this.limitOn(new Date());
    }

    /**
     * The cap for the day `now` falls in (0 = none). Under warm-up a number's
     * first `warmupDays` days, counted from its first real send, start at
     * WARMUP_START and double daily, never above `dailyLimit` when one is set.
     */
    limitOn(now = new Date()) {
        const base = Math.max(0, Number(this.config.dailyLimit) || 0);
        const days = Number(this.config.warmupDays) || 0;
        if (!days) return base;
        const first = this.db.firstSentAt?.();
        const age = first ? Math.max(0, Math.round((dayStart(now) - dayStart(new Date(first))) / DAY_MS)) : 0;
        if (age >= days) return base;
        const ramp = (Number(this.config.warmupStart) || WARMUP_START) * 2 ** age;
        return base ? Math.min(base, ramp) : ramp;
    }

    usedToday(now = new Date()) {
        return this.db.countSentBetween(dayStart(now).toISOString(), dayEnd(now).toISOString());
    }

    remaining(now = new Date()) {
        const limit = this.limitOn(now);
        if (!this.config.safetyEnabled || limit === 0) return Infinity;
        return Math.max(0, limit - this.usedToday(now));
    }

    exhausted(now = new Date()) {
        return this.remaining(now) <= 0;
    }

    /** Everything the UI needs to explain the budget. */
    status(now = new Date()) {
        const used = this.usedToday(now);
        const limit = this.limitOn(now);
        const limited = Boolean(this.config.safetyEnabled) && limit > 0;
        return {
            enabled: Boolean(this.config.safetyEnabled),
            limit,
            used,
            remaining: limited ? Math.max(0, limit - used) : null,
            resetsAt: dayEnd(now).toISOString(),
        };
    }
}

export { SUCCESS_STATUSES };
