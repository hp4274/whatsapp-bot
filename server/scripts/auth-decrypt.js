/**
 * The way back from WHATSAPP_ENCRYPT_AUTH=1 (docs/OPS.md): decrypt every WhatsApp login file in place, each
 * through a temp file and a rename, so the flag can then be turned off without any number re-linking.
 *
 *   pm2 stop whatsapp-bot
 *   npm run auth:decrypt          needs WHATSAPP_ENCRYPTION_KEY (and _PREVIOUS mid-rotation)
 *   then remove WHATSAPP_ENCRYPT_AUTH and start the server again
 */

import fs from 'node:fs';
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
const { decryptLogins } = await import('../src/security/keyGate.js');
const { logger } = await import('../src/observability/logger.js');
const { loginFiles } = await import('../src/backup.js');
const { LOCK_FILE, pidAlive } = await import('../src/transports/baileys.js');

// A running server may write a login file while we decrypt it; we would then rename the older content over it.
const held = loginFiles(APP_DIR).filter((rel) => path.basename(rel) === LOCK_FILE).filter((rel) => {
    try {
        const { pid } = JSON.parse(fs.readFileSync(path.join(APP_DIR, rel), 'utf8'));
        return pid && pid !== process.pid && pidAlive(pid);
    } catch {
        return false; // gone or unreadable: not held
    }
});
if (held.length) {
    for (const rel of held) console.error(`In use: ${path.dirname(rel)}`);
    console.error('The server is still running: stop it first (pm2 stop whatsapp-bot), then run this again.');
    process.exit(1);
}

const { decrypted, failed } = await decryptLogins(APP_DIR);
logger.info('auth:decrypt', { decrypted, failed: failed.length });
console.log(`${decrypted} login files decrypted in ${APP_DIR}.`);
for (const { file, error } of failed) console.error(`FAILED ${file}: ${error}`);
if (failed.length) {
    console.error('Some files are still encrypted: keep WHATSAPP_ENCRYPT_AUTH=1 until they decrypt.');
    process.exitCode = 1;
} else {
    console.log('Now remove WHATSAPP_ENCRYPT_AUTH (and keep the server stopped until you have).');
}
