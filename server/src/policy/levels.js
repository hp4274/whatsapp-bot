/**
 * Platform rules for the anti-ban sending tables: QR sending levels and the
 * brakes (campaign/humanize.js). See `index.js` for the field
 * shape. The defaults are the built-in tables, so an empty policy table sends
 * exactly as before; `sendingTables` turns resolved values into what
 * DailyQuota's `tables` hook returns.
 */

import { BLOCK_PAUSE_MIN_SENT, BLOCK_PAUSE_PERCENT, BRAKES, LEVELS } from '../campaign/humanize.js';
import { DEFAULT_SENDING } from '../campaign/safety.js';

const S = 'whatsapp_channels';
const BIG = 10_000_000;

/** Pace columns of the levels table (gaps, rests, quiet time). */
const PACE_COLUMNS = [
    { key: 'name', type: 'text', label: 'Name' },
    { key: 'dailyLimit', type: 'int', min: 0, max: BIG, label: 'Per day' },
    { key: 'minSeconds', type: 'num', min: 0, max: 3600, label: 'Min gap (s)' },
    { key: 'maxSeconds', type: 'num', min: 0, max: 3600, label: 'Max gap (s)' },
    { key: 'quietHours', type: 'range', min: 0, max: 20, label: 'Quiet hours' },
    { key: 'restEvery', type: 'int', min: 0, max: 10000, label: 'Rest every' },
    { key: 'restMinMinutes', type: 'num', min: 0, max: 600, label: 'Rest min (min)' },
    { key: 'restMaxMinutes', type: 'num', min: 0, max: 600, label: 'Rest max (min)' },
];

/** A range that runs backwards. */
function paceProblem(rows) {
    for (const r of rows) {
        const id = r.level;
        if (r.minSeconds > r.maxSeconds) return `row ${id}: min gap is above max gap`;
        if (r.restMinMinutes > r.restMaxMinutes) return `row ${id}: rest min is above rest max`;
    }
    return null;
}

function levelsProblem(rows) {
    const pace = paceProblem(rows);
    if (pace) return pace;
    for (let i = 2; i < rows.length; i += 1) {
        const [a, b] = [rows[i - 1].need, rows[i].need];
        if (['days', 'delivered', 'bulk'].some((k) => b[k] < a[k])) return `level ${i}: what it needs must not be below level ${i - 1}`;
    }
    return null;
}

const brake = (key, label, def, max, hint) => ({
    key: `sending.${key}`, service: S, group: 'Ban brakes (QR numbers)', type: 'int', default: def, min: 0, max, label, hint,
});

export const LEVELS_POLICY = Object.freeze([
    { key: 'sending.levels', service: S, group: 'Sending levels (QR numbers)', type: 'table', default: LEVELS,
      columns: [
          { key: 'level', type: 'int', fixed: true, label: 'Level' },
          ...PACE_COLUMNS,
          { key: 'newChats', type: 'int', min: 0, max: BIG, label: 'New chats' },
          { key: 'perHour', type: 'int', min: 0, max: BIG, label: 'Per hour' },
          { key: 'links', type: 'int', min: 0, max: 5, label: 'Links' },
          { key: 'media', type: 'bool', label: 'Media' },
          { key: 'need', type: 'need', min: 0, max: BIG, label: 'Needs (days / delivered / bulk)' },
      ],
      validate: levelsProblem,
      label: 'Sending levels', hint: 'What a QR number may send at each level, and what it needs to reach it. Changes reach running numbers within a minute.' },
    { key: 'sending.maxLevel', service: S, group: 'Sending levels (QR numbers)', type: 'int', default: null, nullLabel: 'No cap',
      min: 0, max: LEVELS.length - 1,
      label: 'Highest level', hint: 'QR numbers never run above this level, whatever they earned.' },

    brake('restUntilDelivered', 'Rest lifts after delivered', BRAKES.restUntilDelivered, 100000, 'The rest after linking ends early once this many messages were delivered.'),
    brake('replyMinReached', 'Reply brake: minimum reached', BRAKES.replyMinReached, 100000, 'People reached in 48 hours before the reply rate is judged.'),
    brake('replyMinPercent', 'Reply brake: minimum reply rate (%)', BRAKES.replyMinPercent, 100, 'Below this, bulk, new chats and the hour are halved.'),
    brake('blockMinDelivered', 'Block brake: minimum delivered (7 days)', BRAKES.blockMinDelivered, 100000),
    brake('blockMaxPercent', 'Block brake: maximum blocks + reports (%)', BRAKES.blockMaxPercent, 100, 'Above this, new chats wait.'),
    brake('failureMinSends', 'Failure brake: minimum sends (24 hours)', BRAKES.failureMinSends, 100000),
    brake('failureMaxPercent', 'Failure brake: maximum failures (%)', BRAKES.failureMaxPercent, 100, 'Above this, new chats wait.'),
    brake('reportsBrakeAt', 'Report brake: reports in 72 hours', BRAKES.reportsBrakeAt, 1000, 'This many spam reports close new chats for 72 hours.'),
    { key: 'sending.brakesMode', service: S, group: 'Ban brakes (QR numbers)', type: 'enum', default: BRAKES.brakesMode,
      options: [
          { value: 'shadow', label: 'Shadow: log only' },
          { value: 'enforce', label: 'Enforce' },
      ],
      label: 'Delivery, stuck and unstable brakes',
      hint: 'Shadow logs when they would fire (number health, kind shadow) and never slows sending. Switch to enforce after reviewing 7 days of triggers.' },
    brake('deliveryMinSent', 'Delivery brake: minimum sent (2-24 hours)', BRAKES.deliveryMinSent, 100000),
    brake('deliveryMinPercent', 'Delivery brake: minimum delivered (%)', BRAKES.deliveryMinPercent, 100, 'Below this, bulk and new chats wait 12 hours.'),
    brake('stuckMaxPercent', 'Stuck brake: maximum still one tick (%)', BRAKES.stuckMaxPercent, 100, 'Of messages sent 2-24 hours ago. Above this, bulk and new chats wait 12 hours.'),
    { ...brake('blockPausePercent', 'Pause campaigns at blocks + reports (%)', BLOCK_PAUSE_PERCENT, 100), min: 1 },
    brake('blockPauseMinSent', 'Pause campaigns: minimum sent (7 days)', BLOCK_PAUSE_MIN_SENT, 100000),
    { ...brake('qrVaryAbove', 'QR: identical text to at most', DEFAULT_SENDING.qrVaryAbove, 100000, 'A bigger QR campaign must vary its message.'), min: 1 },
    brake('daytimeFrom', 'Recipient daytime from (hour)', BRAKES.daytimeFrom, 23, 'Bulk waits for the recipient’s daytime.'),
    { ...brake('daytimeTo', 'Recipient daytime until (hour)', BRAKES.daytimeTo, 24),
      // A backwards window would hold every bulk message forever.
      check: (v) => (v['sending.daytimeFrom'] >= v['sending.daytimeTo'] ? 'Recipient daytime must start before it ends' : null) },
]);

