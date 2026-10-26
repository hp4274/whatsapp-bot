/**
 * Daily encrypted backup, and the restore check that proves one can be read.
 *
 *   backups/YYYY-MM-DD/messages.db.enc        the database (VACUUM INTO, then encrypted)
 *   backups/YYYY-MM-DD/logins/<path>.enc      every Baileys login file, one by one (copied as it is when
 *                                             WHATSAPP_ENCRYPT_AUTH already sealed it)
 *   backups/last.json                         the last attempt, for the admin view
 *
 * Backups hold phone numbers, so a plaintext copy is never kept: the VACUUM
 * copy lives only in a work folder that is removed whatever happens, and with
 * no `WHATSAPP_ENCRYPTION_KEY` the backup refuses instead of writing one. A day
 * is built in a work folder and renamed into place, so a half-written backup
 * never looks like a good one. The newest KEEP_DAYS days are kept.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { logger } from './observability/logger.js';
import { decryptFile, encryptFile, encryptionEnabled, fileKeyId } from './security/crypto.js';

export const KEEP_DAYS = 7;
const DB_FILE = 'messages.db.enc';
const LOGINS = 'logins';
const LAST_FILE = 'last.json';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const backupsDir = (dataDir) => path.join(dataDir, 'backups');

/** Login files relative to `dataDir`: anything under a `wwebjs_auth/baileys` folder, never inside backups. */
export function loginFiles(dataDir) {
    let names;
    try {
        names = fs.readdirSync(dataDir, { recursive: true });
    } catch {
        return [];
    }
    return names.map(String).filter((rel) => {
        const parts = rel.split(/[\\/]/);
        if (parts[0] === 'backups') return false;
        const at = parts.indexOf('wwebjs_auth');
        return at >= 0 && parts[at + 1] === 'baileys' && parts.length > at + 2;
    }).filter((rel) => {
        try {
            return fs.statSync(path.join(dataDir, rel)).isFile();
        } catch {
            return false; // removed while we walked
        }
    });
}

/** The last backup attempt ({ at, day, ok, dir, bytes, loginFiles, error }), or null before the first. */
export function lastBackup(dataDir) {
    try {
        return JSON.parse(fs.readFileSync(path.join(backupsDir(dataDir), LAST_FILE), 'utf8'));
    } catch {
        return null;
    }
}

function recordLast(dataDir, entry) {
    try {
        fs.mkdirSync(backupsDir(dataDir), { recursive: true });
        fs.writeFileSync(path.join(backupsDir(dataDir), LAST_FILE), JSON.stringify(entry, null, 2));
    } catch (err) {
        logger.warn('could not record the backup result', { error: err.message });
    }
}

/** Remove all but the newest `keep` day folders. */
function prune(root, keep = KEEP_DAYS) {
    const days = fs.readdirSync(root).filter((name) => DAY_RE.test(name)).sort();
    for (const day of days.slice(0, Math.max(0, days.length - keep))) {
        fs.rmSync(path.join(root, day), { recursive: true, force: true });
    }
}

/**
 * Back up now. Resolves to the recorded result; throws (after recording it) on failure.
 * @param {{ db: import('node:sqlite').DatabaseSync, dataDir: string, now?: Date }} opts
 */
export async function runBackup({ db, dataDir, now = new Date() }) {
    const day = now.toISOString().slice(0, 10);
    const root = backupsDir(dataDir);
    const dir = path.join(root, day);
    const work = path.join(root, `.work-${day}-${crypto.randomBytes(4).toString('hex')}`);
    const plain = path.join(work, 'messages.db.tmp');
    try {
        if (!encryptionEnabled()) {
            throw new Error('WHATSAPP_ENCRYPTION_KEY is not set: backups are never written in plaintext');
        }
        // A process killed mid-backup leaves its work folder, plaintext copy included: clear those first.
        if (fs.existsSync(root)) {
            for (const name of fs.readdirSync(root)) {
                if (name.startsWith('.work-')) fs.rmSync(path.join(root, name), { recursive: true, force: true });
            }
        }
        fs.mkdirSync(work, { recursive: true });
        db.exec(`VACUUM INTO '${plain.replace(/'/g, "''")}'`);
        await encryptFile(plain, path.join(work, DB_FILE));
        fs.rmSync(plain, { force: true });
        let logins = 0;
        for (const rel of loginFiles(dataDir)) {
            const dest = path.join(work, LOGINS, `${rel}.enc`);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            try {
                const src = path.join(dataDir, rel);
                if (fileKeyId(src).encrypted) fs.copyFileSync(src, dest); // already sealed (WHATSAPP_ENCRYPT_AUTH)
                else await encryptFile(src, dest);
                logins += 1;
            } catch (err) {
                if (err.code !== 'ENOENT') throw err; // Baileys removed it while we copied
                fs.rmSync(dest, { force: true });
            }
        }
        fs.rmSync(dir, { recursive: true, force: true });
        fs.renameSync(work, dir);
        prune(root);
        const entry = {
            at: now.toISOString(), day, ok: true, dir,
            bytes: fs.statSync(path.join(dir, DB_FILE)).size, loginFiles: logins, error: null,
        };
        recordLast(dataDir, entry);
        logger.info('backup written', { day, bytes: entry.bytes, loginFiles: logins });
        return entry;
    } catch (err) {
        recordLast(dataDir, { at: now.toISOString(), day, ok: false, dir: null, bytes: 0, loginFiles: 0, error: err.message });
        throw err;
    } finally {
        fs.rmSync(plain, { force: true });
        fs.rmSync(work, { recursive: true, force: true });
    }
}

/**
 * Once a day (UTC): back up unless today was already tried. A failure raises a `backup_failed` alert and is
 * not retried until tomorrow, so a missing key is one alert a day, not one an hour.
 */
export async function runBackupIfDue({ db, dataDir, alert = () => {}, now = new Date() }) {
    if (lastBackup(dataDir)?.day === now.toISOString().slice(0, 10)) return null;
    try {
        return await runBackup({ db, dataDir, now });
    } catch (err) {
        logger.error('backup failed', { error: err.message });
        alert({ kind: 'backup_failed', text: 'The daily backup failed.', detail: err.message });
        return null;
    }
}

/**
 * Decrypt the backup in `dir` into `scratch` and open the database read-only.
 * Resolves to { tables: { name: rows }, loginFiles }. Throws on a wrong key or a damaged file.
 */
export async function restoreBackup(dir, scratch) {
    fs.mkdirSync(scratch, { recursive: true });
    const dbFile = path.join(scratch, 'messages.db');
    await decryptFile(path.join(dir, DB_FILE), dbFile);
    let logins = 0;
    const loginRoot = path.join(dir, LOGINS);
    if (fs.existsSync(loginRoot)) {
        for (const rel of fs.readdirSync(loginRoot, { recursive: true }).map(String)) {
            const src = path.join(loginRoot, rel);
            if (!rel.endsWith('.enc') || !fs.statSync(src).isFile()) continue;
            const dest = path.join(scratch, LOGINS, rel.slice(0, -'.enc'.length));
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            await decryptFile(src, dest);
            logins += 1;
        }
    }
    const sqlite = new DatabaseSync(dbFile, { readOnly: true });
    try {
        const names = sqlite.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
        const tables = Object.fromEntries(names.map(({ name }) => [
            name, Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get().n),
        ]));
        return { tables, loginFiles: logins };
    } finally {
        sqlite.close();
    }
}
