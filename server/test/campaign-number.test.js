/**
 * The list's "No." counts a business's own campaigns from 1, oldest first: another business's campaigns and a shared
 * campaign's copies never take a number, and deleting one moves the later ones down.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { CampaignStore } from '../src/campaigns/store.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';

describe('campaign numbers', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-number-'));
    const db = new Database(path.join(tmp, 'number.db'));
    after(() => {
        db.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });
    const storeFor = (tenant) => {
        const scoped = db.forTenant(tenant).forChannel(tenant);
        return new CampaignStore(scoped, { contacts: new ContactStore(scoped, '91'), canSend: () => true });
    };
    const audience = [{ name: 'A', phone: '919800000001' }];

    it('counts per business from 1, skips copies, and closes gaps after a delete', () => {
        const a = storeFor(1);
        const b = storeFor(2);
        const first = a.create({ name: 'A1', body: 'Hi', audience });
        b.create({ name: 'B1', body: 'Hi', audience }); // another business's id in between
        const second = a.create({ name: 'A2', body: 'Hi', audience });
        const copy = a.link(a.create({ name: 'A2 copy', body: 'Hi', audience }).id, { parentId: second.id });
        const third = a.create({ name: 'A3', body: 'Hi', audience });

        assert.equal(a.numberOf(first), 1);
        assert.equal(a.numberOf(second), 2);
        assert.equal(a.numberOf(a.get(copy.id)), 2, 'a copy shows its campaign’s number');
        assert.equal(a.numberOf(third), 3, 'neither the copy nor the other business counted');

        a.remove(first.id);
        assert.equal(a.numberOf(third), 2);
    });
});
