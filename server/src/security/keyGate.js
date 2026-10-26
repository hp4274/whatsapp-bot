/**
 * The startup gate for the encryption key, re-encryption after a key change, and `npm run auth:decrypt`.
 *
 * Encrypted data must never be lost silently, and a key problem must never make a number re-link. So before
 * anything writes or links, `startupKeyGate` checks a known test value (`encryption-check.json` in the data
 * folder) against the current key and the previous one. If neither opens it, startup refuses and an alert is
 * sent; nothing is cleared and no QR is asked for. The only way past is the right key.
 *
 * When the test value opens only with `WHATSAPP_ENCRYPTION_KEY_PREVIOUS`, the key was changed: `reencrypt` moves
 * the login files, the sealed channel settings and the backups to the current key, each file through a temp
 * file and a rename. Anything that fails keeps its old copy (still readable with the previous key) and raises a
 * `reencrypt_failed` alert, and the test value stays on the old key so the next start tries again.
 */

import fs from 'node:fs';
import path from 'node:path';

import { loginFiles } from '../backup.js';
import { logger, maskPhone } from '../observability/logger.js';
import { writeAtomic } from '../transports/encryptedAuth.js';
import {
    REENC_TMP, SECRET_SETTING_KEYS, decrypt, decryptBuffer, encrypt, encryptionEnabled, fileKeyId, isEncrypted,
    keyId, previousKeyId, reencryptFile, requireEncryptionKey, reseal, sealedKeyId,
} from './crypto.js';

export const CHECK_FILE = 'encryption-check.json';
const CHECK_TEXT = 'whatsapp-sender key check';

/** Startup must stop. The message says what to do. */
export class KeyGateError extends Error {
    name = 'KeyGateError';
}

const readCheck = (dataDir) => {
    try {
        return JSON.parse(fs.readFileSync(path.join(dataDir, CHECK_FILE), 'utf8'));
    } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw new KeyGateError(`${CHECK_FILE} cannot be read (${err.message}); restore it, do not delete it`);
    }
};

const writeCheck = async (dataDir, extra = {}) => {
    const entry = { keyId: keyId(), value: encrypt(CHECK_TEXT), at: new Date().toISOString(), ...extra };
    await writeAtomic(path.join(dataDir, CHECK_FILE), JSON.stringify(entry, null, 2));
};

// Baileys names login files after the number (session-919876543210.0.json): mask every long digit run before a
// path or an fs error reaches a log line or an alert. maskText skips digits after '-', so it cannot do this.
const masked = (text) => String(text).replace(/\d{5,}/g, (digits) => maskPhone(digits));

// A write killed between its temp copy and the rename leaves the temp copy (the original is intact).
const isTemp = (rel) => rel.endsWith('.tmp');

/** Login files sealed by WHATSAPP_ENCRYPT_AUTH, relative to `dataDir`. */
const sealedLogins = (dataDir) => loginFiles(dataDir).filter((rel) => !isTemp(rel)).filter((rel) => {
    try {
        return fileKeyId(path.join(dataDir, rel)).encrypted;
    } catch {
        return false; // removed while we looked
    }
});

/** What the admin view shows: key ids only, never a key. */
export function encryptionStatus(dataDir) {
    let check = null;
    try {
        check = readCheck(dataDir);
    } catch { /* shown as unknown */ }
    return {
        keyId: keyId(), previousKeyId: previousKeyId(), authEncrypted: process.env.WHATSAPP_ENCRYPT_AUTH === '1',
        checkedKeyId: check?.keyId ?? null, lastReencrypt: check?.lastReencrypt ?? null,
    };
}

/**
 * Run before anything that writes or links. Throws KeyGateError when startup must stop.
 * @param {{ dataDir: string, sqlite: import('node:sqlite').DatabaseSync, alert?: (a: object) => Promise<unknown> }} opts
 * @returns {Promise<{ keyId: string|null, reencrypted: object|null }>}
 */
