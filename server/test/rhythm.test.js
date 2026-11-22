/** The human rhythm of bulk sending (campaign/rhythm.js): random everywhere, and every campaign at the row's speed. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { LEVELS, TYPING_SECONDS, seeded, typingMs } from '../src/campaign/humanize.js';
import {
    breakSeconds, campaignRhythm, cycleSeconds, gapSeconds, nextSitting, rescaled, samePace,
} from '../src/campaign/rhythm.js';
import { paceFor, speedRow } from '../src/campaign/safety.js';

const paceOf = (row) => paceFor(0, {}, 'balanced', row);
const mean = (list) => list.reduce((a, b) => a + b, 0) / list.length;
const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
/** The row's own time per message: its cycle and the share of a break each message carries. */
const target = (pace) => cycleSeconds(pace) + (pace.restMinSeconds + pace.restMaxSeconds) / 2 / pace.restEvery;

/**
 * One campaign on one number, as the manager runs it: each message's typing (long or short text) and a 0.5-1.5 s
 * send come out of its wait, a floor-held wait is owed, a break settles it. Seconds per message. Seeded: stable.
 */
function run(pace, key, { messages = 2000, chars = [150, 400], day = 1 } = {}) {
    const random = seeded(`run|${key}`);
    const rhythm = campaignRhythm(key);
    let [total, owed, overhead] = [0, 0, 1];
    let sitting = nextSitting(pace, rhythm, day, random);
    let left = sitting.size;
    for (let m = 0; m < messages; m += 1) {
        if (left <= 0) {
            total += Math.max(0, breakSeconds(pace, rhythm, sitting.size, random) - owed);
            owed = 0;
            sitting = nextSitting(pace, rhythm, day, random);
            left = sitting.size;
        }
        const text = 'x'.repeat(chars[0] + Math.floor(random() * (chars[1] - chars[0])));
        const typing = Math.min(typingMs(text, {}, random), Math.max(1500, cycleSeconds(pace) * 500)) / 1000;
        const send = 0.5 + random();
        const gap = gapSeconds(pace, rhythm, sitting, { work: typing + overhead, owed }, random);
        owed = gap.owed;
        overhead = overhead * 0.8 + send * 0.2;
        total += gap.seconds + typing + send;
        left -= 1;
    }
    return total / messages;
}

describe('every campaign its own rhythm', () => {
    it('is drawn once per campaign and number, the same again after a restart, and differs between campaigns', () => {
        assert.deepEqual(campaignRhythm('1:1|campaign-7'), campaignRhythm('1:1|campaign-7'));
        assert.notDeepEqual(campaignRhythm('1:1|campaign-7'), campaignRhythm('1:1|campaign-8'));
        assert.notDeepEqual(campaignRhythm('1:1|campaign-7'), campaignRhythm('1:2|campaign-7'), 'another number, another rhythm');
        const spreads = new Set(Array.from({ length: 50 }, (_, i) => campaignRhythm(`1:1|campaign-${i}`).spread.toFixed(4)));
        assert.equal(spreads.size, 50);
    });

    for (const [name, row] of [['level 11', LEVELS[11]], ['a set speed of 1,000 a day', speedRow(LEVELS[11], 1000, 24, true)],
        ['a set speed of 5,000 a day', speedRow(LEVELS[11], 5000, 24, true)], ['a set speed of 10,000 a day', speedRow(LEVELS[11], 10000, 24, true)]]) {
        it(`runs at ${name} whatever its shape and its messages cost: long ones type longer, the wait gives it back`, () => {
            const pace = paceOf(row);
            const perCampaign = Array.from({ length: 40 }, (_, c) => run(pace, `1:1|campaign-${c}`) / target(pace));
            assert.ok(Math.abs(median(perCampaign) - 1) < 0.02, `median ${median(perCampaign).toFixed(3)} of the speed`);
            for (const ratio of perCampaign) assert.ok(Math.abs(ratio - 1) < 0.07, `a campaign at ${ratio.toFixed(3)} of the speed`);
            // Short messages too: the same speed.
            assert.ok(Math.abs(run(pace, '1:1|short', { chars: [10, 60] }) / target(pace) - 1) < 0.07);
        });
    }
});

