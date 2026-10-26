/**
 * Making bulk traffic look like a person: sending levels on QR numbers, a different rhythm
 * every day, a typing pause, a few quiet windows per day, the recipient's local
 * time, and a content check. Pure functions: the manager and the transport
 * decide when to call them.
 *
 * None of this hides anything from WhatsApp. It keeps volume and timing inside
 * what a real account plausibly does, which is also what keeps a number alive.
 */

const HOUR = 3600;

// ------------------------------------------------------------ sending levels --

/** Bulk traffic: the daily and hourly budgets count these, and they wait for the recipient's daytime. */
export const HELD_TYPES = Object.freeze(['campaign', 'workflow', 'reminder']);

/**
 * Sending levels: what QR (Baileys) numbers follow. paceFor / dayPlan /
 * quietExtraSeconds take a level row.
 * `dailyLimit` is bulk a day, `newChats` people this number never talked to,
 * `perHour` bulk in any 60 minutes, `links` per message (0 = none). A level is
 * earned when all three `need`s are met since the anchor (active days with a
 * delivery, delivered messages, delivered bulk). Level 0 is the rest after
 * linking: replies go out, bulk waits. Its gaps are level 1's, for the
 * one-to-one sends that still go.
 */
export const LEVELS = Object.freeze([
    { level: 0, name: 'Resting', dailyLimit: 0, newChats: 0, perHour: 0, minSeconds: 90, maxSeconds: 300, quietHours: [6, 8], restEvery: 5, restMinMinutes: 45, restMaxMinutes: 60, links: 0, media: false, need: null },
    { level: 1, name: 'First steps', dailyLimit: 10, newChats: 3, perHour: 5, minSeconds: 90, maxSeconds: 300, quietHours: [6, 8], restEvery: 5, restMinMinutes: 45, restMaxMinutes: 60, links: 0, media: false, need: { days: 0, delivered: 0, bulk: 0 } },
    { level: 2, name: 'Settling in', dailyLimit: 20, newChats: 5, perHour: 8, minSeconds: 60, maxSeconds: 180, quietHours: [6, 8], restEvery: 8, restMinMinutes: 45, restMaxMinutes: 55, links: 0, media: false, need: { days: 3, delivered: 8, bulk: 0 } },
    { level: 3, name: 'Building', dailyLimit: 40, newChats: 10, perHour: 10, minSeconds: 45, maxSeconds: 150, quietHours: [6, 8], restEvery: 10, restMinMinutes: 40, restMaxMinutes: 50, links: 0, media: false, need: { days: 6, delivered: 40, bulk: 0 } },
    { level: 4, name: 'Growing', dailyLimit: 60, newChats: 15, perHour: 12, minSeconds: 40, maxSeconds: 120, quietHours: [5, 7], restEvery: 12, restMinMinutes: 40, restMaxMinutes: 50, links: 1, media: true, need: { days: 9, delivered: 100, bulk: 40 } },
    { level: 5, name: 'Steady', dailyLimit: 100, newChats: 20, perHour: 15, minSeconds: 30, maxSeconds: 120, quietHours: [5, 7], restEvery: 15, restMinMinutes: 35, restMaxMinutes: 45, links: 1, media: true, need: { days: 12, delivered: 220, bulk: 90 } },
    { level: 6, name: 'Trusted', dailyLimit: 150, newChats: 30, perHour: 20, minSeconds: 30, maxSeconds: 90, quietHours: [4, 5.5], restEvery: 20, restMinMinutes: 35, restMaxMinutes: 45, links: 1, media: true, need: { days: 17, delivered: 500, bulk: 200 } },
    { level: 7, name: 'Established', dailyLimit: 200, newChats: 50, perHour: 30, minSeconds: 20, maxSeconds: 90, quietHours: [3, 4], restEvery: 30, restMinMinutes: 30, restMaxMinutes: 40, links: 1, media: true, need: { days: 24, delivered: 1000, bulk: 400 } },
    { level: 8, name: 'Proven', dailyLimit: 250, newChats: 80, perHour: 30, minSeconds: 20, maxSeconds: 60, quietHours: [3, 4], restEvery: 30, restMinMinutes: 35, restMaxMinutes: 45, links: 1, media: true, need: { days: 40, delivered: 2500, bulk: 1000 } },
    // 9-11 are sized so a full day fits the 12-hour recipient daytime: gaps (typing included), rests, and the
    // share of the quiet windows that lands in the day. About 30% of a day may go to new chats.
    // Days never drop below level 8's 40 (needs must not go down); delivered and bulk do the gating.
    { level: 9, name: 'Reliable', dailyLimit: 400, newChats: 120, perHour: 45, minSeconds: 20, maxSeconds: 50, quietHours: [2.5, 3.5], restEvery: 40, restMinMinutes: 20, restMaxMinutes: 30, links: 1, media: true, need: { days: 40, delivered: 3000, bulk: 1500 } },
    { level: 10, name: 'Strong', dailyLimit: 650, newChats: 200, perHour: 70, minSeconds: 20, maxSeconds: 40, quietHours: [2, 2.5], restEvery: 60, restMinMinutes: 15, restMaxMinutes: 25, links: 1, media: true, need: { days: 40, delivered: 6000, bulk: 3000 } },
    { level: 11, name: 'Peak', dailyLimit: 1000, newChats: 300, perHour: 100, minSeconds: 15, maxSeconds: 35, quietHours: [1.5, 2], restEvery: 80, restMinMinutes: 10, restMaxMinutes: 15, links: 1, media: true, need: { days: 45, delivered: 12000, bulk: 6000 } },
]);

