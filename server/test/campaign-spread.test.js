/**
 * Spread sending: a date range, one shuffled list, equal daily batches,
 * refused up front when the tier's daily cap cannot cover it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';

import { dayKey, daysBetween, equalSplit, isEarlyContinue, nextDayAt, spreadPlan, todaysBatch } from '../src/campaign/spread.js';
import { CampaignStore, runningSpreadCampaigns } from '../src/campaigns/store.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';

const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const list = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `9198111${String(i).padStart(5, '0')}` }));

describe('spread helpers', () => {
    it('splits equally, larger batches first', () => {
        assert.deepEqual(equalSplit(10, 3), [4, 3, 3]);
        assert.equal(equalSplit(500, 5).every((n) => n === 100), true);
    });

    it('flags a plan the daily cap cannot cover and says how many days it needs', () => {
        const today = '2026-10-16';
        const bad = spreadPlan({ count: 1000, from: today, to: '2026-10-18', today, limit: 250 });
        assert.equal(bad.feasible, false);
        assert.equal(bad.days, 3);
        assert.equal(bad.minDays, 4);
        const ok = spreadPlan({ count: 1000, from: today, to: '2026-10-19', today, limit: 250 });
        assert.equal(ok.feasible, true);
        assert.equal(ok.perDay, 250);
        assert.equal(spreadPlan({ count: 5, from: today, to: '2026-10-10', today }).feasible, false);
    });

    it('re-divides what is left over the days that remain', () => {
        assert.equal(todaysBatch({ total: 100, cursor: 0, today: '2026-10-16', to: '2026-10-19' }), 25);
        // A missed day: 75 left, 3 days left.
        assert.equal(todaysBatch({ total: 100, cursor: 25, today: '2026-10-17', to: '2026-10-19' }), 25);
        assert.equal(todaysBatch({ total: 100, cursor: 50, today: '2026-10-19', to: '2026-10-19' }), 50);
        assert.equal(daysBetween('2026-10-16', '2026-10-19'), 3);
    });

    it('books the next day at the start time', () => {
        const at = nextDayAt(new Date('2026-10-16T12:00:00Z'), 'UTC', '09:00');
        assert.equal(at.toISOString(), '2026-10-17T09:00:00.000Z');
    });

    it('tells an early continue from a booking that is simply still today', () => {
        const now = new Date('2026-10-16T12:00:00Z');
        const args = (scheduledAt, cursor = 25) => ({ cursor, scheduledAt, now, zone: 'UTC' });
        assert.equal(isEarlyContinue(args('2026-10-17T09:00:00Z')), true);
        assert.equal(isEarlyContinue(args('2026-10-16T15:00:00Z')), false);
        assert.equal(isEarlyContinue(args('2026-10-17T09:00:00Z', 0)), false, 'nothing sent yet');
        assert.equal(isEarlyContinue(args(null)), false);
    });
});

describe('a spread campaign', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-spread-'));
    let db;
    let scoped;
    let store;
    let quotaLimit = 250;
    let budgetLeft = Infinity;
    const manager = {
        calls: [],
        campaignId: '',
        quota: { get limit() { return quotaLimit; }, remaining: () => budgetLeft },
        pausedByQuota: false,
        queue: { reset() {} },
        resetStats() {},
        enqueueContacts(contacts, template, options) {
            manager.calls.push(contacts);
            manager.campaignId = options.campaignId;
            return { queued: contacts.length, skipped: 0, campaignId: options.campaignId };
        },
        start() {},
    };

    before(() => {
        db = new Database(path.join(tmp, 'spread.db'));
        scoped = db.forTenant(1).forChannel(1);
        store = new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), manager, canSend: () => true });
    });
    after(() => {
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const make = (count, to) => store.create({
        name: 'Spread', body: 'Hi {name}', audience: list(count), status: 'scheduled',
        scheduledAt: new Date().toISOString(),
        options: { spread: { from: day(0), to, startTime: '09:00' } },
    });

    it('refuses a list the cap cannot cover', () => {
        assert.throws(() => make(1000, day(2)), (err) => err.status === 400 && /at least 4 days/.test(err.message));
    });

    it('sends one equal, shuffled slice per day and finishes after the last', () => {
        const campaign = make(100, day(3)); // 4 days -> 25 a day
        assert.equal(campaign.options.spread.total, 100);
        assert.equal(campaign.options.spread.days, 4);
        const stored = campaign.audience.map((c) => c.phone);
        assert.notDeepEqual(stored, list(100).map((c) => c.phone), 'order must not be the sheet order');

        manager.calls.length = 0;
        const seen = new Set();
        for (let d = 0; d < 4; d += 1) {
            // Pretend the days pass: the end date moves with them and the booking falls due
            // (a booking on a later day would be an early continue instead).
            const current = store.get(campaign.id);
            const spread = { ...current.options.spread, from: day(-d), to: day(3 - d) };
            scoped.db.prepare('UPDATE campaigns SET options = ?, status = ?, scheduled_at = ? WHERE id = ?')
                .run(JSON.stringify({ ...current.options, spread }), 'scheduled', new Date().toISOString(), campaign.id);
            store.start(campaign.id);
            const slice = manager.calls.at(-1);
            assert.equal(slice.length, 25);
            for (const c of slice) {
                assert.equal(seen.has(c.phone), false, 'nobody is in two slices');
                seen.add(c.phone);
            }
            // Nothing queued in the db (fake manager): force "batch out" and let stats book the next day.
            scoped.db.prepare("UPDATE messages SET status = 'SENT' WHERE campaign_id = ?").run(`camp-${campaign.id}`);
            scoped.insert({ messageId: `x${d}`, recipient: slice[0].phone, message: 'm', status: 'SENT', campaignId: `camp-${campaign.id}` });
            store.tick(campaign.id);
            assert.equal(store.get(campaign.id).status, d < 3 ? 'scheduled' : 'done');
        }
        assert.equal(seen.size, 100);
        assert.equal(runningSpreadCampaigns(scoped).some((r) => r.id === campaign.id), false);
    });

    it('will not swap the list once sending has begun', () => {
        const campaign = make(40, day(1));
        store.start(campaign.id);
        assert.throws(() => store.update(campaign.id, { audience: list(10) }), (err) => err.status === 409);
    });

    describe('continuing the next day early', () => {
        afterEach(() => { budgetLeft = Infinity; });

        const local = (offset) => dayKey(new Date(Date.now() + offset * 86_400_000));
        let drained = 0;
        const drain = (id) => {
            drained += 1;
            scoped.insert({ messageId: `early${drained}`, recipient: '9100', message: 'm', status: 'SENT', campaignId: `camp-${id}` });
            store.tick(id);
        };
        const cursorOf = (id) => store.get(id).options.spread.cursor;
        const bookFor = (id, at) => scoped.db.prepare('UPDATE campaigns SET scheduled_at = ? WHERE id = ?').run(at.toISOString(), id);

        /** 100 people over 4 days; day one (25) is out and tomorrow is booked. */
        function afterDayOne() {
            const { id } = store.create({
                name: 'Early', body: 'Hi {name}', audience: list(100), status: 'scheduled',
                scheduledAt: new Date().toISOString(),
                options: { spread: { from: local(0), to: local(3), startTime: '09:00' } },
            });
            store.start(id);
            drain(id);
            assert.equal(store.get(id).status, 'scheduled');
            assert.equal(cursorOf(id), 25);
            return id;
        }

        it("sends tomorrow's share now and moves the cursor by exactly that", () => {
            const id = afterDayOne();
            const first = manager.calls.at(-1).map((c) => c.phone);
            const result = store.start(id);
            assert.equal(result.carried, 0);
            assert.equal(manager.calls.at(-1).length, 25); // 75 left over the 3 days after today
            assert.equal(manager.calls.at(-1).some((c) => first.includes(c.phone)), false);
            assert.equal(cursorOf(id), 50);
            assert.equal(store.get(id).status, 'running');
            drain(id);
            assert.equal(store.get(id).status, 'scheduled', 'the next day is booked as before');
        });

        it("sends only what today's budget covers; the next regular start re-divides the rest", () => {
            const id = afterDayOne();
            budgetLeft = 10;
            const result = store.start(id);
            assert.equal(result.carried, 15);
            assert.equal(manager.calls.at(-1).length, 10);
            assert.equal(cursorOf(id), 35);
            drain(id);

            // A day passes: the booking is due and the range is one day shorter.
            const current = store.get(id);
            scoped.db.prepare('UPDATE campaigns SET options = ? WHERE id = ?')
                .run(JSON.stringify({ ...current.options, spread: { ...current.options.spread, to: local(2) } }), id);
            bookFor(id, new Date());
            store.start(id);
            assert.equal(manager.calls.at(-1).length, 22); // 65 left over 3 days
            assert.equal(cursorOf(id), 57);
        });

        it('refuses, queueing nothing, when today is already used up', () => {
            const id = afterDayOne();
            const calls = manager.calls.length;
            const booked = store.get(id).scheduledAt;
            budgetLeft = 0;
            assert.throws(() => store.start(id), (err) => err.status === 409 && /limit is already used.*09:00/.test(err.message));
            assert.equal(manager.calls.length, calls);
            assert.equal(cursorOf(id), 25);
            assert.equal(store.get(id).status, 'scheduled');
            assert.equal(store.get(id).scheduledAt, booked);
        });

        it('is not an early continue while the booking is still today', () => {
            const id = afterDayOne();
            bookFor(id, new Date());
            budgetLeft = 5; // a regular start leaves the cap to the manager
            const result = store.start(id);
            assert.equal(result.carried, 0);
            assert.equal(manager.calls.at(-1).length, 19); // today's share: 75 over 4 days
            assert.equal(cursorOf(id), 44);
        });
    });
});
