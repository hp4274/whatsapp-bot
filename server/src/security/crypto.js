/**
 * Encryption at rest for channel credentials.
 *
 * AES-256-GCM from `node:crypto`, a fresh random IV per value, auth tag kept
 * with the ciphertext. A sealed value is one string:
 *
 *     enc:v1:<key id>:<base64(iv || tag || ciphertext)>
 *
 * Values sealed before key ids existed (`enc:v1:<base64>`) still open: they
 * are tried against the current key, then the previous one.
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
 * Rotation. `WHATSAPP_ENCRYPTION_KEY_PREVIOUS` holds the key being retired.
 * Everything decrypts with whichever key its id names; `security/keyGate.js`
 * re-seals what is still under the previous key at startup.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';

import { logger } from '../observability/logger.js';

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const ENV = 'WHATSAPP_ENCRYPTION_KEY';
const ENV_PREVIOUS = 'WHATSAPP_ENCRYPTION_KEY_PREVIOUS';
const KID_LEN = 8;

/** Settings keys that are credentials. Shared with `channels.js` for redaction. */
export const SECRET_SETTING_KEYS = Object.freeze(['accessToken', 'webhookVerifyToken', 'appSecret']);

// Cached by the raw env value, so a test that swaps the key mid-process is
// honoured without a reset hook.
const cache = {};
let warned = false;

/** { id, key } from an env var, or null when it is unset. */
function loadEntry(name) {
    const raw = process.env[name] ?? '';
    if (cache[name]?.raw === raw) return cache[name].entry;
    let key = null;
    if (raw) {
        if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
        else if (/^[A-Za-z0-9+/]{43}=$/.test(raw)) key = Buffer.from(raw, 'base64');
        // A passphrase: stretch it. The salt is fixed because there is exactly
        // one key per install and nothing to look it up by.
        else key = crypto.scryptSync(raw, 'whatsapp-channel-settings', 32);
    }
    // The id names a key without revealing it: 32 bits of its SHA-256.
    const entry = key ? { id: crypto.createHash('sha256').update(key).digest('hex').slice(0, KID_LEN), key } : null;
    cache[name] = { raw, entry };
    return entry;
}

const loadKey = () => loadEntry(ENV)?.key ?? null;

/** The keys to try on a value sealed under `kid` (null: sealed before key ids, so current then previous). */
function keysFor(kid) {
    const ring = [loadEntry(ENV), loadEntry(ENV_PREVIOUS)].filter(Boolean);
    return kid ? ring.filter((entry) => entry.id === kid) : ring;
}

export function encryptionEnabled() {
    return loadKey() !== null;
}

/** The current key's id (8 hex chars), or null without a key. */
export function keyId() {
    return loadEntry(ENV)?.id ?? null;
}

/** The previous key's id, or null when `WHATSAPP_ENCRYPTION_KEY_PREVIOUS` is unset. */
export function previousKeyId() {
    return loadEntry(ENV_PREVIOUS)?.id ?? null;
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
    const entry = loadEntry(ENV);
    if (!entry) {
        if (!warned) {
            warned = true;
            logger.warn(`${ENV} is not set: channel credentials are being stored in PLAINTEXT`);
        }
        return plain;
    }
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, entry.key, iv);
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${PREFIX}${entry.id}:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')}`;
}

/** The key id a sealed value names, or null (plaintext, or sealed before key ids). Base64 has no ':'. */
export function sealedKeyId(blob) {
    if (!isEncrypted(blob)) return null;
    const rest = blob.slice(PREFIX.length);
    return rest.indexOf(':') === KID_LEN ? rest.slice(0, KID_LEN) : null;
}

/** A sealed value opened and sealed again under the current key. */
export function reseal(blob) {
    return encrypt(decrypt(blob));
}

/**
 * Open a sealed string. A value without the prefix predates encryption and is
 * returned unchanged. A sealed value with no key, or the wrong key, throws:
 * guessing at a credential is worse than failing.
 */
