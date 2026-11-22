/**
 * The human rhythm of bulk sending, held to the number's speed.
 *
 * The number's row says how fast: its level's, or the speed its super admin set (safety.js speedRow). A message
 * goes every `gap + TYPING_SECONDS` on average, and a rest comes about every `restEvery` messages. The rhythm keeps
 * exactly that speed and makes everything around it random, the way a person works: sittings of a random length,
 * each ending in a break that grows with it; most gaps short, some long, now and then a pause. Every campaign draws
 * its own shape (how much its gaps vary, how often it pauses, how long it sits, how its breaks vary), all at the
 * same speed, and the day changes the sittings, never the speed. A message's own time (its typing, a lookup, the
 * upload) comes out of its wait, so long messages and a slow network do not slow the number below its speed.
 * Pure: the manager keeps the state.
 */

import { TYPING_SECONDS, seeded } from './humanize.js';

/** The shortest wait: this share of the row's shortest gap (as quick as its quickest day ever ran). */
const GAP_FLOOR = 0.8;
/** The longest gap: this many times the row's longest. */
const GAP_CEILING = 3;
/** A break for a sitting of `restEvery`: from this share of the row's shortest rest to this many times its longest. */
const BREAK_FLOOR = 0.7;
const BREAK_CEILING = 3;
/** A sitting: this share of the row's `restEvery`, never under one message. */
const SITTING = Object.freeze([0.4, 1.7]);
/** One break in eight runs long (a meal, a meeting): 2-3 times the usual. */
const LONG_BREAK = 1 / 8;
/** No break is shorter than this, however short the sitting before it (unless the row's own breaks are). */
const SHORTEST_BREAK = 45;

/** A draw around 1 (log-normal with mean 1): mostly near it, now and then far above, never below 0. `sigma`: how far. */
export function around(sigma, random = Math.random) {
    const z = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    return Math.exp(sigma * z - (sigma * sigma) / 2);
}

/**
 * One campaign's rhythm on one number, the same each time it is asked for (seeded by `key`), so a restart keeps it.
 * Its shape only, never its speed: `spread` how much one gap differs from the next, `pauses` how often one runs
 * long, `sitting` / `sittingSpread` how long it sits against the row's `restEvery`, `breakSpread` how its breaks vary.
 */
export function campaignRhythm(key) {
    const random = seeded(`rhythm|${key}`);
    const span = (lo, hi) => lo + random() * (hi - lo);
    return {
        spread: span(0.3, 0.6),
        pauses: span(0.03, 0.1),
        sitting: span(0.6, 1.4),
        sittingSpread: span(0.15, 0.4),
        breakSpread: span(0.3, 0.55),
    };
}

/**
 * A new sitting: how many messages until its break (`size`), and its own `tempo` (one runs quicker than the next, the
 * same on average). `dayFactor` (humanize.js dayPlan): today's sittings run that much longer or shorter, and so do
 * their breaks, which keeps the speed.
 */
export function nextSitting(pace, rhythm, dayFactor = 1, random = Math.random) {
    const tempo = around(0.15, random);
    if (!(pace.restEvery > 0)) return { size: Infinity, tempo };
    const [lo, hi] = SITTING.map((share) => Math.max(1, Math.round(pace.restEvery * share)));
    const size = Math.round(pace.restEvery * rhythm.sitting * dayFactor * around(rhythm.sittingSpread, random));
    return { size: Math.min(hi, Math.max(lo, size)), tempo };
}

/**
 * The wait before the next message of a sitting. Its cycle, send to send, is drawn around the row's
 * `gap + TYPING_SECONDS`: most a little quicker, some much slower, now and then a pause 2-4 times the usual (priced
 * in, so the average holds). Out of it come `work`, this message's own time in seconds (its typing, and the lookup
 * and send the last ones took), and `owed`, what earlier waits ran over their draw: no wait is under GAP_FLOOR of the
 * row's shortest gap. Returns the `seconds` to wait and what is still `owed` (never over one cycle), so the number
 * keeps its speed whatever it sends.
 */
