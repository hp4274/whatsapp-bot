import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    LEVELS, contactZone, contentError, dayPlan, inQuiet, quietExtraSeconds, quietLeftSeconds, quietStatus, isDaytimeFor, seeded, shuffle, typingMs, zoneOf,
} from '../src/campaign/humanize.js';
import { MessageQueue, queueItem } from '../src/campaign/queue.js';

// Pace rows with a long, a middle and a short nightly rest.
const ROWS = [LEVELS[1], LEVELS[6], LEVELS[8]];

describe('day plan', () => {
    it('is stable within a day and differs between days', () => {
        const a = dayPlan('t:1', ROWS[0], new Date(2026, 5, 1, 10));
        assert.deepEqual(a, dayPlan('t:1', ROWS[0], new Date(2026, 5, 1, 23)));
        const days = new Set();
        for (let d = 1; d <= 14; d += 1) days.add(dayPlan('t:1', ROWS[0], new Date(2026, 5, d)).gapFactor.toFixed(4));
        assert.ok(days.size > 10, 'no two days share a rhythm');
    });

    it('rests for the tier\'s hours, inside one day', () => {
        for (let d = 1; d <= 30; d += 1) {
            const plan = dayPlan('t:1', ROWS[0], new Date(2026, 5, d));
            assert.ok(plan.quietMinutes >= 360 && plan.quietMinutes <= 480);
            assert.ok(plan.quietStart + plan.quietMinutes <= 24 * 60);
        }
        const plan = { quietStart: 120, quietMinutes: 60 };
        assert.ok(inQuiet(plan, new Date(2026, 5, 1, 2, 30)));
        assert.ok(!inQuiet(plan, new Date(2026, 5, 1, 3, 0)));
    });

    it('splits the rest into 2-3 separate windows that never touch', () => {
        const counts = new Set();
        for (const tier of ROWS) {
            const [lo, hi] = tier.quietHours;
            for (let n = 0; n < 400; n += 1) {
                const day = new Date(2026, 0, 1 + (n % 365));
                const plan = dayPlan(`seed:${n}`, tier, day, 'UTC');
                const { windows } = plan;
                const label = `level ${tier.level} seed ${n}`;
                counts.add(windows.length);
                assert.ok(windows.length >= 2 && windows.length <= 3, label);
                assert.equal(windows.reduce((sum, w) => sum + w.minutes, 0), plan.quietMinutes, `${label}: total preserved`);
                assert.ok(plan.quietMinutes >= lo * 60 && plan.quietMinutes <= hi * 60, label);
                assert.equal(plan.quietStart, windows[0].start);
                windows.forEach((w, i) => {
                    assert.ok(w.minutes >= 40, `${label}: window of ${w.minutes} min`);
                    assert.ok(Number.isInteger(w.start) && Number.isInteger(w.minutes), label);
                    assert.ok(w.start >= 0 && w.start + w.minutes <= 1440, `${label}: inside the day`);
                    if (i) assert.ok(w.start - (windows[i - 1].start + windows[i - 1].minutes) >= 120, `${label}: 2h of sending between rests`);
                });
            }
        }
        assert.deepEqual([...counts].sort(), [2, 3], 'both shapes occur');
    });

    it('draws the same windows for the same seed and day', () => {
        const a = dayPlan('t:1', ROWS[1], new Date(2026, 5, 1, 9), 'UTC');
        assert.deepEqual(a, dayPlan('t:1', ROWS[1], new Date(2026, 5, 1, 21), 'UTC'));
        assert.notDeepEqual(a.windows, dayPlan('t:1', ROWS[1], new Date(2026, 5, 2, 9), 'UTC').windows);
    });

    it('seeded() repeats', () => {
        assert.equal(seeded('x')(), seeded('x')());
        assert.notEqual(seeded('x')(), seeded('y')());
    });
});

