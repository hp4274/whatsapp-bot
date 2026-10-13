/**
 * Making bulk traffic look like a person: sending tiers, a different rhythm
 * every day, a typing pause, a night's rest per day, the recipient's local
 * time, and a content check. Pure functions: the manager and the transport
 * decide when to call them.
 *
 * None of this hides anything from WhatsApp. It keeps volume and timing inside
 * what a real account plausibly does, which is also what keeps a number alive.
 */

const HOUR = 3600;

/**
 * Sending tiers. A number starts on tier 1 and moves up when it has sent
 * `upgradeAt` messages inside one 7-day block (counted from its first send).
 * Higher tier = bigger day, shorter gaps, shorter nightly rest.
 * Gaps are seconds; `quietHours` is the nightly rest [min, max] hours.
 */
export const TIERS = Object.freeze([
    { tier: 1, name: 'Warm-up', dailyLimit: 250, minSeconds: 45, maxSeconds: 130, quietHours: [6, 8], restEvery: 20, restMinMinutes: 3, restMaxMinutes: 7, upgradeAt: 1000 },
    { tier: 2, name: 'Growing', dailyLimit: 2000, minSeconds: 12, maxSeconds: 40, quietHours: [4, 5.5], restEvery: 60, restMinMinutes: 2, restMaxMinutes: 5, upgradeAt: 5000 },
    // ponytail: the 10K ceiling is per 24h; at ~5s a message it needs ~15h of sending.
    { tier: 3, name: 'Established', dailyLimit: 10000, minSeconds: 2, maxSeconds: 8, quietHours: [2, 3], restEvery: 250, restMinMinutes: 1, restMaxMinutes: 3, upgradeAt: null },
]);

/**
 * Tier from the per-week send counts, oldest week first. Walks forward so a
 * quiet week later never demotes a number that already earned its tier.
 */
export function tierFromWeeks(weekCounts = []) {
    let at = 0;
    for (const sent of weekCounts) {
        const need = TIERS[at].upgradeAt;
        if (need && sent >= need) at += 1;
    }
    return TIERS[at];
}

/** Where the number stands: its tier and how far it is from the next. */
export function tierStatus(weekCounts = []) {
    const current = tierFromWeeks(weekCounts);
    const thisWeek = weekCounts.at(-1) ?? 0;
    return {
        tier: current.tier,
        name: current.name,
        dailyLimit: current.dailyLimit,
        weekSent: thisWeek,
        // The upgrade target is for a 7-day block; null on the top tier.
        nextTierAt: current.upgradeAt,
        next: TIERS[current.tier] ? { tier: current.tier + 1, name: TIERS[current.tier].name, dailyLimit: TIERS[current.tier].dailyLimit } : null,
    };
}

// ---------------------------------------------------------------- randomness --

