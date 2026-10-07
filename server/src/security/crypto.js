/**
 * Encryption at rest for channel credentials.
 *
 * AES-256-GCM from `node:crypto`, a fresh random IV per value, auth tag kept
 * with the ciphertext. A sealed value is one string:
 *
 *     enc:v1:<base64(iv || tag || ciphertext)>
 *
 * The prefix is the versioning scheme and the backward-compatibility path in
 * one: a value without it was written before encryption existed and is
 * returned as-is by `decrypt()`. That is what lets an install upgrade with
 * plaintext rows and keep working; `migrateChannelSettings()` then seals those
 * rows in place.
 *
 * Key handling. `WHATSAPP_ENCRYPTION_KEY` holds 32 bytes as 64 hex chars or
 * base64; anything else is treated as a passphrase and stretched with scrypt.
 * With no key configured the process runs plaintext and says so loudly, once.
 * Refusing to start was the alternative, and was rejected because it would
 * turn every existing install's next upgrade into an outage; the loud warning
 * plus `requireEncryptionKey()` (for a production entry point to call) is the
 * compromise. "No key" is therefore never silent.
 *
 * ponytail: single key, no rotation. Upgrade path is a key id in the prefix
 * (`enc:v1:<kid>:...`) and a map of kids to keys, decrypting with whichever
 * the value names.
 */

import crypto from 'node:crypto';

import { logger } from '../observability/logger.js';

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV = 'WHATSAPP_ENCRYPTION_KEY';

/** Settings keys that are credentials. Shared with `channels.js` for redaction. */
export const SECRET_SETTING_KEYS = Object.freeze(['accessToken', 'webhookVerifyToken', 'appSecret']);

// Cached by the raw env value, so a test that swaps the key mid-process is
// honoured without a reset hook.
let cache = { raw: undefined, key: null };
let warned = false;

function loadKey() {
    const raw = process.env[ENV] ?? '';
    if (cache.raw === raw) return cache.key;
    let key = null;
    if (raw) {
        if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
        else if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) key = Buffer.from(raw, 'base64');
        // A passphrase: stretch it. The salt is fixed because there is exactly
        // one key per install and nothing to look it up by.
        else key = crypto.scryptSync(raw, 'whatsapp-channel-settings', 32);
    }
    cache = { raw, key };
    return key;
}

export function encryptionEnabled() {
    return loadKey() !== null;
}

/** For an entry point that wants fail-closed: throws when no key is configured. */
export function requireEncryptionKey() {
    if (!encryptionEnabled()) {
        throw new Error(`${ENV} is not set; refusing to store channel credentials in plaintext`);
    }
}

export function isEncrypted(value) {
    return typeof value === 'string' && value.startsWith(PREFIX);
}

/**
 * Seal a string. Empty and non-string values pass through: there is nothing to
 * protect and the column must stay readable as "unset".
 */
export function encrypt(plain) {
    if (typeof plain !== 'string' || plain === '' || isEncrypted(plain)) return plain;
    const key = loadKey();
    if (!key) {
        if (!warned) {
            warned = true;
            logger.warn(`${ENV} is not set: channel credentials are being stored in PLAINTEXT`);
        }
        return plain;
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

/**
 * Open a sealed string. A value without the prefix predates encryption and is
 * returned unchanged. A sealed value with no key, or the wrong key, throws:
 * guessing at a credential is worse than failing.
 */
export function decrypt(blob) {
    if (!isEncrypted(blob)) return blob;
    const key = loadKey();
    if (!key) throw new Error(`${ENV} is not set but a stored credential is encrypted`);
    const raw = Buffer.from(blob.slice(PREFIX.length), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('encrypted value is truncated');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    try {
        return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    } catch {
        throw new Error(`stored credential cannot be decrypted: wrong ${ENV}, or the value is corrupt`);
    }
}

/** A settings object with its credential keys sealed, for writing to the row. */
export function sealSettings(settings) {
    const out = { ...settings };
    for (const key of SECRET_SETTING_KEYS) if (key in out) out[key] = encrypt(out[key]);
    return out;
}

/** A settings object with its credential keys opened, for use in the process. */
export function openSettings(settings) {
    const out = { ...settings };
    for (const key of SECRET_SETTING_KEYS) if (key in out) out[key] = decrypt(out[key]);
    return out;
}

/**
 * Seal every plaintext credential already in `whatsapp_channels.settings`.
 * Idempotent and a no-op without a key. Returns how many rows were rewritten.
 *
 * @param {import('node:sqlite').DatabaseSync} sqlite the raw connection (`database.db`)
 */
export function migrateChannelSettings(sqlite) {
    if (!encryptionEnabled()) return 0;
    const rows = sqlite.prepare('SELECT id, settings FROM whatsapp_channels').all();
    const update = sqlite.prepare('UPDATE whatsapp_channels SET settings = ? WHERE id = ?');
    let migrated = 0;
    for (const row of rows) {
        let settings;
        try {
            settings = JSON.parse(row.settings);
        } catch {
            continue; // unreadable settings are not ours to fix here
        }
        const needs = SECRET_SETTING_KEYS.some((key) => typeof settings[key] === 'string'
            && settings[key] !== '' && !isEncrypted(settings[key]));
        if (!needs) continue;
        update.run(JSON.stringify(sealSettings(settings)), row.id);
        migrated += 1;
    }
    if (migrated) logger.info('encrypted plaintext channel credentials', { rows: migrated });
    return migrated;
}