/**
 * Point a DailyQuota's `tables` and `levelPin` hooks at platform policy. Every
 * quota (a running sender's or a one-off for a health card) goes through here,
 * so what is shown and what is enforced cannot drift apart.
 * `values`: resolved policy values, or a function returning them (re-read every 5s).
 * `pin`: () => the number's admin pin `{ level, at }`, or null.
 * `start`: () => the number's answered questions `{ level, answers, at }`, or null; passing it holds bulk until answered.
 */
export function applySendingPolicy(quota, values, pin = null, start = null) {
    let at = -Infinity;
    let tables;
    quota.tables = () => {
        if (Date.now() - at > 5000) {
            tables = sendingTables((typeof values === 'function' ? values() : values) ?? {});
            at = Date.now();
        }
        return tables;
    };
    quota.levelPin = () => pin?.() ?? null;
    if (start) quota.levelStart = () => start() ?? null;
    // An allowance cached before this (the CampaignManager constructor's tier()) was built from the built-in tables.
    quota.invalidate?.();
    return quota;
}

/** Resolved policy values -> DailyQuota's `tables` shape. Missing keys keep the built-in values. */
export function sendingTables(values = {}) {
    const v = (key, fallback) => values[`sending.${key}`] ?? fallback;
    const brakes = { ...BRAKES };
    for (const key of Object.keys(BRAKES)) if (key !== 'restHours') brakes[key] = v(key, BRAKES[key]);
    // A backwards window would hold every bulk message forever: fall back to the built-in one.
    if (brakes.daytimeFrom >= brakes.daytimeTo) Object.assign(brakes, { daytimeFrom: BRAKES.daytimeFrom, daytimeTo: BRAKES.daytimeTo });
    const stored = v('levels', LEVELS);
    // shortcut: a table saved before the levels grew (9 rows) keeps running as saved, with numbers held at its old
    // top (the built-in rows above it are out of reach) until the admin saves it again; GET /admin/policy lists it
    // under `stale`. Fails safe: an admin's tighter rows never fall back to the looser built-in ones.
    const short = Array.isArray(stored) && stored.length >= 2 && stored.length < LEVELS.length;
    const maxLevel = v('maxLevel', null);
    return {
        levels: short ? [...stored, ...LEVELS.slice(stored.length)]
            : Array.isArray(stored) && stored.length === LEVELS.length ? stored : LEVELS,
        brakes,
        maxLevel: short ? Math.min(maxLevel ?? Infinity, stored.length - 1) : maxLevel,
        // The plan's per-number day, read live so a plan change reaches every number at once.
        planDaily: values['channels.dailyCap'] ?? null,
        blockPausePercent: v('blockPausePercent', BLOCK_PAUSE_PERCENT),
        blockPauseMinSent: v('blockPauseMinSent', BLOCK_PAUSE_MIN_SENT),
        qrVaryAbove: v('qrVaryAbove', DEFAULT_SENDING.qrVaryAbove),
    };
}

/**
 * The number questions. `age`: 0 under a month on WhatsApp, 1 one to six months, 2 six to 24 months, 3 over
 * two years. `usage`: 0 new or hardly used, 1 light personal, 2 regular daily chats, 3 a busy business number.
 * Their sum picks the start: 0-1 level 2 (20 a day) up to 6 level 7 (200 a day). Null when an answer is not 0-3.
 */
export function startLevelFor({ age, usage } = {}) {
    const ok = (n) => Number.isInteger(n) && n >= 0 && n <= 3;
    if (!ok(age) || !ok(usage)) return null;
    return Math.min(7, Math.max(2, age + usage + 1));
}

/**
 * Skipping the questions starts at the plan's day: the lowest level whose day reaches `planDaily` (the same
 * level the plan caps the number at, campaign/safety.js ceilingLevel), or the top level with no plan limit.
 */
export function skipStartLevel(levels, planDaily) {
    const top = levels.length - 1;
    if (!(Number(planDaily) > 0)) return top;
    return levels.find((r) => r.level >= 1 && r.dailyLimit >= Number(planDaily))?.level ?? top;
}
