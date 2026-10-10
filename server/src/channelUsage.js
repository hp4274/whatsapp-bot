/**
 * The numbers an operator wants on a channel card: how much of today's budget
 * is used, where warm-up stands, and whether delivery looks unhealthy.
 *
 * Everything is read from the database, so it works the same whether or not
 * the channel's runtime has been started. The daily cap reuses DailyQuota, so
 * this card and the sender can never disagree about the limit.
 */

import { DailyQuota, WARMUP_START, dayStart } from './campaign/safety.js';

const DAY_MS = 24 * 3600 * 1000;
const LEVEL_RANK = { ok: 0, info: 1, warn: 2, bad: 3 };

/** Minimum sample before a rate is worth shouting about. */
const MIN_24H = 10;
const MIN_7D = 20;

/**
 * @param {object} channel  the channel row
 * @param {object} opts
 * @param {object} opts.db       channel-scoped db handle (`db.forChannel(id)`)
 * @param {object} opts.config   the channel's settings as they run (policy applied)
 * @param {object} [opts.policy] platform-enforced keys, to say where a limit came from
 * @param {Date}   [opts.now]
 */
export function channelUsage(channel, { db, config, policy = {}, now = new Date() }) {
    // One firstSentAt query, shared by the quota and the warm-up block.
    let first;
    const scoped = Object.create(db);
    scoped.firstSentAt = () => (first === undefined ? (first = db.firstSentAt() ?? null) : first);

    const quota = new DailyQuota(scoped, config);
    const status = quota.status(now);
    const base = Math.max(0, Number(config.dailyLimit) || 0);
    const usage = {
        sentToday: status.used,
        dailyLimit: status.enabled ? status.limit : 0,
        baseLimit: base,
        remaining: status.remaining,
        resetsAt: status.resetsAt,
        safetyEnabled: status.enabled,
        setByPlatform: 'dailyLimit' in policy || 'warmupDays' in policy,
    };

    const days = Number(config.warmupDays) || 0;
    let warmup = null;
    if (days > 0) {
        const firstAt = scoped.firstSentAt();
        const age = firstAt ? Math.max(0, Math.round((dayStart(now) - dayStart(new Date(firstAt))) / DAY_MS)) : 0;
        const ramp = (Number(config.warmupStart) || WARMUP_START) * 2 ** Math.min(age, 30);
        warmup = {
            active: age < days,
            day: Math.min(age + 1, days),
            totalDays: days,
            todayCap: age < days ? (base ? Math.min(base, ramp) : ramp) : base,
            startedAt: firstAt,
        };
    }

    return { usage, warmup, quality: quality(db, usage, now) };
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

    if (usage.remaining === 0) {
        hints.push({ level: 'warn', code: 'cap_reached', message: "Today's daily cap is used up - sending resumes after reset" });
    } else if (usage.remaining != null && usage.dailyLimit > 0 && usage.remaining <= usage.dailyLimit * 0.1) {
        hints.push({ level: 'info', code: 'cap_near', message: `Only ${usage.remaining} sends left today` });
    }

    const level = hints.reduce((worst, h) => (LEVEL_RANK[h.level] > LEVEL_RANK[worst] ? h.level : worst), 'ok');
    return {
        level,
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
