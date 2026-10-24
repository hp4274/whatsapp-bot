/** Overlapping Connects (watchdog tick + a click) must open one socket, not two that kick each other off. */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-race-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

class FakeSock {
    ev = new EventEmitter();
    user = { id: '15550000001:7@s.whatsapp.net' };
    async end() {}
    async logout() {}
}

it('two overlapping Connects share one attempt and open one socket', async () => {
    const socks = [];
    const createSocket = async () => {
        const sock = new FakeSock();
        socks.push(sock);
        setImmediate(() => sock.ev.emit('connection.update', { connection: 'open' }));
        return sock;
    };
    const db = new Database(path.join(tmp, 'race.db'));
    const config = { ...DEFAULTS, transport: TRANSPORT_BAILEYS, safetyEnabled: false, humanTiming: false };
    delete config.misc;
    const app = createTestApp({ db, config, dataDir: tmp, deps: { sessionDir: tmp, setTimeoutFn: (fn) => setTimeout(fn, 0), createSocket } });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const connect = () => fetch(`${base}/api/connection/connect`, { method: 'POST' }).then((r) => r.json());
    try {
        assert.equal((await connect()).connected, true);
        // Another session takes the login: the transport stops, leaving a transport that is not connected.
        socks[0].ev.emit('connection.update', {
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 440, payload: { message: 'conflict' } } } },
        });

        const [a, b] = await Promise.all([connect(), connect()]);
        assert.equal(a.connected, true);
        assert.equal(b.connected, true);
        assert.equal(socks.length, 2, 'one new socket, not one per overlapping call');
    } finally {
        await closeApp(app);
        await new Promise((resolve) => server.close(resolve));
        db.close();
    }
});