describe('gaps, sittings and breaks', () => {
    for (const row of [LEVELS[1], LEVELS[11]]) {
        it(`level ${row.level}: gaps vary with a long tail, never quicker than its fastest day, its gap on average`, () => {
            const pace = paceOf(row);
            const random = seeded(`gaps|${row.level}`);
            const gaps = [];
            for (let c = 0; c < 100; c += 1) {
                const rhythm = campaignRhythm(`1:1|campaign-${c}`);
                for (let s = 0; s < 20; s += 1) {
                    const sitting = nextSitting(pace, rhythm, 1, random);
                    // Typing as the row leaves room for it: the wait is the gap itself.
                    for (let m = 0; m < 20; m += 1) gaps.push(gapSeconds(pace, rhythm, sitting, {}, random).seconds);
                }
            }
            const middle = (row.minSeconds + row.maxSeconds) / 2;
            assert.ok(Math.min(...gaps) >= row.minSeconds * 0.8 - 1e-9, `quickest ${Math.min(...gaps)}s`);
            assert.ok(Math.max(...gaps) <= row.maxSeconds * 3 + 1e-9, `longest ${Math.max(...gaps)}s`);
            assert.ok(Math.abs(mean(gaps) / middle - 1) < 0.03, `average ${mean(gaps).toFixed(1)}s against ${middle}s`);
            assert.ok(median(gaps) < mean(gaps), 'most gaps short, a few long: a person, not an even spread');
            assert.ok(gaps.filter((g) => g > row.maxSeconds).length > gaps.length * 0.03, 'some run past the old longest');
            // Spread against the average: more varied than the old even draw between the row's shortest and longest.
            const average = mean(gaps);
            const spread = Math.sqrt(mean(gaps.map((g) => (g - average) ** 2))) / average;
            assert.ok(spread > (row.maxSeconds - row.minSeconds) / Math.sqrt(12) / middle, `spread ${spread.toFixed(2)}`);
        });
    }

    it('takes a message\'s own time out of its wait, down to the floor, and owes what the floor held back', () => {
        const pace = paceOf(speedRow(LEVELS[11], 5000, 24, true));
        const rhythm = campaignRhythm('1:1|x');
        const sitting = { size: 50, tempo: 1 };
        const quick = gapSeconds(pace, rhythm, sitting, { work: 0.5 }, () => 0.5);
        const slow = gapSeconds(pace, rhythm, sitting, { work: 6 }, () => 0.5);
        assert.ok(Math.abs(quick.seconds - slow.seconds - 5.5) < 1e-9, 'a message that takes 5.5 s longer waits 5.5 s less');
        // A message 2 s longer than the floor allows: the wait stops at the floor and owes the 2 s.
        const floor = pace.minSeconds * 0.8;
        const held = gapSeconds(pace, rhythm, sitting, { work: 0.5 + (quick.seconds - floor) + 2 }, () => 0.5);
        assert.equal(held.seconds, floor);
        assert.ok(Math.abs(held.owed - 2) < 1e-9, `owes ${held.owed}s`);
        const after = gapSeconds(pace, rhythm, sitting, { work: 0.5, owed: held.owed }, () => 0.5);
        assert.ok(Math.abs(quick.seconds - after.seconds - 2) < 1e-9 && after.owed === 0, 'and the next wait makes it up');
        assert.equal(gapSeconds(pace, rhythm, sitting, { work: 300 }, () => 0.5).owed, cycleSeconds(pace), 'never more than one cycle');
    });

    it('sittings run a random length; a longer one earns a longer break, so the speed holds; the day changes sittings only', () => {
        const pace = paceOf(LEVELS[11]);
        const random = seeded('sittings');
        const sizes = [];
        let [rest, sent] = [0, 0];
        for (let c = 0; c < 200; c += 1) {
            const rhythm = campaignRhythm(`1:1|campaign-${c}`);
            for (let s = 0; s < 10; s += 1) {
                const { size } = nextSitting(pace, rhythm, 1, random);
                sizes.push(size);
                rest += breakSeconds(pace, rhythm, size, random);
                sent += size;
            }
        }
        assert.ok(Math.min(...sizes) >= Math.round(pace.restEvery * 0.4) && Math.max(...sizes) <= Math.round(pace.restEvery * 1.7));
        assert.ok(Math.abs(mean(sizes) / pace.restEvery - 1) < 0.05, `sittings ${mean(sizes).toFixed(1)} against ${pace.restEvery}`);
        assert.ok(new Set(sizes).size > 40, 'not one batch size');
        const share = (pace.restMinSeconds + pace.restMaxSeconds) / 2 / pace.restEvery;
        assert.ok(Math.abs(rest / sent / share - 1) < 0.03, 'each message carries the row\'s share of a break');

        const rhythm = campaignRhythm('1:1|y');
        const breakOf = (size) => mean(Array.from({ length: 2000 }, () => breakSeconds(pace, rhythm, size, random)));
        assert.ok(Math.abs(breakOf(120) / breakOf(60) - 2) < 0.15, 'twice the sitting, about twice the break');
        assert.ok(breakOf(80) > pace.restMinSeconds * 0.7 && Array.from({ length: 400 }, () => breakSeconds(pace, rhythm, 80, random))
            .some((b) => b > ((pace.restMinSeconds + pace.restMaxSeconds) / 2) * 1.8), 'now and then a long break');
        const sittingsOn = (day) => mean(Array.from({ length: 2000 }, () => nextSitting(pace, rhythm, day, random).size));
        assert.ok(sittingsOn(1.25) / sittingsOn(0.85) > 1.3, 'a long-sitting day and a short-sitting one');
        assert.ok(Math.abs(run(pace, '1:1|day', { day: 1.25 }) / run(pace, '1:1|day', { day: 0.85 }) - 1) < 0.07, 'at the same speed');
    });

    it('a wait under way follows a new speed: a gap the message time, a break the break each message carries', () => {
        const slow = paceOf(speedRow(LEVELS[11], 500, 24, true));
        const fast = paceOf(speedRow(LEVELS[11], 5000, 24, true));
        assert.equal(samePace(slow, paceOf(speedRow(LEVELS[11], 500, 24, true))), true);
        assert.equal(samePace(slow, fast), false);
        const gap = rescaled(100, false, slow, fast);
        assert.ok(Math.abs(gap / 100 - cycleSeconds(fast) / cycleSeconds(slow)) < 1e-9 && gap < 15, `${gap}s`);
        assert.ok(rescaled(600, true, slow, fast) < 600 && rescaled(600, true, fast, slow) > 600);
        assert.equal(rescaled(600, true, slow, { ...fast, restEvery: 0 }), 0, 'a row with no rests ends the break');
    });

    it('a row that never rests sits on for good, and a row without gaps waits nothing', () => {
        const rhythm = campaignRhythm('1:1|x');
        assert.equal(nextSitting({ ...paceOf(LEVELS[5]), restEvery: 0 }, rhythm).size, Infinity);
        const none = { ...paceOf(LEVELS[5]), minSeconds: 0, maxSeconds: 0 };
        assert.equal(gapSeconds(none, rhythm, nextSitting(none, rhythm), { work: 0 }).seconds, 0);
    });
});
