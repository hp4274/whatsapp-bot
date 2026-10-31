/**
 * What a business sees about a number's sending on its card: how many it may
 * send today, how many went, the plan's day it grows to, and whether delivery
 * looks unhealthy. Levels, brakes and rests stay with the platform admin
 * (adminOps.js health); a business sees only the resulting numbers.
 *
 * Everything is read from the database, so it works the same whether or not
 * the channel's runtime has been started. The daily cap reuses DailyQuota, so
 * this card and the sender can never disagree about the limit.
 */

import { DailyQuota } from './campaign/safety.js';
import { applySendingPolicy } from './policy/levels.js';

const DAY_MS = 24 * 3600 * 1000;
const LEVEL_RANK = { ok: 0, info: 1, warn: 2, bad: 3 };

/** Minimum sample before a rate is worth shouting about. */
const MIN_24H = 10;
const MIN_7D = 20;

/**
 * `usage`: `{ todayLimit, sentToday, planLimit, growing, asked?, blocked? }`. `todayLimit` null = no cap (safety off,
 * or a sandbox number without a limit; `planLimit` is then null too), 0 = no bulk today (held, resting or capped at 0). On a QR number
 * `planLimit` is the most a day grows to and `asked` false while its 2 questions wait (bulk is held till then).
 * `blocked` is a plain reason, only for a pause, a WhatsApp ban, a WhatsApp restriction or the wait after a new link
 * (then `todayLimit` is the day the number runs at once it starts).
 * @param {object} channel  the channel row
 * @param {object} opts
 * @param {object} opts.db       channel-scoped db handle (`db.forChannel(id)`)
 * @param {object} opts.config   the channel's settings as they run (policy applied)
 * @param {object} [opts.sending] resolved platform policy values (the sending tables, policy/levels.js)
 * @param {Function} [opts.pin]  () => the number's admin level pin, or null
 * @param {Function} [opts.start] () => the number's answered questions, or null (policy/levels.js applySendingPolicy)
 * @param {string} [opts.paused] why the platform paused the number, if it did
 * @param {object} [opts.quota]  the running engine's quota (its 30s cache), else one is built from the rows
 * @param {Date}   [opts.now]
 */
export function channelUsage(channel, { db, config, sending = {}, pin = null, start = null, paused = null, quota: live = null, now = new Date() }) {
    // A running number's own quota, as policy/channelOps.js quotaLeft does: the page polls this every 30s.
    const quota = live ?? applySendingPolicy(new DailyQuota(db, config), sending, pin, start);
    if (!live) quota.zone = () => channel.timezone || null;
    const status = quota.status(now);
    // A QR number's 0 is a real "none today"; the sandbox's 0 is "no limit".
    // Safety left: the plan's day (DailyQuota.status), no limit without a plan.
    let todayLimit = status.enabled ? (quota.qr || status.limit > 0 ? status.limit : null) : (quota.qr && status.limit > 0 ? status.limit : null);
    const has = (code) => quota.qr && status.brakes.some((b) => b.code === code);
    // A newly linked number waits before bulk: show the day it then runs at, and when it starts.
    const waits = quota.qr && status.enabled && status.level.resting.active && !has('ban') ? status.level.resting.endsAt : null;
    if (waits) todayLimit = quota.status(new Date(Date.parse(waits) + 1000)).limit;
    const usage = { todayLimit, sentToday: status.used, planLimit: todayLimit, growing: false };
    const blocked = paused
        || (has('ban') && status.level.resting.active ? 'WhatsApp banned this number. Bulk sending waits while it recovers.' : null)
        || (has('restricted') ? 'WhatsApp is limiting messages from this number to people new to it.' : null)
        || (waits ? `A newly linked number waits before bulk sending. It starts ${startsAt(waits, channel.timezone)}.` : null);
    if (quota.qr && status.enabled) {
        Object.assign(usage, { planLimit: status.ceiling, growing: todayLimit < status.ceiling });
        if (status.asked !== null) usage.asked = status.asked;
    }
    if (blocked) usage.blocked = blocked;
    // While it waits the day is 0 now, not a used-up cap.
    return { usage, quality: quality(db, { dailyLimit: waits ? 0 : todayLimit ?? 0, remaining: status.remaining }, now) };
}

/** "Tue 14:05" on the number's clock (UTC when it has no zone). */
function startsAt(iso, zone) {
    return new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone || 'UTC' })
        .format(new Date(iso));
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Problems with a channel create/patch body, as messages (empty = fine).
 * A stored bad timezone would make every channel listing throw, so it is
 * stopped here rather than discovered later.
 */
