/** Section 4: the platform's maximum API key age, and the 14-day expiry warning. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { Database } from '../src/db.js';
import { ApiKeyStore } from '../src/publicapi/keys.js';

const DAY = 86_400_000;

it('caps new keys at the max age, stops old ones past it, and flags keys expiring within 14 days', () => {
    const db = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-keys-')), 'k.db'));
    try {
        let now = Date.parse('2026-10-01T00:00:00Z');
        let maxAge = 0;
        const keys = new ApiKeyStore(db.forTenant(1), { now: () => new Date(now).toISOString(), maxAgeDays: () => maxAge });
        const forever = keys.createKey({ name: 'old', scopes: ['contacts:read'] });
        assert.equal(forever.expiresAt, null);

        maxAge = 30;
        const capped = keys.createKey({ name: 'new', scopes: ['contacts:read'] });
        assert.equal(capped.expiresAt, new Date(now + 30 * DAY).toISOString(), 'no expiry given: the max age');
        assert.throws(() => keys.createKey({ scopes: ['contacts:read'], expiresAt: new Date(now + 31 * DAY).toISOString() }),
            /within 30 days/);
        assert.equal(capped.expiringSoon, false);

        now += 20 * DAY;
        assert.equal(keys.get(capped.id).expiringSoon, true, '10 days left');
        assert.ok(keys.verify(capped.key));

        now += 11 * DAY;
        assert.equal(keys.verify(capped.key), null, 'expired');
        assert.equal(keys.verify(forever.key), null, 'a key from before the policy stops past the max age too');
        assert.equal(keys.get(capped.id).expiringSoon, false, 'expired, not expiring');
    } finally {
        db.close();
    }
});