export async function startupKeyGate({ dataDir, sqlite, alert = async () => {} }) {
    const refuse = async (text) => {
        await alert({ kind: 'encryption_key', text });
        throw new KeyGateError(text);
    };
    if (process.env.NODE_ENV === 'production') {
        try {
            requireEncryptionKey();
        } catch (err) {
            await refuse(err.message);
        }
    }

    // The known test value: only the right key gets past, and nothing is changed before it does.
    const check = readCheck(dataDir);
    if (check) {
        if (!encryptionEnabled()) {
            await refuse(`WHATSAPP_ENCRYPTION_KEY is not set, but data here is encrypted with key ${check.keyId}.`
                + ' Set that key; nothing was changed');
        }
        let opened = false;
        try {
            opened = decrypt(check.value) === CHECK_TEXT;
        } catch { /* wrong key */ }
        if (!opened) {
            await refuse(`WHATSAPP_ENCRYPTION_KEY (id ${keyId()}${previousKeyId() ? `, previous ${previousKeyId()}` : ''})`
                + ` cannot decrypt data encrypted with key ${check.keyId}. Set the right key; nothing was changed`);
        }
    }

    // The login-file flag works one way only (docs/OPS.md).
    if (process.env.WHATSAPP_ENCRYPT_AUTH === '1') {
        if (!encryptionEnabled()) throw new KeyGateError('WHATSAPP_ENCRYPT_AUTH=1 needs WHATSAPP_ENCRYPTION_KEY');
        if (process.env.WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED !== keyId()) {
            throw new KeyGateError('WHATSAPP_ENCRYPT_AUTH=1 needs the key saved off this server first. Save'
                + ` WHATSAPP_ENCRYPTION_KEY somewhere safe, then set WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED=${keyId()}`);
        }
    } else if (sealedLogins(dataDir).length) {
        throw new KeyGateError('WhatsApp login files are encrypted but WHATSAPP_ENCRYPT_AUTH is not 1. Turn it back'
            + ' on, or run "npm run auth:decrypt" (with the key set) and then turn it off. See docs/OPS.md');
    }

    if (!check) {
        // First start: anything already sealed must open before this key is written down as the one.
        for (const row of sqlite.prepare('SELECT id, settings FROM whatsapp_channels').all()) {
            let settings = {};
            try {
                settings = JSON.parse(row.settings);
            } catch { /* not ours to fix */ }
            for (const key of SECRET_SETTING_KEYS) {
                try {
                    decrypt(settings[key]);
                } catch {
                    await refuse(`The sealed settings of channel ${row.id} do not open: missing or wrong WHATSAPP_ENCRYPTION_KEY`);
                }
            }
        }
        for (const rel of sealedLogins(dataDir)) {
            try {
                decryptBuffer(fs.readFileSync(path.join(dataDir, rel)));
            } catch {
                await refuse(`The login file ${masked(rel)} does not open: wrong WHATSAPP_ENCRYPTION_KEY`);
            }
        }
        if (!encryptionEnabled()) return { keyId: null, reencrypted: null };
        const reencrypted = previousKeyId() ? await reencrypt({ dataDir, sqlite, alert }) : null;
        if (reencrypted?.failed) return { keyId: keyId(), reencrypted }; // no test value yet: the next start retries
        await writeCheck(dataDir, reencrypted ? { lastReencrypt: reencrypted } : {});
        return { keyId: keyId(), reencrypted };
    }

    if (sealedKeyId(check.value) === keyId()) return { keyId: keyId(), reencrypted: null };

    // The key changed: move everything to the current one.
    const reencrypted = await reencrypt({ dataDir, sqlite, alert });
    if (reencrypted.failed) {
        await writeAtomic(path.join(dataDir, CHECK_FILE), JSON.stringify({ ...check, lastReencrypt: reencrypted }, null, 2));
    } else {
        await writeCheck(dataDir, { lastReencrypt: reencrypted });
    }
    return { keyId: keyId(), reencrypted };
}