export function decrypt(blob) {
    if (!isEncrypted(blob)) return blob;
    if (!loadKey()) throw new Error(`${ENV} is not set but a stored credential is encrypted`);
    const kid = sealedKeyId(blob);
    const raw = Buffer.from(blob.slice(PREFIX.length + (kid ? KID_LEN + 1 : 0)), 'base64');
    if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('encrypted value is truncated');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const body = raw.subarray(IV_BYTES + TAG_BYTES);
    for (const { key } of keysFor(kid)) {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);
        try {
            return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
        } catch {
            // try the next key
        }
    }
    throw new Error(`stored credential cannot be decrypted: wrong ${ENV}, or the value is corrupt`);
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

// ------------------------------------------------------------------ files --
// A sealed file is FILE_MAGIC || key id || iv || ciphertext || tag. Streamed,
// so a large database backup never sits in memory; the tag goes last because it
// is only known once the whole file has been read. Files written before key ids
// start with LEGACY_MAGIC and have no id: they are tried against both keys.
const FILE_MAGIC = Buffer.from('WSENC2');
const LEGACY_MAGIC = Buffer.from('WSENC1');
const HEAD_BYTES = FILE_MAGIC.length + KID_LEN + IV_BYTES;

/** { kid, iv, start } of a sealed file's head, or null when `head` is not one. kid is null on a legacy file. */
function parseHead(head) {
    if (head.length >= HEAD_BYTES && head.subarray(0, FILE_MAGIC.length).equals(FILE_MAGIC)) {
        const start = FILE_MAGIC.length + KID_LEN;
        return { kid: head.subarray(FILE_MAGIC.length, start).toString('latin1'), iv: head.subarray(start, start + IV_BYTES), start: start + IV_BYTES };
    }
    if (head.length >= LEGACY_MAGIC.length + IV_BYTES && head.subarray(0, LEGACY_MAGIC.length).equals(LEGACY_MAGIC)) {
        const start = LEGACY_MAGIC.length;
        return { kid: null, iv: head.subarray(start, start + IV_BYTES), start: start + IV_BYTES };
    }
    return null;
}

function requireCurrent() {
    const entry = loadEntry(ENV);
    if (!entry) throw new Error(`${ENV} is not set; refusing to write an unencrypted copy`);
    return entry;
}

/** True when the bytes start like a sealed file. */
export function isEncryptedBuffer(buf) {
    return parseHead(buf.subarray(0, HEAD_BYTES)) !== null;
}

/** { encrypted, kid } for a file on disk. kid is null on a legacy or plaintext file. */
export function fileKeyId(file) {
    const head = Buffer.alloc(HEAD_BYTES);
    const fd = fs.openSync(file, 'r');
    let n;
    try {
        n = fs.readSync(fd, head, 0, HEAD_BYTES, 0);
    } finally {
        fs.closeSync(fd);
    }
    const parsed = parseHead(head.subarray(0, n));
    return { encrypted: parsed !== null, kid: parsed?.kid ?? null };
}

/** Seal bytes in memory, in the file format (a login file is a few KB). */
export function encryptBuffer(plain) {
    const { id, key } = requireCurrent();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([FILE_MAGIC, Buffer.from(id, 'latin1'), iv, body, cipher.getAuthTag()]);
}

/** Open bytes sealed by `encryptBuffer` or `encryptFile`. A wrong key or a changed byte throws. */
export function decryptBuffer(buf) {
    const head = parseHead(buf);
    if (!head) throw new Error('not an encrypted file');
    if (!loadKey()) throw new Error(`${ENV} is not set but the file is encrypted`);
    if (buf.length < head.start + TAG_BYTES) throw new Error('encrypted file is truncated');
    const body = buf.subarray(head.start, buf.length - TAG_BYTES);
    for (const { key } of keysFor(head.kid)) {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, head.iv);
        decipher.setAuthTag(buf.subarray(buf.length - TAG_BYTES));
        try {
            return Buffer.concat([decipher.update(body), decipher.final()]);
        } catch {
            // try the next key
        }
    }
    throw new Error(`file cannot be decrypted: wrong ${ENV}, or the file is corrupt`);
}

