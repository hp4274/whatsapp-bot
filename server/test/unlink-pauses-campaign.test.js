/** A number unlinked mid-campaign: the campaign reads paused with the cause, cannot resume, and carries on after a relink. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-unlink-'));

describe('a number unlinked mid-campaign', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'unlink.db'));
        // One send every 2s: the run is still going when the number is unlinked.
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 0.5, rateLimitBurst: 1 };
        delete config.misc;
        app = createTestApp({ db, dataDir: tmp, config });
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
            headers: body ? { 'content-type': 'application/json' } : {},
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    it('pauses with the cause, refuses a resume, and carries on after a relink', async () => {
        assert.equal((await api('POST', '/api/connection/connect')).body.connected, true);
        const audience = Array.from({ length: 6 }, (_, i) => ({ name: `U${i}`, phone: `9198555011${i}` }));
        const { campaign } = (await api('POST', '/api/campaigns', { name: 'Unlinked', body: 'Hi', audience })).body;
        assert.equal((await api('POST', `/api/campaigns/${campaign.id}/start`, {})).status, 200);

        await api('POST', '/api/connection/disconnect');
        const held = (await api('GET', `/api/campaigns/${campaign.id}`)).body.campaign;
        assert.equal(held.status, 'paused');
        assert.match(held.options.statusReason, /unlinked/);
        assert.equal(db.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status = 'FAILED'").get().n, 0, 'nothing failed');

        const resume = await api('POST', `/api/campaigns/${campaign.id}/resume`, {});
        assert.equal(resume.status, 409);
        assert.match(resume.body.errors[0], /unlinked/);
        assert.equal((await api('POST', '/api/campaign/resume')).status, 409, 'the island Resume is refused too');

        assert.equal((await api('POST', '/api/connection/connect')).body.connected, true);
        const back = (await api('GET', `/api/campaigns/${campaign.id}`)).body.campaign;
        assert.equal(back.status, 'running');
        assert.equal(back.options.statusReason ?? null, null);
        assert.notEqual((await api('GET', '/api/campaign/stats')).body.stats.state, 'PAUSED');
    });
});
