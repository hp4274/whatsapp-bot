/**
 * Section 4 encryption safety: sealed login files (WHATSAPP_ENCRYPT_AUTH), the startup key gate, `auth:decrypt`,
 * and re-encryption after a key change, including a run that was killed half way.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, it } from 'node:test';

import { BufferJSON } from '@whiskeysockets/baileys';

import { restoreBackup, runBackup } from '../src/backup.js';
import { Database } from '../src/db.js';
import { setSink } from '../src/observability/logger.js';
import { decrypt, decryptBuffer, encrypt, encryptBuffer, fileKeyId, keyId, reencryptFile, sealedKeyId } from '../src/security/crypto.js';
import { CHECK_FILE, KeyGateError, decryptLogins, startupKeyGate } from '../src/security/keyGate.js';
import { useEncryptedAuthState } from '../src/transports/encryptedAuth.js';

const KEY_A = 'a1'.repeat(32);
const KEY_B = 'b2'.repeat(32);
const PHONE = '919812345678';
const ENV = ['WHATSAPP_ENCRYPTION_KEY', 'WHATSAPP_ENCRYPTION_KEY_PREVIOUS', 'WHATSAPP_ENCRYPT_AUTH',
    'WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED', 'NODE_ENV'];
const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const open = [];

before(() => setSink(() => {}));
afterEach(() => {
    for (const name of ENV) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
    }
});
after(() => { for (const db of open) db.close(); });

/** Set the env for one step: current key, previous key, flag on/off (flag on confirms the current key). */
function keys(current, previous = null, flag = true) {
    for (const name of ENV) delete process.env[name];
    if (current) process.env.WHATSAPP_ENCRYPTION_KEY = current;
    if (previous) process.env.WHATSAPP_ENCRYPTION_KEY_PREVIOUS = previous;
    if (flag) {
        process.env.WHATSAPP_ENCRYPT_AUTH = '1';
        process.env.WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED = keyId();
    }
}

/** A data folder with a database and one number's login folder holding plaintext Baileys files. */
function setup() {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-enc-'));
    const db = new Database(path.join(dataDir, 'messages.db'));
    open.push(db);
    const login = path.join(dataDir, 'channels', '1', 'wwebjs_auth', 'baileys');
    fs.mkdirSync(login, { recursive: true });
    const creds = { me: { id: `${PHONE}:3@s.whatsapp.net` }, noiseKey: { private: Buffer.from('noise-private') } };
    fs.writeFileSync(path.join(login, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer));
    fs.writeFileSync(path.join(login, 'pre-key-1.json'), JSON.stringify({ public: Buffer.from('pk1') }, BufferJSON.replacer));
    return { dataDir, db, login, creds };
}

const filesIn = (dir) => fs.readdirSync(dir, { recursive: true }).map(String)
    .filter((rel) => fs.statSync(path.join(dir, rel)).isFile()).sort();
const snapshot = (dir) => Object.fromEntries(filesIn(dir).map((rel) => [rel, fs.readFileSync(path.join(dir, rel)).toString('hex')]));
const alerts = () => {
    const raised = [];
    const alert = async (a) => { raised.push(a); };
    return { raised, alert };
};

/** Seal every login file in `login` under the current key, the way the server does on first read. */
async function sealLogins(login) {
    const { state } = await useEncryptedAuthState(login);
    await state.keys.get('pre-key', ['1']);
}

it('reads and writes sealed login files, and seals old plaintext ones on first read', async () => {
    const { login, creds } = setup();
    keys(KEY_A);
    const { state, saveCreds } = await useEncryptedAuthState(login);
    assert.equal(state.creds.me.id, creds.me.id);
    assert.deepEqual(state.creds.noiseKey.private, creds.noiseKey.private);
    assert.equal(fileKeyId(path.join(login, 'creds.json')).encrypted, true, 'creds.json sealed on first read');
    assert.deepEqual((await state.keys.get('pre-key', ['1']))['1'].public, Buffer.from('pk1'));
    await state.keys.set({ 'pre-key': { 2: { public: Buffer.from('pk2') }, 1: null } });
    state.creds.registered = true;
    await saveCreds();

    for (const rel of filesIn(login)) {
        const bytes = fs.readFileSync(path.join(login, rel));
        assert.equal(fileKeyId(path.join(login, rel)).encrypted, true, `${rel} is sealed`);
        assert.equal(bytes.includes(PHONE), false, `${rel} holds no readable phone number`);
    }
    assert.deepEqual(filesIn(login), ['creds.json', 'pre-key-2.json'], 'removed key gone, no temp files left');

    const again = await useEncryptedAuthState(login);
    assert.equal(again.state.creds.registered, true);
    assert.deepEqual((await again.state.keys.get('pre-key', ['2']))['2'].public, Buffer.from('pk2'));

    // A wrong key throws: it must never read as "no login" and start a fresh QR.
    keys(KEY_B);
    const before = snapshot(login);
    await assert.rejects(useEncryptedAuthState(login), /cannot be decrypted/);
    assert.deepEqual(snapshot(login), before);
});