/**
 * Brake thresholds for QR numbers, plus the recipient daytime window bulk waits for.
 * `restUntilDelivered`: the rest after linking lifts early once this much was delivered since the anchor (an old
 * number relinked). `restHours`: rest after linking or a ban; a 2nd / 3rd ban within 30 days rests longer.
 * Platform policy can replace any of them (policy/levels.js).
 */
export const BRAKES = Object.freeze({
    restUntilDelivered: 40,
    restHours: Object.freeze([24, 24, 48, 72]),
    replyMinReached: 40,
    replyMinPercent: 15,
    blockMinDelivered: 40,
    blockMaxPercent: 2,
    failureMinSends: 20,
    failureMaxPercent: 3,
    reportsBrakeAt: 3,
    // Delivery and stuck brakes, judged on messages sent 2-24h ago (db.deliveryWindow): no bulk or new chats for 12h.
    deliveryMinSent: 20,
    deliveryMinPercent: 85,
    stuckMaxPercent: 20,
    daytimeFrom: 9,
    daytimeTo: 21,
    // 'shadow': the delivery, stuck and unstable brakes are logged (safety_events kind 'shadow') but never slow
    // sending; 'enforce': they apply. The brakes above always apply.
    brakesMode: 'shadow',
});
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const isoOf = (ms) => new Date(ms).toISOString();

/** Brakes that hold all bulk and new chats while they last (written by CampaignManager.recordBrake). */
export const HALTING_BRAKES = Object.freeze(['delivery', 'stuck', 'unstable']);
/** How long each halting brake holds once it fires. Unstable is a pause only, never a demotion. */
export const HALT_HOURS = Object.freeze({ delivery: 12, stuck: 12, unstable: 8 });

/**
 * The delivery and stuck brakes a 2-24h window (`{ sentWin, deliveredWin, stuckWin }`, db.deliveryWindow)
 * trips: `[{ code, text }]`. Both rates share one denominator, so neither can pass 100%.
 */
export function deliveryBrakes(win = {}, b = BRAKES) {
    const { sentWin = 0, deliveredWin = 0, stuckWin = 0 } = win;
    if (!sentWin) return [];
    const out = [];
    if (sentWin >= b.deliveryMinSent && pct(deliveredWin, sentWin) < b.deliveryMinPercent) {
        out.push({ code: 'delivery', text: `Only ${deliveredWin} of ${sentWin} messages sent 2-24 hours ago were delivered `
            + `(${pct(deliveredWin, sentWin)}%, under ${b.deliveryMinPercent}%). Bulk and new chats wait 12 hours.` });
    }
    if (pct(stuckWin, sentWin) > b.stuckMaxPercent) {
        out.push({ code: 'stuck', text: `${stuckWin} of ${sentWin} messages sent 2-24 hours ago are still on one tick `
            + `(${pct(stuckWin, sentWin)}%, over ${b.stuckMaxPercent}%). Bulk and new chats wait 12 hours.` });
    }
    return out;
}

