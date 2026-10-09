/** A number the user connected stays connected: across restarts and dropped sessions. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-reconnect-'));
const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 };
let db;

before(() => { db = new Database(path.join(tmp, 'r.db')); });
after(() => { db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const serve = async () => {
    const app = createTestApp({ db, dataDir: tmp, config });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = sessionFor(app, { role: 'owner' });
    const call = async (method, url) => (await fetch(base + url, { method, headers: { authorization: `Bearer ${token}` } })).json();
    const stop = async () => { await new Promise((resolve) => server.close(resolve)); await closeApp(app); };
    return { app, call, stop };
};

describe('keeping a connection up', () => {
    it('reconnects after a restart, and not after the user disconnected', async () => {
        const first = await serve();
        assert.equal((await first.call('POST', '/api/connection/connect')).connected, true);
        await first.stop();

        // A fresh process: nothing is connected until the reconnect pass runs.
        const second = await serve();
        assert.equal((await second.call('GET', '/api/connection')).connected, false);
        await second.app.locals.reconnectAll();
        assert.equal((await second.call('GET', '/api/connection')).connected, true, 'came back by itself');

        await second.call('POST', '/api/connection/disconnect');
        await second.stop();

        const third = await serve();
        await third.app.locals.reconnectAll();
        assert.equal((await third.call('GET', '/api/connection')).connected, false, 'a deliberate disconnect stays off');
        await third.stop();
    });
});