export function gapSeconds(pace, rhythm, sitting, { work = TYPING_SECONDS, owed = 0 } = {}, random = Math.random) {
    const floor = pace.minSeconds * GAP_FLOOR;
    const mean = (pace.minSeconds + pace.maxSeconds) / 2;
    const away = random() < rhythm.pauses ? 2 + random() * 2 : 1;
    const x = (sitting.tempo * around(rhythm.spread, random) * away) / (1 + rhythm.pauses * 2);
    const gap = Math.min(floor + Math.max(0, mean - floor) * x, Math.max(floor, pace.maxSeconds * GAP_CEILING));
    // A row without gaps (a test's) leaves no room for typing either.
    const want = gap + (pace.maxSeconds > 0 ? TYPING_SECONDS : 0) - work - owed;
    const seconds = Math.max(floor, want);
    return { seconds, owed: Math.min(cycleSeconds(pace), seconds - want) };
}

/**
 * Seconds of the break after a sitting of `size` messages: the row's middle rest for a sitting of `restEvery`, more
 * after a longer one and less after a shorter one, so each campaign keeps the speed whatever its sittings. Now and
 * then a long one.
 */
export function breakSeconds(pace, rhythm, size = pace.restEvery, random = Math.random) {
    const floor = pace.restMinSeconds * BREAK_FLOOR;
    const mean = (pace.restMinSeconds + pace.restMaxSeconds) / 2;
    const long = random() < LONG_BREAK ? 2 + random() : 1;
    const x = (around(rhythm.breakSpread, random) * long) / (1 + LONG_BREAK * 1.5);
    const one = Math.min(floor + Math.max(0, mean - floor) * x, Math.max(floor, pace.restMaxSeconds * BREAK_CEILING));
    const share = pace.restEvery > 0 && Number.isFinite(size) ? size / pace.restEvery : 1;
    return Math.max(Math.min(SHORTEST_BREAK, one), one * share);
}

/** A row's average time for one message inside a sitting, send to send (seconds): its middle gap and its typing room. */
export const cycleSeconds = (pace) => (pace.minSeconds + pace.maxSeconds) / 2 + (pace.maxSeconds > 0 ? TYPING_SECONDS : 0);
/** The break that falls to each message of a row (seconds). */
const restShareOf = (pace) => (pace.restEvery > 0 ? (pace.restMinSeconds + pace.restMaxSeconds) / 2 / pace.restEvery : 0);

/** Whether two rows space messages the same: anything else re-plans a wait or a sitting under way. */
export const samePace = (a, b) => cycleSeconds(a) === cycleSeconds(b) && restShareOf(a) === restShareOf(b) && a.restEvery === b.restEvery;

/**
 * The time left of a wait under way, re-scaled to a new row (the super admin set another speed, or the level moved):
 * a gap follows the cycle, a break the share of a break each message carries. The next one is drawn new anyway.
 */
export function rescaled(seconds, resting, from, to) {
    const [before, after] = resting ? [restShareOf(from), restShareOf(to)] : [cycleSeconds(from), cycleSeconds(to)];
    return before > 0 ? seconds * (after / before) : seconds;
}

/**
 * What a level row's rhythm makes of it, for the admin's preview: a message every `perMessage` seconds on average,
 * each wait in `gapSeconds`, sittings of `sitting` messages and the breaks after them in `restMinutes`.
 */
export function rhythmSpans(row) {
    const tenth = (n) => Math.round(n * 10) / 10;
    return {
        perMessage: tenth((row.minSeconds + row.maxSeconds) / 2 + TYPING_SECONDS),
        gapSeconds: [tenth(row.minSeconds * GAP_FLOOR), tenth(row.maxSeconds * GAP_CEILING)],
        restMinutes: [
            tenth(Math.max(SHORTEST_BREAK / 60, row.restMinMinutes * BREAK_FLOOR * SITTING[0])),
            tenth(row.restMaxMinutes * BREAK_CEILING * SITTING[1]),
        ],
        sitting: SITTING.map((share) => Math.max(1, Math.round(row.restEvery * share))),
    };
}
