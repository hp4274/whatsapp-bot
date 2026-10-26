/**
 * Baileys' multi-file auth state with every file sealed by `security/crypto.js` (WHATSAPP_ENCRYPT_AUTH=1).
 *
 * Same folder layout and file names as `useMultiFileAuthState`, so a folder moves between the two only through
 * the documented paths: a plaintext file is sealed the first time it is read here, and `npm run auth:decrypt`
 * goes the other way. Every write is a temp file renamed into place, so a crash leaves the old copy or the new
 * one, never half of either.
 *
 * Unlike Baileys' own reader, a file that will not decrypt throws instead of reading as missing: a missing
 * creds.json means "make a new login", and a wrong key must never turn into a fresh QR.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { decryptBuffer, encryptBuffer, isEncryptedBuffer } from '../security/crypto.js';

const locks = new Map(); // file path -> tail of its queue: one read or write per file at a time

function withLock(file, fn) {
    const run = (locks.get(file) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    locks.set(file, tail);
    void tail.then(() => { if (locks.get(file) === tail) locks.delete(file); });
    return run;
}

/** Write `bytes` to a temp file next to `file`, then rename it over `file`. */
export async function writeAtomic(file, bytes) {
    const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
        await fs.writeFile(tmp, bytes, { mode: 0o600 });
        await fs.rename(tmp, file);
    } finally {
        await fs.rm(tmp, { force: true });
    }
}

const fixFileName = (file) => file?.replace(/\//g, '__')?.replace(/:/g, '-');

export async function useEncryptedAuthState(folder) {
    const { BufferJSON, initAuthCreds, proto } = await import('@whiskeysockets/baileys');
    await fs.mkdir(folder, { recursive: true });

    const writeData = (data, file) => {
        const filePath = path.join(folder, fixFileName(file));
        return withLock(filePath, () => writeAtomic(filePath, encryptBuffer(Buffer.from(JSON.stringify(data, BufferJSON.replacer)))));
    };
    const readData = (file) => {
        const filePath = path.join(folder, fixFileName(file));
        return withLock(filePath, async () => {
            let raw;
            try {
                raw = await fs.readFile(filePath);
            } catch (err) {
                if (err.code === 'ENOENT') return null;
                throw err;
            }
            if (isEncryptedBuffer(raw)) return JSON.parse(decryptBuffer(raw).toString('utf8'), BufferJSON.reviver);
            let value;
            try {
                value = JSON.parse(raw.toString('utf8'), BufferJSON.reviver);
            } catch {
                return null; // a damaged plaintext file reads as missing, as it does in Baileys' own state
            }
            await writeAtomic(filePath, encryptBuffer(raw)); // written before the flag: seal it now
            return value;
        });
    };
    const removeData = (file) => {
        const filePath = path.join(folder, fixFileName(file));
        return withLock(filePath, () => fs.rm(filePath, { force: true }));
    };

    const creds = (await readData('creds.json')) || initAuthCreds();
    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(ids.map(async (id) => {
                        let value = await readData(`${type}-${id}.json`);
                        if (type === 'app-state-sync-key' && value) value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        data[id] = value;
                    }));
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const file = `${category}-${id}.json`;
                            tasks.push(value ? writeData(value, file) : removeData(file));
                        }
                    }
                    await Promise.all(tasks);
                },
            },
        },
        saveCreds: () => writeData(creds, 'creds.json'),
    };
}