/** Encrypt `src` into `dest`. Throws without a key: a sealed file is never silently plaintext. */
export async function encryptFile(src, dest) {
    const { id, key } = requireCurrent();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    await pipeline(fs.createReadStream(src), cipher, async function* frame(source) {
        yield Buffer.concat([FILE_MAGIC, Buffer.from(id, 'latin1'), iv]);
        for await (const chunk of source) yield chunk;
        yield cipher.getAuthTag();
    }, fs.createWriteStream(dest, { mode: 0o600 }));
}

/** The head, tag and size of a sealed file on disk. */
function readSealed(src) {
    const size = fs.statSync(src).size;
    const head = Buffer.alloc(Math.min(HEAD_BYTES, size));
    const tag = Buffer.alloc(TAG_BYTES);
    const fd = fs.openSync(src, 'r');
    try {
        fs.readSync(fd, head, 0, head.length, 0);
        if (size >= TAG_BYTES) fs.readSync(fd, tag, 0, TAG_BYTES, size - TAG_BYTES);
    } finally {
        fs.closeSync(fd);
    }
    const parsed = parseHead(head);
    if (!parsed) throw new Error('not an encrypted file');
    if (size < parsed.start + TAG_BYTES) throw new Error('encrypted file is truncated');
    return { ...parsed, tag, size };
}

/**
 * Stream sealed `src` through a decipher, trying each key it may be under, into `dest`: plaintext, or sealed
 * again under `seal` when given (then no plaintext ever reaches the disk). `dest` is removed on every failure.
 */
async function transcode(src, dest, seal = null) {
    const sealed = readSealed(src);
    if (!loadKey()) throw new Error(`${ENV} is not set but the file is encrypted`);
    for (const { key } of keysFor(sealed.kid)) {
        const decipher = crypto.createDecipheriv(ALGORITHM, key, sealed.iv);
        decipher.setAuthTag(sealed.tag);
        const body = sealed.size - TAG_BYTES > sealed.start
            ? fs.createReadStream(src, { start: sealed.start, end: sealed.size - TAG_BYTES - 1 })
            : [Buffer.alloc(0)];
        const stages = [body, decipher];
        if (seal) {
            const iv = crypto.randomBytes(IV_BYTES);
            const cipher = crypto.createCipheriv(ALGORITHM, seal.key, iv);
            stages.push(cipher, async function* frame(source) {
                yield Buffer.concat([FILE_MAGIC, Buffer.from(seal.id, 'latin1'), iv]);
                for await (const chunk of source) yield chunk;
                yield cipher.getAuthTag();
            });
        }
        try {
            await pipeline(...stages, fs.createWriteStream(dest, { mode: 0o600 }));
            return;
        } catch {
            fs.rmSync(dest, { force: true });
        }
    }
    throw new Error(`file cannot be decrypted: wrong ${ENV}, or the file is corrupt`);
}

/** Decrypt a file written by `encryptFile`. A wrong key or a changed byte throws, and `dest` is removed. */
export async function decryptFile(src, dest) {
    await transcode(src, dest);
}

/**
 * Re-seal one file under the current key: streamed into a temp file next to it, then renamed over it, so the
 * file is always its old copy or its new one. Resolves 'plain' (not sealed: left alone), 'current' (already
 * under the current key) or 'reencrypted'. Throws, with the old copy untouched, when no key opens it.
 */
export async function reencryptFile(file) {
    const current = requireCurrent();
    const { encrypted, kid } = fileKeyId(file);
    if (!encrypted) return 'plain';
    if (kid === current.id) return 'current';
    const tmp = `${file}${REENC_TMP}${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await transcode(file, tmp, current);
        fs.renameSync(tmp, file);
    } finally {
        fs.rmSync(tmp, { force: true });
    }
    return 'reencrypted';
}

/** Marks the temp copy `reencryptFile` writes; one left by a killed process is removed on the next run. */
export const REENC_TMP = '.reenc-';
