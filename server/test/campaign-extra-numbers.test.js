/**
 * Typed numbers added on top of an audience: `options.extraNumbers`.
 *
 * Claims under test: a contacts audience (filter or segment-free) gains the
 * typed numbers at resolve time, without repeating anyone already in it and
 * without anyone opted out; an explicit list is left alone (the composer
 * merges typed numbers into it); bad input is refused or dropped.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CampaignStore, normalizeOptions } from '../src/campaigns/store.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-extra-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('typed numbers on top of an audience', () => {
    let db;
    let contacts;
    let store;

    before(() => {
        db = new Database(path.join(tmp, 'store.db'));
        const scoped = db.forTenant(1).forChannel(1);
        contacts = new ContactStore(scoped, '91');
        store = new CampaignStore(scoped, { contacts });
        contacts.upsert({ phone: '9876500001', name: 'VIP one', tags: ['vip'] });
        const stopped = contacts.upsert({ phone: '9876500002', name: 'Stopped' });
        contacts.setOptOut(stopped.id, true, 'asked');
    });
    after(() => db?.close());

    it('adds them to a filter audience, minus repeats, opted-out and junk', () => {
        const campaign = store.create({
            name: 'Extra', body: 'Hi {name}', audience: { tags: ['vip'] },
            options: { extraNumbers: [
                { phone: '+919876500001', name: 'Repeat' },
                { phone: '+919876500002', name: 'Opted out' },
                { phone: '+919876500003', name: 'New one' },
                { phone: 'not a number', name: 'Junk' },
            ] },
        });
        const got = store.resolveAudience(campaign).map((r) => `${r.phone} ${r.name}`).sort();
        assert.deepEqual(got, ['919876500001 VIP one', '919876500003 New one']);
    });

    it('leaves an explicit list as it is', () => {
        const campaign = store.create({
            name: 'List', body: 'Hi', audience: [{ name: 'A', phone: '919876500004' }],
            options: { extraNumbers: [{ phone: '+919876500005', name: 'B' }] },
        });
        assert.deepEqual(store.resolveAudience(campaign).map((r) => r.phone), ['919876500004']);
    });

    it('validates the option', () => {
        assert.equal(normalizeOptions({ extraNumbers: [] }).extraNumbers, null);
        assert.deepEqual(normalizeOptions({ extraNumbers: [{ phone: ' +91 98 ', name: 7 }, { phone: '' }] }).extraNumbers,
            [{ phone: '+91 98', name: '7' }]);
        assert.throws(() => normalizeOptions({ extraNumbers: 'x' }), /list of numbers/);
        assert.throws(() => normalizeOptions({ extraNumbers: Array.from({ length: 501 }, () => ({ phone: '1' })) }), /at most 500/);
    });
});