/**
 * Promotion and demotion lines (%), judged on the number's sends from 7 days ago (or its last demotion, if later)
 * to 2 hours ago (replies to sends up to 24 hours ago). Rates count once `deliveryMinSent` were sent, replies once `replyMinReached` were reached (BRAKES).
 * After a demotion: no promotion for `probationHours`, then `cleanChecks` passing checks `checkGapHours` apart.
 */
export const HEALTH = Object.freeze({
    promoteDelivered: 92, promoteStuck: 5, promoteReplied: 10, promoteFailed: 3,
    dropTwoDelivered: 85, dropTwoStuck: 20, dropOneDelivered: 90, dropOneReplied: 5,
    probationHours: 48, cleanChecks: 2, checkGapHours: 6,
});

/**
 * A number's health (`ledger.health`: `{ sent, attempted, delivered, failed, stuck, reached, replied }`) against HEALTH:
 * `{ judged, passes, drop, reason, ... rates }`. `judged`: enough was sent to rate it. `passes`: a promotion may
 * go ahead (an unrated number passes). `drop`: levels to demote (0-2), `reason` delivery | stuck | replies.
 */
export function healthCheck(h = {}, b = BRAKES, x = HEALTH) {
    const { sent = 0, delivered = 0, failed = 0, stuck = 0, reached = 0, replied = 0 } = h;
    const judged = sent >= b.deliveryMinSent;
    const heard = reached >= b.replyMinReached;
    // `attempted` adds the sends that failed before leaving (no sent_at), which only the failed rate counts.
    const rates = { delivered: pct(delivered, sent), stuck: pct(stuck, sent), failed: pct(failed, h.attempted ?? sent), replied: pct(replied, reached) };
    let [drop, reason] = [0, null];
    if (judged && rates.delivered < x.dropTwoDelivered) [drop, reason] = [2, 'delivery'];
    else if (judged && rates.stuck > x.dropTwoStuck) [drop, reason] = [2, 'stuck'];
    else if (judged && rates.delivered < x.dropOneDelivered) [drop, reason] = [1, 'delivery'];
    else if (heard && rates.replied < x.dropOneReplied) [drop, reason] = [1, 'replies'];
    const passes = (!judged || (rates.delivered >= x.promoteDelivered && rates.stuck <= x.promoteStuck && rates.failed <= x.promoteFailed))
        && (!heard || rates.replied >= x.promoteReplied);
    return { judged, passes, drop, reason, sent, reached, rates };
}

const healthText = (c) => `${c.rates.delivered}% delivered, ${c.rates.stuck}% still one tick, ${c.rates.failed}% failed of ${c.sent} sent`
    + `${c.reached ? `, ${c.rates.replied}% of ${c.reached} replied` : ''}`;

/**
 * Where a QR number stands, from `db.sendingLedger()`. Pure: the ledger is the
 * state, so a restart or a relink cannot reset it. Returns
 * `{ row, earned, ready, natural, level, pinned, capped, have, next, brakes, resting, health, probation, state, changes }`:
 * `ready` is what the history alone gives, `earned` that after the promotion gate (meets), `natural` what
 * applies today after the rest and idle decay, and `level` / `row` that after the admin's
 * `pin` and `cap`: min(cap, pin ?? natural). A pin skips the rest and the idle
 * step-down; every other brake still applies. `brakes` are `{ code, until, text }`;
 * their budget effects are applied by safety.js allowanceFrom.
 * `start`: the level the number's questions gave (policy/levels.js startLevelFor), answered at `startedAt`.
 * Its needs count as met, so the number climbs on from there. The caller drops a voided one.
 * `state`: the stored level state (db.levelState `{ level, demotedAt, cleanChecks, checkedAt }`), or null (nothing
 * remembered: no gate, demotion or probation). With it, a promotion needs good health (healthCheck), bad health
 * demotes, and a demotion starts probation; under `brakesMode` 'shadow' these are only noted (kind 'shadow'), never
 * applied. Returns the `state` to store and the `changes` to log: `{ kind ('level' | 'shadow'), reason, from, to,
 * text, daily }` (`daily`: logged once a day).
 */