/** Files under `dir`, relative, walking folders. */
function filesUnder(dir) {
    try {
        return fs.readdirSync(dir, { recursive: true }).map(String)
            .filter((rel) => fs.statSync(path.join(dir, rel)).isFile());
    } catch {
        return [];
    }
}

/**
 * Re-seal everything still under an older key with the current one: login files, sealed channel settings,
 * backups. One item at a time; a failure keeps the old copy and raises `reencrypt_failed`.
 * @returns {Promise<{ at, from, to, files, settings, backups, failed }>}
 */
export async function reencrypt({ dataDir, sqlite, alert = async () => {} }) {
    const result = { at: new Date().toISOString(), from: previousKeyId(), to: keyId(), files: 0, settings: 0, backups: 0, failed: 0 };
    const fail = async (what, err) => {
        result.failed += 1;
        const item = masked(what);
        const error = masked(err.message);
        logger.error('re-encryption failed, the old copy is kept', { item, error });
        await alert({ kind: 'reencrypt_failed', text: `Re-encrypting ${item} failed; its old copy is kept.`, detail: error });
    };
    const backupDir = path.join(dataDir, 'backups');
    const logins = loginFiles(dataDir);
    const backups = filesUnder(backupDir).filter((rel) => rel.endsWith('.enc') || rel.includes(REENC_TMP));
    for (const rel of logins.filter(isTemp)) fs.rmSync(path.join(dataDir, rel), { force: true });
    for (const rel of backups.filter(isTemp)) fs.rmSync(path.join(backupDir, rel), { force: true });

    for (const rel of logins.filter((r) => !isTemp(r))) {
        try {
            if (await reencryptFile(path.join(dataDir, rel)) === 'reencrypted') result.files += 1;
        } catch (err) {
            if (err.code !== 'ENOENT') await fail(`login file ${rel}`, err);
        }
    }

    const update = sqlite.prepare('UPDATE whatsapp_channels SET settings = ? WHERE id = ?');
    for (const row of sqlite.prepare('SELECT id, settings FROM whatsapp_channels').all()) {
        let settings;
        try {
            settings = JSON.parse(row.settings);
        } catch {
            continue;
        }
        const stale = SECRET_SETTING_KEYS.filter((key) => isEncrypted(settings[key]) && sealedKeyId(settings[key]) !== keyId());
        if (!stale.length) continue;
        try {
            for (const key of stale) settings[key] = reseal(settings[key]);
            update.run(JSON.stringify(settings), row.id); // one statement: the row is old or new, never half
            result.settings += 1;
        } catch (err) {
            await fail(`channel ${row.id} settings`, err);
        }
    }

    for (const rel of backups.filter((r) => !isTemp(r))) {
        try {
            if (await reencryptFile(path.join(backupDir, rel)) === 'reencrypted') result.backups += 1;
        } catch (err) {
            if (err.code !== 'ENOENT') await fail(`backup ${rel}`, err); // ENOENT: pruned meanwhile
        }
    }
    logger.info('re-encryption finished', result);
    return result;
}

/**
 * `npm run auth:decrypt`: turn every sealed login file back into the plaintext Baileys reads, each through a temp
 * file and a rename, so WHATSAPP_ENCRYPT_AUTH can be turned off. A file that will not decrypt is left as it is.
 * @returns {{ decrypted: number, failed: { file: string, error: string }[] }}
 */
export async function decryptLogins(dataDir) {
    const out = { decrypted: 0, failed: [] };
    for (const rel of sealedLogins(dataDir)) {
        const file = path.join(dataDir, rel);
        try {
            await writeAtomic(file, decryptBuffer(fs.readFileSync(file)));
            out.decrypted += 1;
        } catch (err) {
            out.failed.push({ file: rel, error: err.message });
        }
    }
    return out;
}

