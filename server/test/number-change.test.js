/**
 * A new number on an existing channel starts over: its warm-up age, sending
 * tier and inbox must not inherit the previous number's history.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Channels } from '../src/channels.js';
import { Database } from '../src/db.js';
import { ConversationStore } from '../src/inbox/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-number-'));

describe('changing a channel number', () => {
    it('resets warm-up and hides the old inbox, but not for the same number reformatted', () => {
        const db = new Database(path.join(tmp, 'n.db'));
        const channels = new Channels(db.forTenant(1));
        const channel = channels.create({ displayName: 'Main', phoneNumber: '+91 98765 43210' });
        const scoped = db.forTenant(1).forChannel(channel.id);
        const inbox = new ConversationStore(scoped);

        scoped.insert({ messageId: 'old.1', recipient: '15550001', message: 'hi', status: 'SENT', createdAt: '2026-01-01T10:00:00Z' });
        const old = inbox.upsertForInbound({ phone: '15550001', at: '2026-01-01T10:05:00Z' });
        assert.equal(scoped.firstSentAt(), '2026-01-01T10:00:00Z');

        // The first scan of the same number (no country-code mismatch) is not a change.
        assert.equal(channels.update(channel.id, { providerAccountId: '919876543210' }).numberSince, null);
        assert.equal(channels.update(channel.id, { phoneNumber: '9876543210' }).numberSince, null);

        const moved = channels.update(channel.id, { providerAccountId: '917000000000' });
        assert.ok(moved.numberSince);
        assert.equal(scoped.firstSentAt(), null);
        assert.deepEqual(scoped.weeklySentCounts(), []);
        assert.equal(inbox.list().length, 0);
        assert.equal(inbox.stats().total, 0);

        // The old customer writing the new number shows up without the old thread.
        const back = inbox.upsertForInbound({ phone: '15550001' });
        assert.equal(back.id, old.id);
        assert.equal(inbox.list().length, 1);
        assert.deepEqual(inbox.thread(back.id), []);
        db.close();
    });
});