describe('typing and order', () => {
    it('always pauses at least 2s before sending; media takes longer', () => {
        for (let i = 0; i < 50; i += 1) assert.ok(typingMs('hi') >= 2000);
        assert.ok(typingMs('hi', { media: true }, () => 0) >= 5000);
    });

    it('shuffle keeps everyone and changes the order', () => {
        const sheet = Array.from({ length: 50 }, (_, i) => i);
        const out = shuffle([...sheet]);
        assert.deepEqual([...out].sort((a, b) => a - b), sheet);
        assert.notDeepEqual(out, sheet);
    });
});

describe('recipient local time', () => {
    it('maps a number to its zone and checks 9-21 there', () => {
        assert.equal(zoneOf('919876543210'), 'Asia/Kolkata');
        assert.equal(zoneOf('4420712345678'), 'Europe/London');
        assert.equal(zoneOf('0000'), null);
        const noonUtc = new Date('2026-06-01T06:30:00Z');   // 12:00 in India, 07:30 in London
        assert.ok(isDaytimeFor('919876543210', noonUtc));
        assert.ok(!isDaytimeFor('447207123456', noonUtc));
        // US spans coasts: 07:00 in London is 02:00 in New York, so it waits; 18:30 UTC is 14:30 / 11:30 there.
        assert.ok(!isDaytimeFor('12125550100', new Date('2026-06-01T07:00:00Z')));
        assert.ok(isDaytimeFor('12125550100', new Date('2026-06-01T18:30:00Z')));
        assert.ok(!isDaytimeFor('12125550100', new Date('2026-06-01T14:00:00Z')), '07:00 in Los Angeles is too early');
        assert.ok(isDaytimeFor('0000', noonUtc), 'unknown country is never held');
    });

    it('uses a contact\'s own timezone field over the country code, and ignores a bad one', () => {
        const at = new Date('2026-06-01T14:00:00Z'); // 10:00 in New York, 07:00 in Los Angeles
        assert.ok(!isDaytimeFor('12125550100', at), 'the country code waits for the west coast');
        assert.equal(contactZone({ timezone: ' America/New_York ' }), 'America/New_York');
        assert.ok(isDaytimeFor('12125550100', at, { zone: contactZone({ timezone: 'America/New_York' }) }));
        // 23:30 in India, 14:00 in New York: an Indian number living in New York is messaged now.
        assert.ok(isDaytimeFor('919876543210', new Date('2026-06-01T18:00:00Z'), { zone: 'America/New_York' }));
        assert.equal(contactZone({ timezone: 'Mars/Olympus' }), null);
        assert.equal(contactZone({}), null);
        assert.equal(contactZone(null), null);
        assert.ok(!isDaytimeFor('12125550100', at, { zone: contactZone({ timezone: 'Mars/Olympus' }) }), 'a bad zone falls back');
    });
});

describe('content check', () => {
    it('lets normal text through, placeholders included', () => {
        assert.equal(contentError('Hi {name}, your order is ready. Thanks! 🙂'), null);
        assert.equal(contentError('{NAME} {ORDER_ID}'), null);
    });
    it('refuses shouting, emoji walls and !!!', () => {
        assert.match(contentError('BUY NOW BEFORE THE SALE ENDS TODAY'), /CAPITAL/);
        assert.match(contentError('Hi 🎉🎉🎉🎉🎉🎉'), /emoji/);
        assert.match(contentError('Great deal!!!'), /exclamation/);
        assert.match(contentError('a! b! c! d!'), /exclamation/);
    });
});

describe('queue ready()', () => {
    it('skips items that must wait and keeps their place', () => {
        const queue = new MessageQueue();
        const a = queueItem({ recipient: '1', message: 'a' });
        const b = queueItem({ recipient: '2', message: 'b' });
        queue.put(a);
        queue.put(b);
        assert.equal(queue.get((i) => i !== a), b);
        assert.equal(queue.get((i) => i !== a), null);
        assert.equal(queue.get(), a);
        const c = queueItem({ recipient: '3', message: 'c' });
        const d = queueItem({ recipient: '4', message: 'd' });
        queue.putLast(c);
        queue.put(d);
        assert.equal(queue.get(), c);
    });
});