/** Small seeded PRNG (mulberry32): same seed, same sequence. */
export function seeded(seed) {
    let h = 1779033703 ^ String(seed).length;
    for (let i = 0; i < String(seed).length; i += 1) {
        h = Math.imul(h ^ String(seed).charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    let a = h >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Fisher-Yates, in place. Campaign order must never be the sheet's order. */
export function shuffle(items, random = Math.random) {
    for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

export const localDayKey = (at = new Date()) =>
    `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`;

/**
 * Today's rhythm for one number: every day draws a different gap multiplier
 * and a different rest window, so no two days repeat the same timing.
 * Deterministic per (seed, day) so a restart does not re-roll mid-day.
 * `quiet` is minutes since local midnight; the window never crosses midnight.
 */
export function dayPlan(seed, tier, at = new Date()) {
    const random = seeded(`${seed}|${localDayKey(at)}`);
    const [lo, hi] = tier.quietHours;
    const quietMinutes = Math.round((lo + random() * (hi - lo)) * 60);
    return {
        gapFactor: 0.8 + random() * 0.5,
        quietStart: Math.floor(random() * (24 * 60 - quietMinutes)),
        quietMinutes,
    };
}

export function inQuiet(plan, at = new Date()) {
    const minute = at.getHours() * 60 + at.getMinutes();
    return minute >= plan.quietStart && minute < plan.quietStart + plan.quietMinutes;
}

/** Seconds until today's rest window ends (0 when not resting). */
export function quietLeftSeconds(plan, at = new Date()) {
    if (!inQuiet(plan, at)) return 0;
    const minute = at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;
    return Math.ceil((plan.quietStart + plan.quietMinutes - minute) * 60);
}

// -------------------------------------------------------------------- typing --

/**
 * How long to show "typing..." before a message goes out: 2-3 seconds at
 * minimum, longer for longer text, much longer when a file is attached.
 */
export function typingMs(text, { media = false } = {}, random = Math.random) {
    const base = 2000 + random() * 1000;
    const reading = Math.min(5000, String(text ?? '').length * (25 + random() * 20));
    return Math.round(base + reading + (media ? 3000 + random() * 3000 : 0));
}

/** Media is heavier to upload and looks more like bulk: stretch its gap. */
export const MEDIA_GAP_FACTOR = 1.6;

// ------------------------------------------------------------- recipient time --

// Longest prefix wins. A country spanning several zones lists its outer ones:
// a number there is messaged only when it is daytime in ALL of them, so a
// guess about the exact region can never land a message in the middle of the night.
const ZONES = {
    1: ['America/New_York', 'America/Los_Angeles'], 7: ['Europe/Kaliningrad', 'Asia/Vladivostok'], 20: 'Africa/Cairo', 27: 'Africa/Johannesburg',
    30: 'Europe/Athens', 31: 'Europe/Amsterdam', 32: 'Europe/Brussels', 33: 'Europe/Paris',
    34: 'Europe/Madrid', 39: 'Europe/Rome', 40: 'Europe/Bucharest', 41: 'Europe/Zurich',
    43: 'Europe/Vienna', 44: 'Europe/London', 45: 'Europe/Copenhagen', 46: 'Europe/Stockholm',
    47: 'Europe/Oslo', 48: 'Europe/Warsaw', 49: 'Europe/Berlin', 51: 'America/Lima',
    52: ['America/Mexico_City', 'America/Tijuana'], 54: 'America/Argentina/Buenos_Aires', 55: ['America/Sao_Paulo', 'America/Rio_Branco'],
    56: 'America/Santiago', 57: 'America/Bogota', 58: 'America/Caracas', 60: 'Asia/Kuala_Lumpur',
    61: ['Australia/Sydney', 'Australia/Perth'], 62: ['Asia/Jakarta', 'Asia/Jayapura'], 63: 'Asia/Manila', 64: 'Pacific/Auckland',
    65: 'Asia/Singapore', 66: 'Asia/Bangkok', 81: 'Asia/Tokyo', 82: 'Asia/Seoul',
    84: 'Asia/Ho_Chi_Minh', 86: 'Asia/Shanghai', 90: 'Europe/Istanbul', 91: 'Asia/Kolkata',
    92: 'Asia/Karachi', 93: 'Asia/Kabul', 94: 'Asia/Colombo', 95: 'Asia/Yangon',
    98: 'Asia/Tehran', 212: 'Africa/Casablanca', 213: 'Africa/Algiers', 216: 'Africa/Tunis',
    234: 'Africa/Lagos', 254: 'Africa/Nairobi', 351: 'Europe/Lisbon', 353: 'Europe/Dublin',
    380: 'Europe/Kyiv', 880: 'Asia/Dhaka', 966: 'Asia/Riyadh', 971: 'Asia/Dubai',
    972: 'Asia/Jerusalem', 974: 'Asia/Qatar', 977: 'Asia/Kathmandu',
};

/** Every zone the number's country spans (outer ones), or [] when unknown. */
export function zonesOf(phone) {
    const digits = String(phone ?? '').replace(/\D/g, '');
    for (const length of [3, 2, 1]) {
        const zone = ZONES[Number(digits.slice(0, length))];
        if (zone && digits.length >= length) return [].concat(zone);
    }
    return [];
}

export const zoneOf = (phone) => zonesOf(phone)[0] ?? null;

const hourFormats = new Map();
const hourCache = new Map();

/** Local hour (0-23) in one IANA zone. */
export function localHour(zone, at = new Date()) {
    // The queue asks about thousands of numbers per poll; one answer per zone per minute is plenty.
    const key = `${zone}|${Math.floor(at.getTime() / 60_000)}`;
    if (hourCache.has(key)) return hourCache.get(key);
    if (hourCache.size > 500) hourCache.clear();
    let format = hourFormats.get(zone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' });
        hourFormats.set(zone, format);
    }
    const hour = Number(format.format(at));
    hourCache.set(key, hour);
    return hour;
}

/**
 * Is it a sensible time to message this number? 9:00-21:00 where they live.
 * Unknown country = always yes. Outside it the message waits, it does not fail.
 */
export function isDaytimeFor(phone, at = new Date(), { from = 9, to = 21 } = {}) {
    return zonesOf(phone).every((zone) => {
        const hour = localHour(zone, at);
        return hour >= from && hour < to;
    });
}

// ------------------------------------------------------------ content check --

/**
 * Spam-shaped text: shouting, emoji walls, runs of "!". Placeholders like
 * {name} are ignored. Returns the refusal sentence, or null.
 */
export function contentError(text) {
    const plain = String(text ?? '').replace(/\{[^{}]*\}/g, '');
    const letters = plain.match(/\p{L}/gu) ?? [];
    const upper = plain.match(/\p{Lu}/gu) ?? [];
    if (letters.length >= 15 && upper.length / letters.length > 0.6) {
        return 'The message is mostly CAPITAL LETTERS, which reads as shouting and gets reported. Write it in normal case.';
    }
    if ((plain.match(/\p{Extended_Pictographic}/gu) ?? []).length > 5) {
        return 'The message has too many emojis (limit 5). Keep it to a few.';
    }
    if (/[!?]{3,}/.test(plain) || (plain.match(/!/g) ?? []).length > 3) {
        return 'The message has too many exclamation marks (limit 3, and never "!!!").';
    }
    return null;
}

// ---------------------------------------------------------- block / report --

/** Words in a reply that mean "you are bothering me" rather than a normal opt-out. */
export const COMPLAINT_WORDS = /\b(spam|spammer|report(ed|ing)?|block(ed|ing)?|scam|harass(ing|ment)?|stop (messaging|texting|sending)|don'?t (message|text|contact) me|who gave you my (number|contact))\b/i;

/** A suspected block: delivered to the server but not to the phone for this long. */
export const BLOCK_SUSPECT_AFTER_SECONDS = 12 * HOUR;

/** Pause a campaign when blocks + reports reach this share of the week's sends (once enough went out). */
export const BLOCK_PAUSE_PERCENT = 5;
export const BLOCK_PAUSE_MIN_SENT = 40;
