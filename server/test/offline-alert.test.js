/**
 * A number that should be up and stays offline past the grace: the problems log says so (once), the super admin's
 * card shows it, and the log says when it is back. Real time (the grace is 30 s), so it runs on its own.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-offline-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

it('logs a lost connection once, shows it on the business card, and logs it coming back', { timeout: 90_000 }, async () => {
    const db = new Database(path.join(tmp, 'offline.db'));
    const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX };
    delete config.misc;
    const app = createTestApp({ db, dataDir: tmp, config });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const sup = `Bearer ${sessionFor(app, { role: 'super_admin' })}`;
    const call = async (method, url, auth) => (await fetch(base + url, { method, headers: auth ? { authorization: auth } : {} })).json();
    const rows = (action) => db.db.prepare('SELECT detail FROM audit_logs WHERE action = ? ORDER BY id').all(action);
    try {
        assert.equal((await call('POST', '/api/connection/connect')).connected, true); // its owner wants it up
        const tenant = app.locals.runtimeFor(1);
        const { transport } = tenant.runtimeFor(tenant.channels.getDefault()).state;
        transport.isConnected = () => false; // the line drops and does not come back

        await new Promise((resolve) => setTimeout(resolve, 37_000));
        const offline = rows('ops.alert').map((r) => JSON.parse(r.detail)).filter((a) => a.kind === 'offline');
        assert.equal(offline.length, 1, 'once per outage');
        assert.match(offline[0].text, /Not connected for over 30 s/);
        const card = (await call('GET', '/api/admin/tenants', sup)).tenants.find((t) => t.id === 1);
        assert.ok(card.problems.some((p) => p.level === 'bad' && /is not connected/.test(p.text)), JSON.stringify(card.problems));

        delete transport.isConnected; // back
        await new Promise((resolve) => setTimeout(resolve, 6_000));
        assert.equal(rows('channel.back_online').length, 1, 'the log says it is connected again');
        const after = (await call('GET', '/api/admin/tenants', sup)).tenants.find((t) => t.id === 1);
        assert.ok(!after.problems.some((p) => /is not connected/.test(p.text)), 'the card no longer says it is down');
    } finally {
        await closeApp(app);
        server.close();
        db.close();
    }
});