export function channelInputProblems(body = {}) {
    const problems = [];
    if (body.displayName !== undefined && !String(body.displayName).trim()) {
        problems.push('display name cannot be empty');
    }
    if (body.displayName !== undefined && String(body.displayName).trim().length > 80) {
        problems.push('display name is too long (80 characters max)');
    }
    if (body.phoneNumber !== undefined && body.phoneNumber !== ''
        && !/^\+?[\d\s()-]{6,20}$/.test(String(body.phoneNumber).trim())) {
        problems.push('phone number should be digits, optionally starting with +');
    }
    if (body.timezone !== undefined) {
        try {
            new Intl.DateTimeFormat('en-GB', { timeZone: String(body.timezone) });
        } catch {
            problems.push(`unknown timezone: ${body.timezone}`);
        }
    }
    const hours = body.businessHours;
    if (hours !== undefined && hours !== null) {
        if (typeof hours !== 'object' || !HHMM.test(hours.start ?? '') || !HHMM.test(hours.end ?? '')) {
            problems.push('sending window needs start and end as HH:MM');
        } else if (hours.start >= hours.end) {
            problems.push('sending window must end after it starts');
        }
        if (hours.days !== undefined && (!Array.isArray(hours.days)
            || hours.days.some((d) => !WEEKDAYS.includes(String(d).toLowerCase().slice(0, 3))))) {
            problems.push(`sending window days must be from ${WEEKDAYS.join(', ')}`);
        }
    }
    return problems;
}

function quality(db, usage, now) {
    const week = new Date(now.getTime() - 7 * DAY_MS).toISOString();
    const day = new Date(now.getTime() - DAY_MS).toISOString();
    const q = db.channelQuality(week, day);
    const rate = (failed, sent) => (failed + sent ? failed / (failed + sent) : 0);
    const failureRate24h = rate(q.failed24, q.sent24);
    const failureRate7d = rate(q.failed7, q.sent7);
    const optOutRate7d = q.sent7 ? q.optOuts7 / q.sent7 : 0;
    const pct = (n) => `${Math.round(n * 100)}%`;
    const hints = [];

    if (q.failed24 + q.sent24 >= MIN_24H && failureRate24h >= 0.2) {
        hints.push({
            level: 'bad', code: 'failures_24h',
            message: `High failure rate in last 24h (${pct(failureRate24h)}) - check numbers and template`,
        });
    } else if (q.failed7 + q.sent7 >= MIN_7D && failureRate7d >= 0.1) {
        hints.push({
            level: 'warn', code: 'failures_7d',
            message: `${pct(failureRate7d)} of messages failed this week - clean your contact list`,
        });
    }

    if (q.optOuts7 >= 3 && optOutRate7d >= 0.05) {
        hints.push({
            level: 'bad', code: 'optouts_7d',
            message: `${q.optOuts7} opt-outs this week (${pct(optOutRate7d)}) - slow down and make messages more relevant`,
        });
    } else if (q.optOuts7 >= 3 && optOutRate7d >= 0.02) {
        hints.push({
            level: 'warn', code: 'optouts_7d',
            message: `${q.optOuts7} people opted out this week - watch your message relevance`,
        });
    }

    // A resting QR number has a day of 0, not a used-up cap.
    if (usage.remaining === 0 && usage.dailyLimit > 0) {
        hints.push({ level: 'warn', code: 'cap_reached', message: "Today's daily cap is used up - sending resumes after reset" });
    } else if (usage.remaining != null && usage.dailyLimit > 0 && usage.remaining <= usage.dailyLimit * 0.1) {
        hints.push({ level: 'info', code: 'cap_near', message: `Only ${usage.remaining} sends left today` });
    }

    const level = hints.reduce((worst, h) => (LEVEL_RANK[h.level] > LEVEL_RANK[worst] ? h.level : worst), 'ok');
    // One 0-100 figure: weights put each "bad" hint threshold (20% failures, 5% opt-outs) at 60 and a used-up cap at 90.
    // Rates count only past the hints' minimum sample, so a few early failures do not sink a new number.
    const failures = Math.max(
        q.failed24 + q.sent24 >= MIN_24H ? failureRate24h : 0,
        q.failed7 + q.sent7 >= MIN_7D ? failureRate7d : 0,
    );
    const optOuts = q.optOuts7 >= 3 ? optOutRate7d : 0;
    const capped = hints.some((h) => h.code === 'cap_reached');
    const score = Math.max(0, Math.min(100, Math.round(100 - 200 * failures - 800 * optOuts - (capped ? 10 : 0))));
    return {
        level,
        score,
        sent24h: q.sent24,
        failed24h: q.failed24,
        failureRate24h,
        sent7d: q.sent7,
        failed7d: q.failed7,
        failureRate7d,
        optOuts7d: q.optOuts7,
        hints,
    };
}
