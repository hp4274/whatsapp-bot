/**
 * QR numbers linked before the plan day was read live kept 250 as their own
 * dailyLimit. Opening the database once turns that 250 into 0 (the plan's day
 * applies); other limits, the sandbox and a 250 set afterwards are left alone.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import { TRANSPORT_BAILEYS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-qr-limit-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const NOW = '2026-01-01T00:00:00+00:00';

it('sets a stored 250 to 0 on QR numbers, once', () => {
    const file = path.join(tmp, 'm.db');
    let db = new Database(file);
    let raw = db.db;
    const channel = (provider, settings) => Number(raw.prepare(
        `INSERT INTO whatsapp_channels (tenant_id, provider, display_name, settings, created_at, updated_at)
         VALUES (1, ?, ?, ?, ?, ?)`).run(provider, provider, JSON.stringify({ transport: provider, ...settings }), NOW, NOW).lastInsertRowid);
    const old = channel(TRANSPORT_BAILEYS, { dailyLimit: 250, minDelaySeconds: 30 });
    const legacy = channel('whatsapp_web', { dailyLimit: 250 });
    const own = channel(TRANSPORT_BAILEYS, { dailyLimit: 120 });
    const sandbox = channel(TRANSPORT_SANDBOX, { dailyLimit: 250 });
    // As a database from before the migration: it has not run yet.
    raw.prepare("DELETE FROM migrations_done WHERE name = 'qr-daily-limit-250-to-plan'").run();
    db.close();

    const settings = (id) => JSON.parse(raw.prepare('SELECT settings FROM whatsapp_channels WHERE id = ?').get(id).settings);
    db = new Database(file);
    raw = db.db;
    assert.deepEqual([old, legacy, own, sandbox].map((id) => settings(id).dailyLimit), [0, 0, 120, 250]);
    assert.equal(settings(old).minDelaySeconds, 30, 'the rest of the settings stay');

    // A 250 the tenant sets afterwards is a choice: the next start leaves it.
    raw.prepare("UPDATE whatsapp_channels SET settings = json_set(settings, '$.dailyLimit', 250) WHERE id = ?").run(old);
    db.close();
    db = new Database(file);
    raw = db.db;
    assert.equal(settings(old).dailyLimit, 250);
    db.close();
});
