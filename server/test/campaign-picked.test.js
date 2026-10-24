/**
 * Hand-picked contacts: a campaign audience of `{ids: [...]}`.
 *
 * Claims under test: `ids` narrows find/count/idsFor to exactly those
 * contacts of this tenant (junk dropped, an empty list matches nobody); a
 * campaign with that audience resolves to them minus anyone opted out or
 * archived; and the plan's per-campaign cap applies when it is saved.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignStore } from '../src/campaigns/store.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-picked-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('hand-picked contacts', () => {
    let db;
    let contacts;
    let store;
    let ids;
    let foreign;

    before(() => {
        db = new Database(path.join(tmp, 'store.db'));
        const scoped = db.forTenant(1).forChannel(1);
        contacts = new ContactStore(scoped, '91');
        store = new CampaignStore(scoped, { contacts });
        ids = ['9876500001', '9876500002', '9876500003', '9876500004']
            .map((phone, i) => contacts.upsert({ phone, name: `C${i + 1}`, tags: i < 2 ? ['vip'] : [] }).id);
        db.db.prepare("INSERT INTO tenants (id, name, slug, status, created_at) VALUES (2, 'Other', 'other', 'active', '2026-01-01')").run();
        foreign = new ContactStore(db.forTenant(2), '91').upsert({ phone: '9876500009', name: 'Theirs' }).id;
    });
    after(() => db?.close());

    it('narrows find, count and idsFor to the picked ids of this tenant', () => {
        const picked = { ids: [ids[0], ids[2], String(ids[3]), 'x', -1, 1.5, foreign] };
        assert.deepEqual(contacts.find(picked).map((c) => c.id).sort(), [ids[0], ids[2], ids[3]].sort());
        assert.equal(contacts.count(picked), 3);
        assert.deepEqual(contacts.idsFor(picked), [ids[0], ids[2], ids[3]].sort((a, b) => a - b));
        assert.equal(contacts.count({ ids: [ids[0], ids[2]], tags: ['vip'] }), 1, 'combines with other keys');
        assert.equal(contacts.count({ ids: [] }), 0, 'an empty pick is nobody, not everybody');
        assert.equal(contacts.count({ ids: 'all' }), 0);
    });

    it('resolves a campaign audience without the opted-out or archived', () => {
        contacts.setOptOut(ids[1], true, 'asked');
        contacts.upsert({ phone: '9876500003', status: 'archived' });
        const campaign = store.create({ name: 'Picked', body: 'Hi {name}', audience: { ids } });
        const phones = store.resolveAudience(campaign).map((r) => r.phone).sort();
        assert.deepEqual(phones, ['919876500001', '919876500004']);
    });
});

describe('the plan cap', () => {
    it('refuses more hand-picked contacts than the plan allows', async () => {
        const db = new Database(path.join(tmp, 'http.db'));
        const app = createTestApp({ db });
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        try {
            app.locals.tenancy.setLimits(1, { maxContactsPerCampaign: 2 });
            const post = (audience) => fetch(`${base}/api/campaigns`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'Cap', body: 'hi', audience }),
            });
            assert.equal((await post({ ids: [1, 2, 3] })).status, 403);
            assert.equal((await post({ ids: [1, 2] })).status, 201);
        } finally {
            await closeApp(app);
            server.close();
            db.close();
        }
    });
});
