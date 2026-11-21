/**
 * Where numbers came from: a contact remembers the WhatsApp number it first came in through, and a business's
 * number collection keeps one entry per phone (one name, every source), with uploads kept across a fresh fetch.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { addUploaded, mergeEntries, readEntries, saveFetched } from '../src/numberCollections.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-sources-'));
const db = new Database(path.join(tmp, 'sources.db'));
after(() => {
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('contact sources', () => {
    it('keeps the first WhatsApp number a contact came in through, and filters by it', () => {
        const book = new ContactStore(db.forTenant(1), '91');
        book.upsert({ phone: '919800000001', name: 'Chat', channelId: 7, normalized: true });
        book.upsert({ phone: '919800000001', channelId: 9, normalized: true }); // a later chat on another number
        book.importMany([{ phone: '919800000002' }], { normalized: true }); // an upload
        book.importMany([{ phone: '919800000003' }], { normalized: true, channelId: 9 }); // a group import

        assert.equal(book.getByPhone('919800000001').channelId, 7, 'the first arrival names the number');
        assert.equal(book.getByPhone('919800000002').channelId, null);
        assert.deepEqual(book.find({ channel: 9 }).map((c) => c.phone), ['919800000003']);
        assert.deepEqual(book.find({ channel: 'none' }).map((c) => c.phone), ['919800000002']);
        assert.deepEqual(new Set(book.channelCounts().map((c) => `${c.channelId}:${c.count}`)), new Set(['7:1', '9:1', 'null:1']));
    });
});

describe('number collections', () => {
    it('merges by phone: one name, every source', () => {
        const merged = mergeEntries(
            [{ phone: '919800000001', name: '', from: ['919824493090'] }],
            [{ phone: '+91 98000 00001', name: 'Rahul', from: ['917600011122', 'upload'] }, { phone: '12', name: 'bad' }],
        );
        assert.deepEqual(merged, [{ phone: '919800000001', name: 'Rahul', from: ['919824493090', '917600011122', 'upload'] }]);
    });

    it('uploads join the collection; a fresh fetch replaces the fetched numbers but keeps the uploads', () => {
        const raw = db.db;
        addUploaded(raw, 5, [{ phone: '919800000009', name: 'Up' }]);
        saveFetched(raw, 5, '919824493090', [{ phone: '919800000001', name: 'A', from: ['919824493090'] }]);
        addUploaded(raw, 5, [{ phone: '919800000001', name: 'ignored, A was first' }]);
        const read = () => readEntries(raw.prepare('SELECT numbers FROM number_collections WHERE tenant_id = 5').get().numbers);
        assert.deepEqual(read(), [
            { phone: '919800000009', name: 'Up', from: ['upload'] },
            { phone: '919800000001', name: 'A', from: ['919824493090', 'upload'] },
        ]);

        saveFetched(raw, 5, '917600011122', [{ phone: '919800000002', name: 'B', from: ['917600011122'] }]);
        assert.deepEqual(read(), [
            { phone: '919800000009', name: 'Up', from: ['upload'] },
            { phone: '919800000001', name: 'A', from: ['upload'] },
            { phone: '919800000002', name: 'B', from: ['917600011122'] },
        ], 'the old WhatsApp source went with the old fetch; the upload stayed');
    });
});
