/**
 * Monthly restore test (docs/OPS.md): decrypt one backup into a scratch folder,
 * open the database read-only, print each table's row count, then remove the
 * scratch copy. Every run appends one line to backups/restore-tests.log.
 *
 *   npm run restore -- <backup dir>        e.g. ~/.whatsapp_sender_web/backups/2026-10-26
 *   npm run restore -- <backup dir> --keep  leave the decrypted copy (delete it yourself)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
for (const envPath of [path.join(process.cwd(), '.env'), path.join(ROOT, '.env'), path.join(ROOT, 'server', '.env')]) {
    if (!fs.existsSync(envPath)) continue;
    try {
        process.loadEnvFile(envPath);
        break;
    } catch {
        // ignore
    }
}

// After the .env: config.js reads WHATSAPP_SENDER_HOME when it loads.
const { APP_DIR } = await import('../src/config.js');
const { restoreBackup } = await import('../src/backup.js');
const { logger } = await import('../src/observability/logger.js');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const dir = args.find((arg) => !arg.startsWith('--'));
if (!dir) {
    console.error('usage: npm run restore -- <backup dir> [--keep]');
    process.exit(2);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-restore-'));
const entry = { at: new Date().toISOString(), dir: path.resolve(dir), ok: false };
try {
    const { tables, loginFiles } = await restoreBackup(path.resolve(dir), scratch);
    Object.assign(entry, { ok: true, tables: Object.keys(tables).length, loginFiles });
    for (const [name, rows] of Object.entries(tables)) console.log(`${name.padEnd(32)} ${rows}`);
    console.log(`\n${Object.keys(tables).length} tables, ${loginFiles} login files. Restore OK.`);
    if (keep) console.log(`Decrypted copy left in ${scratch}: it holds phone numbers, delete it when done.`);
} catch (err) {
    entry.error = err.message;
    console.error(`Restore FAILED: ${err.message}`);
    process.exitCode = 1;
} finally {
    if (!keep) fs.rmSync(scratch, { recursive: true, force: true });
    logger.info('restore test', entry);
    try {
        const log = path.join(APP_DIR, 'backups', 'restore-tests.log');
        fs.mkdirSync(path.dirname(log), { recursive: true });
        fs.appendFileSync(log, `${JSON.stringify(entry)}\n`);
    } catch {
        // the log line above already recorded it
    }
}