it('flag off with encrypted login files: startup refuses', async () => {
    const { dataDir, db, login } = setup();
    keys(KEY_A);
    await sealLogins(login);
    keys(KEY_A, null, false);
    await assert.rejects(startupKeyGate({ dataDir, sqlite: db.db }), (err) => err instanceof KeyGateError && /auth:decrypt/.test(err.message));
});

it('auth:decrypt round trip: plaintext again, then the flag can go off', async () => {
    const { dataDir, db, login, creds } = setup();
    const plain = snapshot(login);
    keys(KEY_A);
    await startupKeyGate({ dataDir, sqlite: db.db });
    await sealLogins(login);
    assert.notDeepEqual(snapshot(login), plain);

    const out = await decryptLogins(dataDir);
    assert.deepEqual(out, { decrypted: 2, failed: [] });
    assert.deepEqual(snapshot(login), plain, 'byte for byte the files Baileys wrote');
    assert.equal(JSON.parse(fs.readFileSync(path.join(login, 'creds.json'), 'utf8'), BufferJSON.reviver).me.id, creds.me.id);

    keys(KEY_A, null, false);
    assert.equal((await startupKeyGate({ dataDir, sqlite: db.db })).keyId, keyId());
});

it('wrong key: startup refuses, no login is cleared, and an alert is sent', async () => {
    const { dataDir, db, login } = setup();
    keys(KEY_A);
    await startupKeyGate({ dataDir, sqlite: db.db });
    await sealLogins(login);
    const before = snapshot(dataDir);

    keys(KEY_B);
    const { raised, alert } = alerts();
    await assert.rejects(startupKeyGate({ dataDir, sqlite: db.db, alert }), KeyGateError);
    assert.equal(raised.length, 1);
    assert.equal(raised[0].kind, 'encryption_key');
    assert.deepEqual(snapshot(dataDir), before, 'every file, logins and the test value, untouched');

    // No key at all is refused the same way, and the right key gets straight back in.
    keys(null, null, false);
    await assert.rejects(startupKeyGate({ dataDir, sqlite: db.db, alert }), /not set/);
    assert.equal(raised.length, 2);
    keys(KEY_A);
    await startupKeyGate({ dataDir, sqlite: db.db, alert });
    assert.equal(raised.length, 2);
});

it('the flag will not turn on without the backup-confirmed key id', async () => {
    const { dataDir, db, login } = setup();
    keys(KEY_A);
    delete process.env.WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED;
    await assert.rejects(startupKeyGate({ dataDir, sqlite: db.db }), new RegExp(`BACKUP_CONFIRMED=${keyId()}`));
    process.env.WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED = 'deadbeef';
    await assert.rejects(startupKeyGate({ dataDir, sqlite: db.db }), KeyGateError);
    assert.equal(fs.existsSync(path.join(dataDir, CHECK_FILE)), false, 'nothing written');
    assert.equal(fileKeyId(path.join(login, 'creds.json')).encrypted, false, 'no login file sealed');
    process.env.WHATSAPP_ENCRYPTION_KEY_BACKUP_CONFIRMED = keyId();
    await startupKeyGate({ dataDir, sqlite: db.db });
});

it('production without a key refuses to start', async () => {
    const { dataDir, db } = setup();
    keys(null, null, false);
    process.env.NODE_ENV = 'production';
    const { raised, alert } = alerts();
    await assert.rejects(startupKeyGate({ dataDir, sqlite: db.db, alert }), /WHATSAPP_ENCRYPTION_KEY is not set/);
    assert.equal(raised[0].kind, 'encryption_key');
});

