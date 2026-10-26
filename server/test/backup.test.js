/** Section 4: the daily backup is encrypted, leaves no plaintext behind, keeps 7 days, and restores. */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, it } from 'node:test';

import { KEEP_DAYS, lastBackup, restoreBackup, runBackup, runBackupIfDue } from '../src/backup.js';
import { Database } from '../src/db.js';

const KEY = crypto.randomBytes(32).toString('hex');
const PHONE = '919812345678';
const savedKey = process.env.WHATSAPP_ENCRYPTION_KEY;
let dataDir;
let db;

before(() => {
    process.env.WHATSAPP_ENCRYPTION_KEY = KEY;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-backup-'));
    db = new Database(path.join(dataDir, 'messages.db'));
    db.db.prepare('INSERT INTO contacts (tenant_id, phone, name, created_at, updated_at) VALUES (1, ?, ?, ?, ?)')
        .run(PHONE, 'Asha', '2026-10-01T00:00:00+00:00', '2026-10-01T00:00:00+00:00');
    const login = path.join(dataDir, 'channels', '1', 'wwebjs_auth', 'baileys');
    fs.mkdirSync(login, { recursive: true });
    fs.writeFileSync(path.join(login, 'creds.json'), JSON.stringify({ me: { id: `${PHONE}:3@s.whatsapp.net` } }));
});
after(() => {
    db.close();
    if (savedKey === undefined) delete process.env.WHATSAPP_ENCRYPTION_KEY;
    else process.env.WHATSAPP_ENCRYPTION_KEY = savedKey;
});

/** Every file under `dir`, relative. */
const filesIn = (dir) => fs.readdirSync(dir, { recursive: true }).map(String)
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile());

it('writes an encrypted backup with no plaintext copy left anywhere, and restores it', async () => {
    const result = await runBackup({ db: db.db, dataDir, now: new Date('2026-10-26T03:00:00Z') });
    assert.equal(result.ok, true);
    assert.equal(result.loginFiles, 1);
    const root = path.join(dataDir, 'backups');
    const files = filesIn(root);
    assert.deepEqual(files.filter((f) => !f.endsWith('.enc')).sort(), ['last.json']);
    assert.ok(files.includes(path.join('2026-10-26', 'messages.db.enc')));
    for (const rel of files.filter((f) => f.endsWith('.enc'))) {
        const bytes = fs.readFileSync(path.join(root, rel));
        assert.equal(bytes.includes('SQLite format'), false, `${rel} is not a plain database`);
        assert.equal(bytes.includes(PHONE), false, `${rel} holds no readable phone number`);
    }
    assert.equal(fs.readdirSync(root).some((name) => name.startsWith('.work-')), false, 'the work folder is gone');
    assert.equal(lastBackup(dataDir).day, '2026-10-26');

    // Round trip: decrypt into a scratch folder and read it back.
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-restore-'));
    const { tables, loginFiles } = await restoreBackup(path.join(root, '2026-10-26'), scratch);
    assert.equal(tables.contacts, db.db.prepare('SELECT COUNT(*) AS n FROM contacts').get().n);
    assert.equal(tables.contacts >= 1, true);
    assert.equal(loginFiles, 1);
    const creds = path.join(scratch, 'logins', 'channels', '1', 'wwebjs_auth', 'baileys', 'creds.json');
    assert.equal(fs.readFileSync(creds, 'utf8'),
        fs.readFileSync(path.join(dataDir, 'channels', '1', 'wwebjs_auth', 'baileys', 'creds.json'), 'utf8'));
    fs.rmSync(scratch, { recursive: true, force: true });
});

it('a wrong key cannot restore it', async () => {
    process.env.WHATSAPP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-restore-'));
    try {
        await assert.rejects(restoreBackup(path.join(dataDir, 'backups', '2026-10-26'), scratch), /cannot be decrypted/);
        assert.equal(fs.existsSync(path.join(scratch, 'messages.db')), false, 'no partial plaintext left');
    } finally {
        process.env.WHATSAPP_ENCRYPTION_KEY = KEY;
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

it('keeps the newest 7 days', async () => {
    const root = path.join(dataDir, 'backups');
    for (let day = 1; day <= 9; day += 1) fs.mkdirSync(path.join(root, `2026-10-0${day}`), { recursive: true });
    await runBackup({ db: db.db, dataDir, now: new Date('2026-10-27T03:00:00Z') });
    const days = fs.readdirSync(root).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
    assert.equal(days.length, KEEP_DAYS);
    assert.equal(days.at(-1), '2026-10-27');
    assert.equal(days[0], '2026-10-05');
});

it('without a key it refuses, writes nothing, alerts once, and waits for the next day', async () => {
    delete process.env.WHATSAPP_ENCRYPTION_KEY;
    const alerts = [];
    try {
        const now = new Date('2026-10-28T03:00:00Z');
        assert.equal(await runBackupIfDue({ db: db.db, dataDir, alert: (a) => alerts.push(a), now }), null);
        assert.equal(fs.existsSync(path.join(dataDir, 'backups', '2026-10-28')), false);
        assert.equal(alerts.length, 1);
        assert.equal(alerts[0].kind, 'backup_failed');
        assert.match(alerts[0].detail, /WHATSAPP_ENCRYPTION_KEY/);
        const last = lastBackup(dataDir);
        assert.equal(last.ok, false);
        assert.equal(last.day, '2026-10-28');
        // The hourly check does not retry (or re-alert) the same day.
        await runBackupIfDue({ db: db.db, dataDir, alert: (a) => alerts.push(a), now });
        assert.equal(alerts.length, 1);
    } finally {
        process.env.WHATSAPP_ENCRYPTION_KEY = KEY;
    }
});
