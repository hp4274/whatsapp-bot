import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    contactZone, contentError, dayPlan, isDaytimeFor, seeded, shuffle, typingMs, zoneOf,
} from '../src/campaign/humanize.js';
import { MessageQueue, queueItem } from '../src/campaign/queue.js';

describe('day plan', () => {
    it('is stable within a day and differs between days', () => {
        const a = dayPlan('t:1', new Date(2026, 5, 1, 10));
        assert.deepEqual(a, dayPlan('t:1', new Date(2026, 5, 1, 23)));
        const days = new Set();
        for (let d = 1; d <= 14; d += 1) days.add(dayPlan('t:1', new Date(2026, 5, d)).gapFactor.toFixed(4));
        assert.ok(days.size > 10, 'no two days share a rhythm');
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
        if (!day || !night) return;   // the clock put every sample zone in daylight
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
        if (!isDaytimeFor(sheet[0].phone)) return;
        const { sent } = await run(sheet.slice(0, 1), { config: { humanTiming: true } });
        assert.ok(sent[0].opts.typingMs >= 2000);
    });
});
