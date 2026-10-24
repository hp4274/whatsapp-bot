/**
 * The progress card ("island") pauses, resumes and stops through the engine-wide
 * /api/campaign/:action routes. When the run is a saved campaign, its record must
 * follow, or the Campaigns page keeps showing "running" after a pause.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-island-'));

describe('engine-wide pause / resume / stop on a saved campaign', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'island.db'));
        // One send every 5s: the run is still going when the card acts on it.
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 0.2, rateLimitBurst: 1, tierSystem: false };
        delete config.misc;
        app = createTestApp({ db, config });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };
    const status = async (id) => (await api('GET', `/api/campaigns/${id}`)).body.campaign.status;

    it('mirrors each action on the campaign record', async () => {
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        const audience = Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, phone: `91985550000${i}` }));
        const { id } = (await api('POST', '/api/campaigns', { name: 'Island', body: 'Hi {name}', audience })).body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/start`)).status, 200);

        assert.equal((await api('POST', '/api/campaign/pause')).status, 200);
        assert.equal(await status(id), 'paused');
        assert.equal((await api('POST', '/api/campaign/resume')).status, 200);
        assert.equal(await status(id), 'running');
        assert.equal((await api('POST', '/api/campaign/stop')).status, 200);
        assert.equal(await status(id), 'cancelled');
    });
});
