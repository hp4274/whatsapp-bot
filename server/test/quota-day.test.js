/**
 * The daily budget follows the sender's own midnight and counts a message on
 * the day it LEFT, not the day a campaign queued it.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { DailyQuota, dayEnd, dayStart } from '../src/campaign/safety.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';

const IST = 'Asia/Kolkata';
const config = { ...DEFAULTS, safetyEnabled: true, transport: TRANSPORT_SANDBOX, dailyLimit: 250 };

describe('the day boundary', () => {
    it('is midnight in the sender zone, not the server zone', () => {
        const now = new Date('2026-10-17T18:40:00Z'); // 00:10 on Oct 18 in India
        assert.equal(dayStart(now, IST).toISOString(), '2026-10-17T18:30:00.000Z');
        assert.equal(dayEnd(now, IST).toISOString(), '2026-10-18T18:30:00.000Z');
        assert.equal(dayStart(new Date('2026-10-17T18:20:00Z'), IST).toISOString(), '2026-10-16T18:30:00.000Z');
    });
});

describe('the daily count', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-quota-'));
    let db;
    let scoped;
    let n = 0;
    before(() => {
        db = new Database(path.join(tmp, 'quota.db'));
        scoped = db.forTenant(1).forChannel(1);
    });
    after(() => {
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const row = (extra) => {
        n += 1;
        scoped.insert({ messageId: `q${n}`, recipient: `91980000${String(n).padStart(4, '0')}`, message: 'hi', campaignId: 'camp-1', ...extra });
        return `q${n}`;
    };

    it('counts a message queued yesterday and sent today as today', () => {
        const queued = row({ status: Status.QUEUED, createdAt: '2026-10-16T09:00:00+00:00', updatedAt: '2026-10-16T09:00:00+00:00' });
        const quota = new DailyQuota(scoped, config);
        const noon = new Date();
        const before = quota.usedToday(noon);
        scoped.updateStatus(queued, Status.SENT); // goes out now
        assert.equal(quota.usedToday(noon), before + 1);
    });

    it('resets at the sender midnight and counts the next send on the new day', () => {
        const quota = new DailyQuota(scoped, config);
        quota.zone = () => IST;
        const evening = new Date('2026-10-17T18:25:00Z');
        const after = new Date('2026-10-17T18:40:00Z');
        const [eveningBase, afterBase] = [quota.usedToday(evening), quota.usedToday(after)]; // other tests' sends
        // 23:50 Oct 17 and 00:05 Oct 18 in India (18:20Z and 18:35Z), both from a campaign queued days ago.
        row({ status: Status.SENT, createdAt: '2026-10-15T09:00:00+00:00', sentAt: '2026-10-17T18:20:00+00:00' });
        row({ status: Status.SENT, createdAt: '2026-10-15T09:00:00+00:00', sentAt: '2026-10-17T18:35:00+00:00' });
        assert.equal(quota.usedToday(evening), eveningBase + 1, 'before India midnight: the first one');
        assert.equal(quota.usedToday(after), afterBase + 1, 'after it: only the 00:05 one');
        assert.equal(quota.status(new Date('2026-10-17T18:40:00Z')).resetsAt, '2026-10-18T18:30:00.000Z');
    });

    it('a receipt later in the day does not move the send to that day', () => {
        const id = row({ status: Status.SENT, providerId: 'r1', createdAt: '2026-10-10T09:00:00+00:00', sentAt: '2026-10-10T09:05:00+00:00' });
        const quota = new DailyQuota(scoped, config);
        const day = new Date('2026-10-10T12:00:00Z');
        const used = quota.usedToday(day);
        scoped.applyReceipt('r1', Status.READ);
        assert.equal(quota.usedToday(day), used);
        assert.equal(scoped.get(id).status, Status.READ);
    });
});

describe('an older database', () => {
    it('gets sent_at and counts old sends by when they went out', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-quota-old-'));
        const file = path.join(tmp, 'old.db');
        try {
            const first = new Database(file);
            const raw = first.forTenant(1).forChannel(1).db;
            // An old file had neither the column nor the index over it.
            raw.exec('DROP INDEX idx_messages_channel_sent; ALTER TABLE messages DROP COLUMN sent_at');
            const add = raw.prepare(`INSERT INTO messages (tenant_id, channel_id, message_id, recipient, message, status, created_at, updated_at)
                                     VALUES (1, 1, ?, '919800000001', 'hi', ?, ?, ?)`);
            add.run('old-sent', 'SENT', '2026-10-16T09:00:00+00:00', '2026-10-17T02:00:00+00:00');
            add.run('old-read', 'READ', '2026-10-16T09:00:00+00:00', '2026-10-17T07:00:00+00:00');
            first.close();

            const second = new Database(file);
            const scoped = second.forTenant(1).forChannel(1);
            const rows = Object.fromEntries(scoped.db.prepare('SELECT message_id, sent_at FROM messages').all().map((r) => [r.message_id, r.sent_at]));
            assert.equal(rows['old-sent'], '2026-10-17T02:00:00+00:00', 'a SENT row went out when it was last touched');
            assert.equal(rows['old-read'], '2026-10-16T09:00:00+00:00', 'a READ row keeps its queue time: the read is not the send');
            assert.equal(scoped.countSentBetween('2026-10-17T00:00:00.000Z', '2026-10-18T00:00:00.000Z'), 1);
            second.close();
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