/** Key A's data: test value, sealed login files, a sealed setting with and one without a key id, a backup. */
async function dataUnderA() {
    const ctx = setup();
    keys(KEY_A);
    await startupKeyGate({ dataDir: ctx.dataDir, sqlite: ctx.db.db });
    await sealLogins(ctx.login);
    const legacy = encrypt('legacy-secret').replace(/^enc:v1:[0-9a-f]{8}:/, 'enc:v1:'); // sealed before key ids
    assert.equal(sealedKeyId(legacy), null);
    ctx.db.db.prepare("INSERT INTO whatsapp_channels (tenant_id, provider, display_name, settings, created_at, updated_at) VALUES (1, 'baileys', 'A', ?, ?, ?)")
        .run(JSON.stringify({ accessToken: encrypt('tok'), appSecret: legacy, transport: 'baileys' }), '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z');
    await runBackup({ db: ctx.db.db, dataDir: ctx.dataDir, now: new Date('2026-10-26T03:00:00Z') });
    return ctx;
}

const kidsOf = (dataDir) => {
    const files = filesIn(dataDir).filter((rel) => /baileys|\.enc$/.test(rel) && !rel.endsWith('last.json'));
    return Object.fromEntries(files.map((rel) => [rel, fileKeyId(path.join(dataDir, rel)).kid]));
};

it('a key change re-encrypts login files, sealed settings and backups once, and the old key can go', async () => {
    const { dataDir, db, login } = await dataUnderA();
    const kidA = keyId();
    keys(KEY_B, KEY_A);
    const { raised, alert } = alerts();
    const { reencrypted } = await startupKeyGate({ dataDir, sqlite: db.db, alert });
    assert.equal(raised.length, 0);
    assert.equal(reencrypted.failed, 0);
    assert.equal(reencrypted.files, 2);
    assert.equal(reencrypted.settings, 1);
    assert.ok(reencrypted.backups >= 3, 'database and both login copies');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, CHECK_FILE), 'utf8')).keyId, keyId());
    assert.ok(Object.values(kidsOf(dataDir)).every((kid) => kid === keyId()), 'nothing left under the old key');
    assert.notEqual(kidA, keyId());

    // Runs once: the next start finds nothing to do.
    assert.equal((await startupKeyGate({ dataDir, sqlite: db.db })).reencrypted, null);

    // The previous key is no longer needed for anything.
    keys(KEY_B);
    await startupKeyGate({ dataDir, sqlite: db.db });
    const settings = JSON.parse(db.db.prepare('SELECT settings FROM whatsapp_channels').get().settings);
    assert.equal(decrypt(settings.accessToken), 'tok');
    assert.equal(decrypt(settings.appSecret), 'legacy-secret');
    assert.equal((await useEncryptedAuthState(login)).state.creds.me.id, `${PHONE}:3@s.whatsapp.net`);
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-restore-'));
    const restored = await restoreBackup(path.join(dataDir, 'backups', '2026-10-26'), scratch);
    assert.equal(restored.loginFiles, 2);
    fs.rmSync(scratch, { recursive: true, force: true });
});

it('an interrupted re-encryption finishes on the next start, with no temp copy left', async () => {
    const { dataDir, db, login } = await dataUnderA();
    keys(KEY_B, KEY_A);
    // The killed run got as far as one file, and left a temp copy of the next one behind.
    assert.equal(await reencryptFile(path.join(login, 'creds.json')), 'reencrypted');
    fs.writeFileSync(path.join(login, 'pre-key-1.json.reenc-dead.tmp'), 'half a file');
    fs.writeFileSync(path.join(dataDir, 'backups', '2026-10-26', 'messages.db.enc.reenc-dead.tmp'), 'half a file');

    const { raised, alert } = alerts();
    const { reencrypted } = await startupKeyGate({ dataDir, sqlite: db.db, alert });
    assert.equal(raised.length, 0);
    assert.equal(reencrypted.failed, 0);
    assert.equal(filesIn(dataDir).some((rel) => rel.endsWith('.tmp')), false, 'temp copies removed');
    assert.ok(Object.values(kidsOf(dataDir)).every((kid) => kid === keyId()));
    keys(KEY_B);
    assert.deepEqual((await useEncryptedAuthState(login)).state.creds.me.id, `${PHONE}:3@s.whatsapp.net`);
});

