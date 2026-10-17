/**
 * Spread sending: one list, a date range, equal daily batches.
 *
 * The list is shuffled once when the campaign is saved; each day the store
 * sends the next slice. Pure helpers only - the store decides when to call them.
 */

import { wallClock } from './humanize.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` on the wall clock of `zone` (server clock when none). */
export function dayKey(at = new Date(), zone = null) {
    const { day } = wallClock(at, zone);
    const [y, m, d] = day.split('-').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export const isDateKey = (value) => typeof value === 'string' && DATE.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

/** Whole days from `a` to `b` (negative when b is earlier). */
export const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);

/** `count` split over `days` so batches differ by at most one; larger batches first. */
export function equalSplit(count, days) {
    const base = Math.floor(count / days);
    const extra = count % days;
    return Array.from({ length: days }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * Can `count` messages go out between `from` and `to` without any day passing
 * the cap? `limit` is the tightest daily ceiling (tier / plan), 0 = none.
 * A start in the past counts from `today`.
 */
export function spreadPlan({ count, from, to, today, limit = 0, tier = null }) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    const base = { dailyLimit: limit, tier, minDays: limit > 0 ? Math.max(1, Math.ceil(n / limit)) : 1 };
    if (!isDateKey(from) || !isDateKey(to)) {
        return { ...base, days: 0, perDay: 0, sizes: [], feasible: false, reason: 'Pick a start and an end date.', startsOn: from ?? null, endsOn: to ?? null };
    }
    const startsOn = daysBetween(today, from) > 0 ? from : today;
    const days = daysBetween(startsOn, to) + 1;
    if (days < 1) {
        return { ...base, days: 0, perDay: 0, sizes: [], feasible: false, reason: 'The end date is already past.', startsOn, endsOn: to };
    }
    const perDay = n ? Math.ceil(n / days) : 0;
    const feasible = limit <= 0 || perDay <= limit;
    return {
        ...base,
        days,
        perDay,
        sizes: equalSplit(n, days).slice(0, 62),
        feasible,
        reason: feasible ? null
            : `${n} messages over ${days} day${days === 1 ? '' : 's'} is ${perDay} a day, but your number may send ${limit} a day. `
            + `Use at least ${base.minDays} days or a shorter list.`,
        startsOn,
        endsOn: to,
    };
}

/**
 * The next day's start: the following local day at `startTime` (HH:MM).
 * ponytail: ignores a DST change between now and then (off by an hour, once a year).
 */
export function nextDayAt(now, zone, startTime = '09:00') {
    const [h, m] = startTime.split(':').map(Number);
    const { minute } = wallClock(now, zone);
    return new Date(now.getTime() + (1440 - minute + h * 60 + m) * 60_000);
}

/**
 * Is today's batch already out, with the next one booked for a later local day?
 * Then "start" means "send tomorrow's share now". A booking still on today
 * (08:00 before a 09:00 start) is not that: nothing has gone out yet today.
 */
export function isEarlyContinue({ cursor, scheduledAt, now = new Date(), zone = null }) {
    const at = scheduledAt ? new Date(scheduledAt) : null;
    return cursor > 0 && !!at && !Number.isNaN(at.getTime())
        && daysBetween(dayKey(now, zone), dayKey(at, zone)) > 0;
}

/** The batch for today: the rest of the list over the days left, rounded up. */
export function todaysBatch({ total, cursor, today, to }) {
    const daysLeft = Math.max(1, daysBetween(today, to) + 1);
    return Math.ceil(Math.max(0, total - cursor) / daysLeft);
}
