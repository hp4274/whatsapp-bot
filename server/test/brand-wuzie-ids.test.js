/** The old brand name left the code: a database saved under it opens with its choices kept. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { Database } from '../src/db.js';

it('renames the updates column and moves role permissions to the new section name', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-brand-')), 'b.db');
    let db = new Database(file);
    // Put the database back the way the old code left it.
    db.db.exec(`ALTER TABLE tenants RENAME COLUMN wuzie_updates TO wapzo_updates;
        UPDATE tenants SET wapzo_updates = 0 WHERE id = 1;
        INSERT INTO admin_roles (name, sections, created_at, updated_at)
            VALUES ('Support', '{"wapzo":["view","send"],"tenants":["view"]}', '2026-11-01', '2026-11-01');
        DELETE FROM migrations_done WHERE name = 'brand-wuzie-ids';`);
    db.close();

    db = new Database(file);
    try {
        const row = db.db.prepare('SELECT wuzie_updates FROM tenants WHERE id = 1').get();
        assert.equal(row.wuzie_updates, 0);
        const role = db.db.prepare("SELECT sections FROM admin_roles WHERE name = 'Support'").get();
        assert.deepEqual(JSON.parse(role.sections), { wuzie: ['view', 'send'], tenants: ['view'] });
    } finally {
        db.close();
    }
});
