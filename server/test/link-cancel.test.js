/** Closing the link popup calls off a link nobody scanned, and never one the phone just scanned. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-cancel-'));

/** A QR number over HTTP. Each socket shows a code until `scan()`; the socket after a scan opens as a linked phone. */
async function serve(name) {
    const db = new Database(path.join(tmp, `${name}.db`));
    const socks = [];
    let scanned = false;
    const createSocket = async () => {
        const sock = { ev: new EventEmitter(), user: scanned ? { id: '15550000001:7@s.whatsapp.net' } : null, async end() {}, async logout() {} };
        socks.push(sock);
        setImmediate(() => sock.ev.emit('connection.update', scanned ? { connection: 'open' } : { qr: 'QR-1' }));
        return sock;
    };
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, safetyEnabled: false, humanTiming: false };
    delete config.misc;
    const dataDir = fs.mkdtempSync(path.join(tmp, 'app-'));
    const app = createTestApp({ db, config, dataDir, deps: { sessionDir: dataDir, setTimeoutFn: (fn) => setTimeout(fn, 0), createSocket } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url) => (await fetch(base + url, { method })).json();
    const tenant = app.locals.runtimeFor(1);
    const { state } = tenant.runtimeFor(tenant.channels.getDefault());
    // What WhatsApp does on a scan: the code's socket closes with 515 and a new one opens with the login.
    const scan = () => {
        scanned = true;
        socks.at(-1).ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 515 } } } });
    };
    const stop = async () => {
        await new Promise((resolve) => server.close(resolve));
        await closeApp(app);
        db.close();
    };
    return { call, scan, state, stop };
}

it('a code nobody scanned is called off: Not linked again, and not kept wanted', async () => {
    const t = await serve('unscanned');
    try {
        assert.ok((await t.call('POST', '/api/connection/connect')).qr, 'a code waits for its scan');
        const off = await t.call('POST', '/api/connection/cancel');
        assert.equal(off.connected, false);
        assert.equal(off.connecting, false, 'the card reads Not linked, not Connecting');
        assert.equal(off.qr, null);
        assert.equal(t.state.config.autoConnect, false, 'no restart or outage watch brings it back');
    } finally {
        await t.stop();
    }
});

it('a scan that just landed is kept, before and after it opens', async () => {
    const t = await serve('scanned');
    try {
        await t.call('POST', '/api/connection/connect');
        t.scan(); // the 515 restart: the code is gone, the login not open yet
        const during = await t.call('POST', '/api/connection/cancel');
        assert.equal(during.qr, null);
        for (let i = 0; i < 50 && !t.state.transport?.isConnected?.(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal((await t.call('GET', '/api/connection')).connected, true, 'the close did not undo the link');
        assert.equal((await t.call('POST', '/api/connection/cancel')).connected, true, 'nor does a close once linked');
        assert.equal(t.state.config.autoConnect, true);
    } finally {
        await t.stop();
    }
});
