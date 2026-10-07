/**
 * Phase 18 security: credentials sealed at rest, the webhook signed, the API
 * rate limited. The backward-compatible decrypt path is the one that matters
 * most - an upgrade must not break an install with plaintext rows.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { Channels, publicChannel } from '../src/channels.js';
import { DEFAULTS, TRANSPORT_SANDBOX, mergeConfig, publicConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { setSink } from '../src/observability/logger.js';
import {
    decrypt, encrypt, encryptionEnabled, isEncrypted, migrateChannelSettings, openSettings, sealSettings,
} from '../src/security/crypto.js';
import { rateLimit, signPayload, verifySignature } from '../src/security/signature.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-security-'));
const KEY_HEX = 'a'.repeat(64);
const OTHER_KEY_HEX = 'b'.repeat(64);
const withKey = (key) => { process.env.WHATSAPP_ENCRYPTION_KEY = key; };
const noKey = () => { delete process.env.WHATSAPP_ENCRYPTION_KEY; };

before(() => setSink(() => {})); // the plaintext warning is expected here, keep the output clean

describe('crypto', () => {
    it('round-trips with a fresh IV every time and the tag inside the blob', () => {
        withKey(KEY_HEX);
        const a = encrypt('EAAB.token');
        const b = encrypt('EAAB.token');
        assert.ok(isEncrypted(a) && isEncrypted(b));
        assert.notEqual(a, b, 'same plaintext must not produce the same ciphertext');
        assert.equal(decrypt(a), 'EAAB.token');
        assert.equal(decrypt(b), 'EAAB.token');
        // iv(12) + tag(16) + ciphertext
        assert.ok(Buffer.from(a.slice('enc:v1:'.length), 'base64').length > 28);
    });

    it('accepts a base64 key and a passphrase as well as hex', () => {
        withKey(Buffer.alloc(32, 7).toString('base64'));
        assert.equal(decrypt(encrypt('x')), 'x');
        withKey('correct horse battery staple');
        assert.equal(decrypt(encrypt('x')), 'x');
    });

    it('returns a plaintext value unchanged: the upgrade path for rows written before encryption', () => {
        withKey(KEY_HEX);
        assert.equal(decrypt('plain-old-token'), 'plain-old-token');
        assert.equal(isEncrypted('plain-old-token'), false);
        assert.equal(decrypt(''), '');
        assert.equal(decrypt(undefined), undefined);
    });

    it('refuses to guess: wrong key or no key on a sealed value throws', () => {
        withKey(KEY_HEX);
        const sealed = encrypt('secret');
        withKey(OTHER_KEY_HEX);
        assert.throws(() => decrypt(sealed), /cannot be decrypted/);
        assert.throws(() => decrypt('enc:v1:AAAA'), /truncated/);
        noKey();
        assert.throws(() => decrypt(sealed), /not set/);
    });

    it('runs plaintext without a key - loudly, never silently sealed with nothing', () => {
        noKey();
        assert.equal(encryptionEnabled(), false);
        assert.equal(encrypt('token'), 'token');
        assert.equal(isEncrypted(encrypt('token')), false);
    });

    it('does not double-encrypt and leaves empty credentials readable as unset', () => {
        withKey(KEY_HEX);
        const once = encrypt('t');
        assert.equal(encrypt(once), once);
        assert.equal(encrypt(''), '');
        const sealed = sealSettings({ accessToken: 'tok', webhookVerifyToken: '', phoneNumberId: '1' });
        assert.ok(isEncrypted(sealed.accessToken));
        assert.equal(sealed.webhookVerifyToken, '');
        assert.equal(sealed.phoneNumberId, '1', 'non-secret settings stay readable in the row');
        assert.deepEqual(openSettings(sealed), { accessToken: 'tok', webhookVerifyToken: '', phoneNumberId: '1' });
    });
});

describe('channel credentials at rest', () => {
    let db;
    before(() => { db = new Database(path.join(tmp, 'channels.db')); });
    after(() => db.close());

    it('migrates a plaintext install in place and keeps serving the same credentials', () => {
        // 1. A pre-Phase-18 install: rows written with no key.
        noKey();
        const channels = new Channels(db.forTenant(1));
        const created = channels.create({
            displayName: 'Legacy', settings: { transport: TRANSPORT_SANDBOX, accessToken: 'legacy-token', appSecret: 'shh' },
        });
        const rawBefore = db.db.prepare('SELECT settings FROM whatsapp_channels WHERE id = ?').get(created.id).settings;
        assert.match(rawBefore, /legacy-token/, 'precondition: plaintext in the row');

        // 2. Operator sets a key and restarts. Reads must work before any migration runs.
        withKey(KEY_HEX);
        assert.equal(channels.get(created.id).settings.accessToken, 'legacy-token');

        // 3. The migration seals the row; reads still give the plaintext credential.
        assert.equal(migrateChannelSettings(db.db), 1);
        assert.equal(migrateChannelSettings(db.db), 0, 'idempotent');
        const rawAfter = db.db.prepare('SELECT settings FROM whatsapp_channels WHERE id = ?').get(created.id).settings;
        assert.doesNotMatch(rawAfter, /legacy-token|shh/);
        assert.ok(isEncrypted(JSON.parse(rawAfter).accessToken));
        const after = channels.get(created.id);
        assert.equal(after.settings.accessToken, 'legacy-token');
        assert.equal(after.settings.appSecret, 'shh');

        // 4. Updates re-seal; redaction on the way out still works.
        const updated = channels.update(created.id, { settings: { accessToken: 'new-token' } });
        const rawUpdated = db.db.prepare('SELECT settings FROM whatsapp_channels WHERE id = ?').get(created.id).settings;
        assert.doesNotMatch(rawUpdated, /new-token/);
        assert.equal(updated.settings.accessToken, 'new-token');
        assert.equal(publicChannel(updated).settings.accessToken, '********');
        assert.equal(publicChannel(updated).settings.appSecret, '********');
    });

    it('never sends the app secret to the browser and keeps it on an unchanged PUT', () => {
        const config = { ...DEFAULTS, appSecret: 'shh' };
        assert.equal(publicConfig(config).appSecret, '__set__');
        assert.equal(mergeConfig(config, publicConfig(config)).appSecret, 'shh');
    });
});

describe('webhook signature', () => {
    const body = Buffer.from(JSON.stringify({ entry: [] }));

    it('verifies HMAC-SHA256 of the raw body, and only that', () => {
        const header = signPayload(body, 'app-secret');
        assert.ok(verifySignature(body, header, 'app-secret'));
        assert.equal(verifySignature(body, header, 'other'), false);
        assert.equal(verifySignature(Buffer.from('{"entry": []}'), header, 'app-secret'), false, 'reserialised body is not the signed body');
        assert.equal(verifySignature(body, 'sha256=short', 'app-secret'), false);
        assert.equal(verifySignature(body, undefined, 'app-secret'), false);
        assert.equal(verifySignature(undefined, header, 'app-secret'), false);
    });

    const startApp = async (config) => {
        const db = new Database(path.join(tmp, `wh-${Math.random().toString(36).slice(2)}.db`));
        const app = createTestApp({ db, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, ...config } });
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        const base = `http://127.0.0.1:${server.address().port}`;
        const post = (headers = {}) => fetch(`${base}/api/webhook`, {
            method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body,
        });
        const stop = async () => {
            await closeApp(app);
            await new Promise((resolve) => server.close(resolve));
            db.close();
        };
        return { post, stop };
    };

    it('rejects unsigned and mis-signed posts once an app secret is configured', async () => {
        withKey(KEY_HEX); // the secret is sealed in the row and must still verify
        const { post, stop } = await startApp({ appSecret: 'app-secret' });
        try {
            assert.equal((await post()).status, 401);
            assert.equal((await post({ 'x-hub-signature-256': signPayload(body, 'wrong') })).status, 401);
            assert.equal((await post({ 'x-hub-signature-256': signPayload(body, 'app-secret') })).status, 200);
        } finally {
            await stop();
        }
    });

    it('accepts unsigned posts when no secret is configured (documented default-open)', async () => {
        const { post, stop } = await startApp({});
        try {
            assert.equal((await post()).status, 200);
        } finally {
            await stop();
        }
    });
});

describe('API rate limit', () => {
    const run = (middleware, req) => new Promise((resolve) => {
        const res = {
            headers: {}, statusCode: 200,
            setHeader(k, v) { this.headers[k] = v; },
            status(code) { this.statusCode = code; return this; },
            json(body) { resolve({ status: this.statusCode, body, headers: this.headers }); },
        };
        middleware(req, res, () => resolve({ status: 200, next: true }));
    });

    it('keys by tenant, refuses with 429 past the burst and refills with time', async () => {
        let clock = 0;
        const limit = rateLimit({ ratePerSecond: 1, burst: 2, now: () => clock });
        const a = { user: { tenantId: 1 } };
        const b = { user: { tenantId: 2 } };
        assert.equal((await run(limit, a)).next, true);
        assert.equal((await run(limit, a)).next, true);
        const refused = await run(limit, a);
        assert.equal(refused.status, 429);
        assert.equal(refused.headers['Retry-After'], '1');
        assert.equal((await run(limit, b)).next, true, 'another tenant has its own bucket');
        clock += 1;
        assert.equal((await run(limit, a)).next, true);
    });

    it('prefers an API key over the tenant and evicts idle buckets', async () => {
        let clock = 0;
        const limit = rateLimit({ ratePerSecond: 1, burst: 1, maxKeys: 1, idleMs: 1000, now: () => clock });
        assert.equal((await run(limit, { apiKey: { id: 9 }, user: { tenantId: 1 } })).next, true);
        assert.equal((await run(limit, { user: { tenantId: 1 } })).next, true, 'tenant bucket is separate from the key bucket');
        clock += 2; // the first two buckets are now idle and get swept at the next insert
        assert.equal((await run(limit, { user: { id: 5 } })).next, true);
    });
});
