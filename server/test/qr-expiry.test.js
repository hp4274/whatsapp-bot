/** Section 4: QR codes expire after 3 unscanned, one login folder per number, and a lock on each. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { adoptRootSession } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { BaileysTransport, LOCK_FILE, QR_EXPIRED_TEXT, QR_MAX_CODES } from '../src/transports/baileys.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

function qrTransport(sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-qr-'))) {
    const socks = [];
    const options = [];
    const transport = new BaileysTransport({ ...DEFAULTS, qrTimeout: 180 }, {
        sessionDir,
        createSocket: async (opts) => {
            options.push(opts);
            const sock = { ev: new EventEmitter(), user: null, ended: false, async end() { this.ended = true; }, async logout() {} };
            socks.push(sock);
            setImmediate(() => sock.ev.emit('connection.update', { qr: 'QR-1' }));
            return sock;
        },
        setTimeoutFn: (fn) => setTimeout(fn, 0),
        randomFn: () => 0,
    });
    return { transport, socks, options, sessionDir };
}

it('stops after 3 unscanned QR codes and says "QR expired, try again"', async () => {
    const { transport, socks, options } = qrTransport();
    const states = [];
    transport.events.on('state', (s) => states.push(s));
    const info = await transport.connect();
    assert.equal(info.qr, 'QR-1');
    // qrTimeout (180s) is split between the codes: each lives 60s, and Baileys is told so.
    assert.equal(options[0].qrTimeoutMs, 60_000);
    const left = Date.parse(info.qrExpiresAt) - Date.now();
    assert.ok(left > 55_000 && left <= 60_000, `countdown ${left}ms`);
    assert.equal(transport.qrCount, 1);

    socks[0].ev.emit('connection.update', { qr: 'QR-2' });
    socks[0].ev.emit('connection.update', { qr: 'QR-3' });
    assert.equal(transport.qrCount, QR_MAX_CODES);
    assert.equal(transport.qrExpired, false);

    socks[0].ev.emit('connection.update', { qr: 'QR-4' }); // a 4th means the 3rd went unscanned
    await tick();
    assert.equal(transport.qrExpired, true);
    assert.equal(transport.qr, null);
    assert.equal(transport.qrExpiresAt, null);
    assert.equal(socks[0].ended, true, 'the socket is closed');
    assert.equal(transport.reconnectTimer, null, 'and nothing reconnects by itself');
    assert.deepEqual(states.at(-1), { state: 'qr_expired', detail: QR_EXPIRED_TEXT });

    // Connect again starts a fresh set of codes.
    const again = await transport.connect();
    assert.equal(again.qr, 'QR-1');
    assert.equal(transport.qrExpired, false);
    assert.equal(transport.qrCount, 1);
    await transport.disconnect();
});

it('a scan resets the QR count', async () => {
    const { transport, socks } = qrTransport();
    await transport.connect();
    socks[0].ev.emit('connection.update', { qr: 'QR-2' });
    socks[0].user = { id: '15550000001:7@s.whatsapp.net' };
    socks[0].ev.emit('connection.update', { connection: 'open' });
    assert.equal(transport.isConnected(), true);
    assert.equal(transport.qrCount, 0);
    assert.equal(transport.qrExpiresAt, null);
    await transport.disconnect();
});

it('locks the login folder: a live process refuses, a dead one is taken over, disconnect releases', async () => {
    const { transport, sessionDir } = qrTransport();
    const lock = path.join(sessionDir, LOCK_FILE);
    const boot = Math.round(Date.now() / 1000 - os.uptime());

    // Another live process (the test runner's parent) holds it.
    fs.writeFileSync(lock, JSON.stringify({ pid: process.ppid, boot }));
    await assert.rejects(transport.connect(), (err) => err.code === 'WHATSAPP_WEB_PROFILE_LOCKED' && /in use/.test(err.message));

    // A process that has exited left it behind.
    fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, boot }));
    await transport.connect();
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);

    await transport.disconnect();
    assert.equal(fs.existsSync(lock), false);
});

it('moves the default number login out of the shared root folder once', () => {
    const tenantDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-adopt-'));
    const root = path.join(tenantDir, 'wwebjs_auth');
    const own = path.join(tenantDir, 'channels', '1', 'wwebjs_auth');
    fs.mkdirSync(path.join(root, 'baileys'), { recursive: true });
    fs.writeFileSync(path.join(root, 'baileys', 'creds.json'), '{"me":1}');

    assert.equal(adoptRootSession(root, own), own);
    assert.equal(fs.readFileSync(path.join(own, 'baileys', 'creds.json'), 'utf8'), '{"me":1}', 'the login kept');
    assert.equal(fs.existsSync(root), false);

    // Once only: a later root folder is never merged over the number's own.
    fs.mkdirSync(path.join(root, 'baileys'), { recursive: true });
    assert.equal(adoptRootSession(root, own), own);
    assert.equal(fs.existsSync(root), true);
    assert.equal(fs.readFileSync(path.join(own, 'baileys', 'creds.json'), 'utf8'), '{"me":1}');
});