export function levelFor(ledger, {
    linkedAt = '', now = new Date(), dayStart = now, levels = LEVELS, brakes: b = BRAKES, cap = null, pin = null,
    start = null, startedAt = '', state = null,
} = {}) {
    const t = now.getTime();
    const seed = start == null ? {} : levels[Math.min(start, levels.length - 1)]?.need ?? {};
    const have = {
        activeDays: (ledger.activeDays ?? 0) + (seed.days ?? 0),
        delivered: (ledger.delivered ?? 0) + (seed.delivered ?? 0),
        bulk: (ledger.bulkDelivered ?? 0) + (seed.bulk ?? 0),
    };
    const needsMet = ({ days, delivered, bulk }) => have.activeDays >= days && have.delivered >= delivered && have.bulk >= bulk;
    const ready = (levels.findLast((row) => row.need && needsMet(row.need)) ?? levels[1]).level;

    // The level state: demotion, probation and the promotion gate. Shadow mode notes them and applies none.
    const enforce = b.brakesMode === 'enforce';
    const health = healthCheck(ledger.health, b);
    const changes = [];
    const note = (kind, reason, from, to, text, daily = false) => changes.push({ kind, reason, from, to, text, daily });
    const next = state && { level: state.level ?? ready, demotedAt: state.demotedAt ?? null, cleanChecks: state.cleanChecks ?? 0, checkedAt: state.checkedAt ?? null };
    let demotedNow = false;
    let onProbation = false;
    let hold = null;
    if (next) {
        // The last demotion bounds the health window (db.sendingLedger healthSince) until it is 7 days old, even
        // after probation promoted the number: forgetting it sooner would re-judge the sends that caused it.
        const lastDemotion = Date.parse(next.demotedAt ?? '') || 0;
        if (lastDemotion && t - lastDemotion > 7 * 86_400_000 && next.cleanChecks >= HEALTH.cleanChecks) {
            Object.assign(next, { demotedAt: null, cleanChecks: 0, checkedAt: null });
        }
        // A ban, a new number or tighter needs restart the history under the stored level: follow it down.
        if (ready < next.level) {
            note('level', 'history', next.level, ready, `The sending history restarted, so the level follows it to ${ready}.`);
            next.level = ready;
        }
        const to = Math.max(1, next.level - health.drop);
        if (to < next.level) {
            const text = `Health over the last 7 days (${healthText(health)}) drops this number ${next.level - to} level${next.level - to > 1 ? 's' : ''}.`;
            if (enforce) {
                note('level', `demote_${health.reason}`, next.level, to, text);
                Object.assign(next, { level: to, demotedAt: isoOf(t), cleanChecks: 0, checkedAt: null });
                demotedNow = true;
            } else note('shadow', `demote_${health.reason}`, next.level, to, text, true);
        }
        // Probation: no promotion for 48h, then two passing checks 6h apart. A check with too few sends counts neither way.
        const demotedAt = enforce ? Date.parse(next.demotedAt ?? '') || 0 : 0;
        if (demotedAt && !demotedNow && t >= demotedAt + HEALTH.probationHours * 3_600_000 && health.judged) {
            if (!health.passes) Object.assign(next, { cleanChecks: 0, checkedAt: null });
            else if (t - (Date.parse(next.checkedAt ?? '') || 0) >= HEALTH.checkGapHours * 3_600_000) {
                Object.assign(next, { cleanChecks: next.cleanChecks + 1, checkedAt: isoOf(t) });
            }
        }
        onProbation = demotedAt > 0 && (t < demotedAt + HEALTH.probationHours * 3_600_000 || next.cleanChecks < HEALTH.cleanChecks);
        if (ready > next.level) hold = !health.passes ? 'health' : onProbation ? 'probation' : null;
    }
    // A level above the one the gate holds is met only once the number is healthy (and out of probation).
    const meets = (row) => needsMet(row.need) && (!next || row.level <= next.level || !hold || !enforce);
    const earned = (levels.findLast((row) => row.need && meets(row)) ?? levels[1]).level;
    if (next) {
        if (hold && !demotedNow) {
            note(enforce ? 'level' : 'shadow', `hold_${hold}`, next.level, enforce ? next.level : earned, hold === 'health'
                ? `Level ${ready} is earned, but the move up waits for better health (${healthText(health)}).`
                : `Level ${ready} is earned, but the move up waits: probation after a demotion (48 hours, then ${HEALTH.cleanChecks} passing health checks ${HEALTH.checkGapHours} hours apart).`, true);
        }
        if (earned > next.level) {
            note('level', 'promote', next.level, earned, `Moved up to level ${earned} (${healthText(health)}).`);
            // demotedAt stays (see above); its passed checks keep probation over.
            next.level = earned;
        }
    }
    const demotedAt = onProbation ? Date.parse(next.demotedAt) : 0;
    const probation = demotedAt ? {
        since: next.demotedAt, until: isoOf(demotedAt + HEALTH.probationHours * 3_600_000), cleanChecks: next.cleanChecks, needs: HEALTH.cleanChecks,
    } : null;

    const pinned = pin != null;
    const brakes = [];
    const brake = (code, until, text) => brakes.push({ code, until: until == null ? null : isoOf(until), text });

    // A ban restarts the history (the ledger's anchor) and rests the number again, longer when it repeats.
    const banAt = Date.parse(ledger.lastBanAt ?? '');
    const bans = ledger.bans30d ?? 0;
    const restFrom = Math.max(Date.parse(linkedAt || '') || 0, banAt || 0);
    const endsAt = restFrom ? restFrom + b.restHours[Math.min(bans, b.restHours.length - 1)] * 3_600_000 : 0;
    // A start above level 2 is a number already in use: no rest after linking. A ban's rest is never skipped,
    // and only real deliveries since the ban lift it early, not a seed from questions answered after it.
    const fromBan = banAt > 0 && banAt >= (Date.parse(linkedAt || '') || 0);
    const rest = t < endsAt && (fromBan
        ? (ledger.delivered ?? 0) < b.restUntilDelivered
        : (start == null || start <= 2) && have.delivered < b.restUntilDelivered);
    const active = rest && !pinned;
    const resting = { active, endsAt: active ? isoOf(endsAt) : null };
    if (banAt && t - banAt < 30 * 86_400_000) {
        brake('ban', banAt + 30 * 86_400_000, `WhatsApp banned this number on ${isoOf(banAt).slice(0, 10)}. Its sending history `
            + `restarted from then${bans > 1 ? `, and ${bans} bans in 30 days make each rest longer` : ''}.`);
    }

    const { reached = 0, replied = 0 } = ledger;
    if (reached >= b.replyMinReached && pct(replied, reached) < b.replyMinPercent) {
        brake('reply_rate', null, `Only ${replied} of the ${reached} people reached in 48 hours replied (${pct(replied, reached)}%, `
            + `under ${b.replyMinPercent}%). Bulk, new chats and the hourly limit are halved until more people reply.`);
    }
    const lastReport = Date.parse(ledger.lastReportAt ?? '');
    if ((ledger.reportBurst ?? 0) >= b.reportsBrakeAt && t - lastReport < 72 * 3_600_000) {
        brake('reports', lastReport + 72 * 3_600_000, `${ledger.reportBurst} people reported this number as spam within 72 hours. `
            + 'Messages to people who never chatted with it wait until 72 hours after the last report.');
    }
    // The delivery, stuck and unstable brakes hold while their row lasts, and only once enforced (rollout rule).
    if (b.brakesMode === 'enforce') {
        for (const h of ledger.holds ?? []) brake(h.code, Date.parse(h.until), h.detail || `Bulk and new chats wait until ${h.until}.`);
    }
    const flagged = (ledger.blocks7d ?? 0) + (ledger.reports7d ?? 0);
    if ((ledger.delivered7d ?? 0) >= b.blockMinDelivered && pct(flagged, ledger.delivered7d) > b.blockMaxPercent) {
        brake('blocks', null, `Blocks and reports this week (${flagged}) are ${pct(flagged, ledger.delivered7d)}% of the `
            + `${ledger.delivered7d} messages delivered, over ${b.blockMaxPercent}%. Messages to people who never chatted with it wait until that drops.`);
    }
    const tried = (ledger.ok24 ?? 0) + (ledger.failed24 ?? 0);
    if (tried >= b.failureMinSends && pct(ledger.failed24, tried) > b.failureMaxPercent) {
        brake('failures', null, `${ledger.failed24} of ${tried} sends failed in 24 hours (${pct(ledger.failed24, tried)}%, `
            + `over ${b.failureMaxPercent}%). Messages to people who never chatted with it wait until failures drop: remove wrong numbers from the list.`);
    }
    if (ledger.restrictedUntil) {
        brake('restricted', Date.parse(ledger.restrictedUntil), `WhatsApp is limiting messages from this number to new people`
            + `${ledger.restrictCode ? ` (code ${ledger.restrictCode})` : ''}. New chats and number checks wait until it lifts.`);
    }
    // A number that went quiet starts the day one level lower (never below 1), and one more for every further 3
    // quiet days, down to its starting level. A seeded start counts from its answer, so it is not stepped down
    // before it sent anything (level 1 seeds nothing).
    const lastBefore = Math.max(Date.parse(ledger.lastDeliveredBefore ?? '') || 0, !(start > 1) ? 0 : Date.parse(startedAt || '') || 0);
    const idle = earned > 1 && !(lastBefore >= dayStart.getTime() - 72 * 3_600_000);
    const quietDays = lastBefore ? Math.floor((dayStart.getTime() - lastBefore) / 86_400_000) : 3;
    const idleLevel = Math.max(Math.min(earned - 1, Math.max(1, start ?? 1)), earned - Math.max(1, Math.floor(quietDays / 3)));
    if (idle && !pinned) {
        const text = `Nothing was delivered in the ${quietDays} days before today, so today runs at level ${idleLevel} `
            + '(one level lower for every 3 quiet days, down to its starting level).';
        brake('idle', dayStart.getTime() + 86_400_000, text);
        note('level', 'idle', earned, idleLevel, text, true);
    }

    const natural = rest ? 0 : (idle ? idleLevel : earned);
    const top = levels.length - 1;
    const wanted = Math.min(top, pinned ? pin : natural);
    const level = Math.min(cap ?? top, wanted);
    const up = levels[earned + 1];
    return {
        row: levels[level],
        earned,
        ready,
        natural,
        level,
        pinned,
        capped: level < wanted,
        have,
        next: up ? { level: up.level, name: up.name, need: up.need } : null,
        brakes,
        resting,
        health,
        probation,
        state: next,
        changes,
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

const clockFormats = new Map();

/** Day key and minutes since midnight on the wall clock of `zone` (server clock when no zone). */
export function wallClock(at = new Date(), zone = null) {
    if (!zone) return { day: `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`, minute: at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60 };
    let format = clockFormats.get(zone);
    if (!format) {
        format = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
        clockFormats.set(zone, format);
    }
    const p = Object.fromEntries(format.formatToParts(at).map((x) => [x.type, Number(x.value)]));
    return { day: `${p.year}-${p.month}-${p.day}`, minute: p.hour * 60 + p.minute + p.second / 60 };
}

export const localDayKey = (at = new Date(), zone = null) => wallClock(at, zone).day;

/** A rest shorter than this is not worth a pause; the day's total is split so none falls below it. */
const MIN_WINDOW_MINUTES = 40;
/** Sending time guaranteed between two rests. Each window keeps half of it clear on both sides of its slot. */
const MIN_GAP_MINUTES = 120;

/**
 * Splits the day's rest into 2-3 separate windows. The day is cut into one
 * equal slot per window and each window sits at a random spot inside its slot,
 * at least half the gap away from the slot edges: so no window crosses
 * midnight, none overlap, and two neighbours are never closer than the gap.
 * Window sizes are weighted (0.5x-1.5x) so they differ, but each is at least
 * MIN_WINDOW_MINUTES and the sizes add up to `total` exactly.
 */
function quietWindows(random, total) {
    const count = Math.max(1, Math.min(random() < 0.5 ? 2 : 3, Math.floor(total / MIN_WINDOW_MINUTES)));
    const weights = Array.from({ length: count }, () => 0.5 + random());
    const spare = total - count * MIN_WINDOW_MINUTES;
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const sizes = weights.map((w) => MIN_WINDOW_MINUTES + Math.floor((spare * w) / weightSum));
    sizes[count - 1] += total - sizes.reduce((a, b) => a + b, 0);   // rounding remainder
    const slot = 1440 / count;
    const margin = MIN_GAP_MINUTES / 2;
    return sizes.map((minutes, i) => ({
        start: Math.round(i * slot + margin + random() * (slot - 2 * margin - minutes)),
        minutes,
    }));
}

/**
 * Today's rhythm for one number: every day draws a different gap multiplier
 * and different rest windows, so no two days repeat the same timing.
 * Deterministic per (seed, day) so a restart does not re-roll mid-day.
 * `windows` are `{ start, minutes }` in minutes since local midnight in `zone`,
 * sorted and never crossing midnight. `quietMinutes` is their total and
 * `quietStart` the first start, for callers that only know one window.
 */
export function dayPlan(seed, tier, at = new Date(), zone = null) {
    const random = seeded(`${seed}|${localDayKey(at, zone)}`);
    const [lo, hi] = tier.quietHours;
    const quietMinutes = Math.round((lo + random() * (hi - lo)) * 60);
    const gapFactor = 0.8 + random() * 0.5;
    const windows = quietWindows(random, quietMinutes);
    return { gapFactor, quietStart: windows[0].start, quietMinutes, windows, zone };
}

/** A plan with only `quietStart` / `quietMinutes` (older shape) counts as one window. */
const windowsOf = (plan) => plan.windows ?? [{ start: plan.quietStart, minutes: plan.quietMinutes }];

const windowAt = (plan, minute) => windowsOf(plan).find((w) => minute >= w.start && minute < w.start + w.minutes);

export function inQuiet(plan, at = new Date()) {
    return Boolean(windowAt(plan, wallClock(at, plan.zone).minute));
}

/** Seconds until the rest window we are in ends (0 when not resting). */
export function quietLeftSeconds(plan, at = new Date()) {
    const { minute } = wallClock(at, plan.zone);
    const w = windowAt(plan, minute);
    return w ? Math.ceil((w.start + w.minutes - minute) * 60) : 0;
}

/**
 * Today's rest as the UI shows it. `nowMinute` is the channel's clock when
 * asked: the windows are in that zone, which may not be the viewer's, so each
 * window also carries `startAt` / `endAt` (ms epoch) a viewer in any zone can
 * format. `nowAt` is the server's clock, for the viewer to correct its own skew.
 */
export function quietStatus(plan, at = new Date()) {
    const nowAt = at.getTime();
    const minute = wallClock(at, plan.zone).minute;
    // Counted from the whole second `minute` was read at, so a window's instant is the same on every
    // call and the UI can use it as a stable key.
    // ponytail: ignores a DST change inside the day (an hour off on those two days); add a zone-aware conversion if it matters.
    const instant = (m) => Math.round(Math.floor(nowAt / 1000) * 1000 + (m - minute) * 60_000);
    return {
        active: inQuiet(plan, at),
        leftSeconds: quietLeftSeconds(plan, at),
        minutesToday: plan.quietMinutes,
        startMinute: plan.quietStart,
        windows: windowsOf(plan).map((w) => ({
            startMinute: w.start,
            endMinute: w.start + w.minutes,
            startAt: instant(w.start),
            endAt: instant(w.start + w.minutes),
        })),
        nowMinute: Math.round(minute * 100) / 100,
        nowAt,
    };
}

/**
 * Rest time a run of `seconds` of sending would meet if it started at `at`:
 * walks forward through every window of each day (`planFor(date)` gives that
 * day's plan). Up to three windows a day means ~7 steps a day; 250 steps cover
 * the longest sheets a tier-1 number can work through.
 */
export function quietExtraSeconds(planFor, seconds, at = new Date()) {
    let t = at.getTime();
    let left = seconds;
    let extra = 0;
    for (let i = 0; i < 250 && left > 0; i += 1) {
        const plan = planFor(new Date(t));
        const { minute } = wallClock(new Date(t), plan.zone);
        const inside = windowAt(plan, minute);
        let step;
        if (inside) {
            step = (inside.start + inside.minutes - minute) * 60;
            extra += step;
        } else {
            // Sending until the next window opens (still ahead today) or until local midnight.
            const next = windowsOf(plan).find((w) => w.start > minute);
            step = ((next ? next.start : 1440) - minute) * 60;
            if (left <= step) break;
            left -= step;
        }
        t += (step + 1) * 1000;
    }
    return Math.round(extra);
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
export function isDaytimeFor(phone, at = new Date(), { from = BRAKES.daytimeFrom, to = BRAKES.daytimeTo } = {}) {
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

/** A campaign message still on one tick is judged for a block once, at this age (db.stuckSent). */
export const BLOCK_SUSPECT_AFTER_SECONDS = 48 * HOUR;

/** Pause a campaign when blocks + reports reach this share of the week's sends (once enough went out). */
export const BLOCK_PAUSE_PERCENT = 5;
export const BLOCK_PAUSE_MIN_SENT = 40;