// ------------------------------------------------------------ the manager --
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';

async function run(contacts, { config = {}, rounds = 1, template = 'Hi {name}', onePerNumber = true, waitFor = contacts.length * rounds, ms = 3000 } = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-human-'));
    const db = new Database(path.join(tmp, 'h.db'));
    const sent = [];
    const transport = {
        name: 'fake', realDelivery: true, supportsReceipts: false, isConnected: () => true,
        async sendMessage(to, text, opts) { sent.push({ to, text, opts }); return { providerId: `p${sent.length}`, status: Status.SENT }; },
        getStatus: () => null,
        async disconnect() {},
    };
    const manager = new CampaignManager(db, transport, {
        ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, pacingMode: 'fixed', ...config,
    });
    let result;
    for (let r = 0; r < rounds; r += 1) {
        manager.queue.reset();
        result = manager.enqueueContacts(contacts, template, { onePerNumber });
        manager.start();
        const deadline = Date.now() + ms;
        while (Date.now() < deadline && sent.length < waitFor * (r + 1) / rounds) await new Promise((x) => setTimeout(x, 20));
    }
    await manager.shutdown();
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    return { sent, result };
}

describe('campaign manager', () => {
    // Today's nightly rest is drawn from the number's seed; a test run inside it would just wait.
    const restingNow = () => inQuiet(dayPlan('1:0', ROWS[0]));
    const sheet = Array.from({ length: 12 }, (_, i) => ({ name: `N${i}`, phone: `91985555${String(i).padStart(4, '0')}` }));

    it('sends the same sheet again: a number messaged before is not skipped', async () => {
        const { sent } = await run(sheet.slice(0, 3), { rounds: 2 });
        assert.equal(sent.length, 6);
    });

    it('skips a repeated number by default and sends it twice when the box is off', async () => {
        const twice = [{ name: 'A', phone: '919855550001' }, { name: 'A', phone: '919855550001' }];
        assert.equal((await run(twice, { waitFor: 1 })).sent.length, 1);
        assert.equal((await run(twice, { onePerNumber: false })).sent.length, 2);
    });

    it('does not send in the order of the sheet', async () => {
        const orders = new Set();
        for (let i = 0; i < 3; i += 1) orders.add((await run(sheet)).sent.map((s) => s.to).join());
        assert.ok(orders.size > 1);
    });

    it('refuses a shouting message before anything is queued', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-human-'));
        const db = new Database(path.join(tmp, 'h.db'));
        const manager = new CampaignManager(db, null, { ...DEFAULTS });
        assert.throws(() => manager.enqueueContacts(sheet, 'SALE ENDS TODAY BUY EVERYTHING NOW'), /CAPITAL/);
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('holds a number whose local time is night and sends the rest first', async () => {
        // Pick one country that is in its day and one in its night right now.
        const day = ['91', '44', '81', '1', '61', '55'].find((cc) => isDaytimeFor(`${cc}9855550001`));
        const night = ['91', '44', '81', '1', '61', '55'].find((cc) => !isDaytimeFor(`${cc}9855550001`));
        if (!day || !night || restingNow()) return;   // the clock put every sample zone in daylight, or it is our rest hour
        const contacts = [
            { name: 'Night', phone: `${night}9855550001` },
            { name: 'Day', phone: `${day}9855550002` },
        ];
        const { sent, result } = await run(contacts, { config: { humanTiming: true }, waitFor: 1 });
        assert.equal(result.queued, 2);
        assert.deepEqual(sent.map((s) => s.to), [`${day}9855550002`], 'night number waits for its morning');
    });

    it('holds only campaigns at night off QR numbers: a school reminder goes now', async () => {
        const night = ['91', '44', '81', '1', '61', '55'].find((cc) => !isDaytimeFor(`${cc}9855550001`));
        if (!night) return;   // every sample zone is in daylight (the nightly rest holds campaigns only)
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-human-'));
        const db = new Database(path.join(tmp, 'h.db'));
        const sent = [];
        const transport = {
            name: 'fake', realDelivery: true, supportsReceipts: false, isConnected: () => true,
            async sendMessage(to) { sent.push(to); return { providerId: `p${sent.length}`, status: Status.SENT }; },
            getStatus: () => null,
            async disconnect() {},
        };
        const manager = new CampaignManager(db, transport, { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, pacingMode: 'fixed', humanTiming: true });
        try {
            manager.enqueueJob({ recipient: `${night}9855550001`, text: 'Class cancelled today', messageType: 'reminder' });
            manager.start();
            const deadline = Date.now() + 3000;
            while (Date.now() < deadline && !sent.length) await new Promise((x) => setTimeout(x, 20));
            assert.deepEqual(sent, [`${night}9855550001`]);
        } finally {
            await manager.shutdown();
            db.close();
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    it('shows typing for 2s+ on real sends', async () => {
        // Bulk to a +91 number waits for the recipient's daytime: outside it nothing is sent to measure.
        if (restingNow() || !isDaytimeFor(sheet[0].phone)) return;
        const { sent } = await run(sheet.slice(0, 1), { config: { humanTiming: true } });
        assert.ok(sent[0].opts.typingMs >= 2000);
    });
});

describe('quietExtraSeconds', () => {
    const planFor = () => ({ quietStart: 60, quietMinutes: 360, zone: 'UTC' });
    it('adds the night rest only when the run reaches it', () => {
        const at = new Date('2026-06-01T22:00:00Z');   // 2h before midnight, rest runs 01:00-07:00 UTC
        assert.equal(quietExtraSeconds(planFor, 3600, at), 0);
        assert.ok(Math.abs(quietExtraSeconds(planFor, 4 * 3600, at) - 6 * 3600) <= 1);
    });

    // Rests 01:00-02:00 and 05:00-07:00 UTC, every day.
    const two = { quietStart: 60, quietMinutes: 180, windows: [{ start: 60, minutes: 60 }, { start: 300, minutes: 120 }], zone: 'UTC' };
    const utc = (hhmm, day = 1) => new Date(`2026-06-0${day}T${hhmm}:00Z`);

    it('counts every window it passes, across midnight', () => {
        const planTwo = () => two;
        // 23:00 + 3h of sending: 2h reach 01:00 across midnight, the 1h window is waited out, the last hour ends at 03:00.
        assert.ok(Math.abs(quietExtraSeconds(planTwo, 3 * 3600, utc('23:00')) - 3600) <= 1);
        // 23:00 + 6h of sending: 1h (01-02) and 2h (05-07) of rest land inside the run.
        assert.ok(Math.abs(quietExtraSeconds(planTwo, 6 * 3600, utc('23:00')) - 3 * 3600) <= 2);
        // Starting inside a window counts its remainder first.
        assert.ok(Math.abs(quietExtraSeconds(planTwo, 600, utc('06:00')) - 3600) <= 1);
        // A run that ends before the first window sees none.
        assert.equal(quietExtraSeconds(planTwo, 3600, utc('00:00')), 0);
    });

    it('agrees with a minute-by-minute walk over several days of real plans', () => {
        for (const tier of ROWS) {
            const planFor = (date) => dayPlan('walk', tier, date, 'UTC');
            const at = utc('22:00');
            const seconds = 4 * 24 * 3600;
            let sending = 0;
            let quiet = 0;
            for (let t = at.getTime(); sending * 60 < seconds; t += 60_000) {
                if (inQuiet(planFor(new Date(t)), new Date(t))) quiet += 1;
                else sending += 1;
            }
            // The walk hops 1s past each boundary, so it may differ by a few seconds per window; a missed window is 40+ minutes.
            assert.ok(Math.abs(quietExtraSeconds(planFor, seconds, at) - quiet * 60) <= 60, `level ${tier.level}`);
        }
    });
});

describe('quiet windows', () => {
    const plan = { quietStart: 60, quietMinutes: 180, windows: [{ start: 60, minutes: 60 }, { start: 300, minutes: 120 }], zone: 'UTC' };
    const at = (hhmm, sec = '00') => new Date(`2026-06-01T${hhmm}:${sec}Z`);

    it('is resting exactly inside a window, start inclusive and end exclusive', () => {
        assert.ok(!inQuiet(plan, at('00:59', '59')));
        assert.ok(inQuiet(plan, at('01:00')));
        assert.ok(inQuiet(plan, at('01:59', '59')));
        assert.ok(!inQuiet(plan, at('02:00')));
        assert.ok(!inQuiet(plan, at('04:59', '59')));
        assert.ok(inQuiet(plan, at('05:00')));
        assert.ok(inQuiet(plan, at('06:59', '59')));
        assert.ok(!inQuiet(plan, at('07:00')));
    });

    it('counts down the window it is in, not the day', () => {
        assert.equal(quietLeftSeconds(plan, at('00:30')), 0);
        assert.equal(quietLeftSeconds(plan, at('01:00')), 3600);
        assert.equal(quietLeftSeconds(plan, at('01:30')), 1800);
        assert.equal(quietLeftSeconds(plan, at('01:59', '59')), 1);
        assert.equal(quietLeftSeconds(plan, at('03:00')), 0);
        assert.equal(quietLeftSeconds(plan, at('05:00')), 7200);
        assert.equal(quietLeftSeconds(plan, at('06:00')), 3600);
        assert.equal(quietLeftSeconds(plan, at('07:00')), 0);
    });

    it('reports every window and the channel clock to the UI', () => {
        const status = quietStatus(plan, at('05:30'));
        const hhmm = (ms) => new Date(ms).toISOString().slice(11, 16);
        assert.deepEqual(
            status.windows.map(({ startMinute, endMinute }) => ({ startMinute, endMinute })),
            [{ startMinute: 60, endMinute: 120 }, { startMinute: 300, endMinute: 420 }],
        );
        assert.equal(status.active, true);
        assert.equal(status.leftSeconds, 5400);
        assert.equal(status.nowMinute, 330);
        assert.equal(status.minutesToday, 180);
        assert.equal(status.startMinute, 60);
        assert.equal(quietStatus(plan, at('03:00')).active, false);
        // Absolute instants: the same windows a viewer in any zone can format.
        assert.equal(status.nowAt, at('05:30').getTime());
        assert.deepEqual(status.windows.map((w) => [hhmm(w.startAt), hhmm(w.endAt)]), [['01:00', '02:00'], ['05:00', '07:00']]);
        assert.ok(status.windows.every((w, i, all) => w.startAt < w.endAt && (i === 0 || all[i - 1].endAt < w.startAt)), 'ordered, none overlap');
        assert.ok(status.windows[1].startAt <= status.nowAt && status.nowAt < status.windows[1].endAt, 'now sits inside the open window');
    });

    it('gives a window the same instants on every call, whatever the millisecond', () => {
        const a = quietStatus(plan, new Date('2026-06-01T05:30:00.000Z')).windows;
        const b = quietStatus(plan, new Date('2026-06-01T05:30:41.789Z')).windows;
        assert.deepEqual(a.map((w) => w.startAt), b.map((w) => w.startAt));
        assert.deepEqual(a.map((w) => w.endAt), b.map((w) => w.endAt));
    });

    it('puts the window instants right when the channel zone is not UTC', () => {
        const kolkata = { ...plan, zone: 'Asia/Kolkata' };   // UTC+5:30
        const now = at('05:30');                              // 11:00 in Kolkata
        const status = quietStatus(kolkata, now);
        assert.equal(status.nowMinute, 660);
        assert.equal(status.nowAt, now.getTime());
        // 01:00 Kolkata is 19:30 UTC the day before.
        assert.equal(new Date(status.windows[0].startAt).toISOString(), '2026-05-31T19:30:00.000Z');
        assert.equal(status.windows[0].endAt - status.windows[0].startAt, 60 * 60_000);
    });
});