it('a file that cannot be re-encrypted keeps its old copy, raises an alert, and is retried next start', async () => {
    const { dataDir, db, login } = await dataUnderA();
    const kidA = keyId();
    const broken = path.join(login, 'pre-key-1.json');
    const bytes = fs.readFileSync(broken);
    bytes[bytes.length - 20] ^= 0xff; // a changed byte: no key opens it
    fs.writeFileSync(broken, bytes);

    keys(KEY_B, KEY_A);
    const { raised, alert } = alerts();
    const { reencrypted } = await startupKeyGate({ dataDir, sqlite: db.db, alert });
    assert.equal(reencrypted.failed, 1);
    assert.deepEqual(raised.map((a) => a.kind), ['reencrypt_failed']);
    assert.deepEqual(fs.readFileSync(broken), bytes, 'old copy kept');
    assert.equal(fileKeyId(path.join(login, 'creds.json')).kid, keyId(), 'the rest moved on');
    const check = JSON.parse(fs.readFileSync(path.join(dataDir, CHECK_FILE), 'utf8'));
    assert.equal(check.keyId, kidA, 'test value left on the old key, so the next start tries again');
    assert.equal(check.lastReencrypt.failed, 1);
    assert.throws(() => decryptBuffer(fs.readFileSync(broken)), /cannot be decrypted/);
});

it('an upgrade that also changes the key: a failed re-encryption writes no test value, so the next start retries', async () => {
    const { dataDir, db } = await dataUnderA();
    fs.rmSync(path.join(dataDir, CHECK_FILE)); // data from before the key gate existed
    const backup = path.join(dataDir, 'backups', '2026-10-26', 'messages.db.enc');
    const bytes = fs.readFileSync(backup);
    bytes[bytes.length - 20] ^= 0xff;
    fs.writeFileSync(backup, bytes);

    keys(KEY_B, KEY_A);
    const { raised, alert } = alerts();
    const first = await startupKeyGate({ dataDir, sqlite: db.db, alert });
    assert.equal(first.reencrypted.failed, 1);
    assert.deepEqual(raised.map((a) => a.kind), ['reencrypt_failed']);
    assert.equal(fs.existsSync(path.join(dataDir, CHECK_FILE)), false, 'no test value until everything moved');
    const again = await startupKeyGate({ dataDir, sqlite: db.db, alert });
    assert.equal(again.reencrypted.failed, 1, 'tried again');
});

it('re-encryption alerts and log lines never carry a phone number from a login file name', async () => {
    const { dataDir, db, login } = await dataUnderA();
    const named = path.join(login, `session-${PHONE}.0.json`);
    const sealed = encryptBuffer(Buffer.from('{}'));
    sealed[sealed.length - 20] ^= 0xff;
    fs.writeFileSync(named, sealed);
    const lines = [];
    setSink((level, line) => lines.push(line));
    try {
        keys(KEY_B, KEY_A);
        const { raised, alert } = alerts();
        await startupKeyGate({ dataDir, sqlite: db.db, alert });
        assert.equal(raised.length, 1);
        assert.match(raised[0].text, /session-…5678/);
        assert.equal(JSON.stringify(raised).includes(PHONE), false);
        assert.equal(lines.some((line) => line.includes(PHONE)), false);
    } finally {
        setSink(() => {});
    }
});

it('values and files sealed before key ids still open', async () => {
    keys(KEY_A);
    const sealed = encrypt('x').replace(/^enc:v1:[0-9a-f]{8}:/, 'enc:v1:');
    assert.equal(decrypt(sealed), 'x');
    // WSENC1 || iv || ciphertext || tag, as written before key ids.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(KEY_A, 'hex'), iv);
    const body = Buffer.concat([cipher.update('legacy'), cipher.final()]);
    const legacy = Buffer.concat([Buffer.from('WSENC1'), iv, body, cipher.getAuthTag()]);
    assert.equal(decryptBuffer(legacy).toString(), 'legacy');
    keys(KEY_B, KEY_A);
    assert.equal(decrypt(sealed), 'x', 'tried against the previous key too');
    assert.equal(decryptBuffer(legacy).toString(), 'legacy');
});
