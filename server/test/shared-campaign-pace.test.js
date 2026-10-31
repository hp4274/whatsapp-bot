/**
 * A campaign shared over two numbers sends from both at the same time: each number paces its own share, and
 * neither waits for the other to finish.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-shared-pace-'));

describe('a campaign shared over two numbers', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'pace.db'));
        // One send every 2s per number: three each take ~4s side by side, ~10s one after the other.
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 0.5, rateLimitBurst: 1 };
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

    const api = async (method, url, body, headers = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };

    /** Both numbers' engines have nothing left to send, and the last run's record is closed. */
    const idle = async () => {
        for (let i = 0; i < 200; i++) {
            const open = db.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE status IN ('QUEUED', 'SENDING')").get().n
                + db.db.prepare("SELECT COUNT(*) AS n FROM campaigns WHERE status = 'running'").get().n;
            if (!open) return;
            await new Promise((r) => setTimeout(r, 100));
        }
    };

    it('sends from both numbers together, not one after the other', async () => {
        // "One campaign running at a time": the shared campaign is one campaign, so its second number must not wait.
        const sup = { authorization: `Bearer ${sessionFor(app, { role: 'super_admin' })}` };
        const policy = await api('PUT', '/api/admin/policy/tenant:1', { values: { 'campaigns.maxRunning': 1 } }, sup);
        assert.equal(policy.status, 200, JSON.stringify(policy.body));
        const settings = { transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 0.5, rateLimitBurst: 1 };
        const other = (await api('POST', '/api/channels', { displayName: 'B', settings })).body.channel.id;
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        assert.equal((await api('POST', '/api/connection/connect', null, { 'x-channel-id': String(other) })).status, 200);

        const audience = Array.from({ length: 6 }, (_, i) => ({ name: `P${i}`, phone: `91985550070${i}` }));
        const { id } = (await api('POST', '/api/campaigns', { name: 'Together', body: 'Hi {name}', audience })).body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/split`, { channelIds: [other] })).status, 200);
        const t0 = Date.now();
        await idle();
        const go = await api('POST', `/api/campaigns/${id}/start`, {});
        assert.equal(go.status, 200, JSON.stringify(go.body));

        // When each number's first message went out.
        const firstSend = new Map();
        while (Date.now() - t0 < 15000 && firstSend.size < 2) {
            const rows = db.db.prepare("SELECT DISTINCT channel_id FROM messages WHERE status = 'SANDBOX' AND campaign_id LIKE 'camp-%'").all();
            for (const { channel_id: ch } of rows) if (!firstSend.has(ch)) firstSend.set(ch, Date.now() - t0);
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.equal(firstSend.size, 2, 'both numbers sent');
        const [a, b] = [...firstSend.values()];
        assert.ok(Math.abs(a - b) < 1500, `both numbers start together (${a}ms vs ${b}ms)`);
    });

    it('cancelling it cancels every number: shown cancelled, nobody left waiting', async () => {
        const other = (await api('GET', '/api/channels')).body.channels.find((c) => c.displayName === 'B').id;
        const audience = Array.from({ length: 12 }, (_, i) => ({ name: `C${i}`, phone: `9198555008${String(i).padStart(2, '0')}` }));
        const { id } = (await api('POST', '/api/campaigns', { name: 'Cancel me', body: 'Hi {name}', audience })).body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/split`, { channelIds: [other] })).status, 200);
        await idle();
        const go = await api('POST', `/api/campaigns/${id}/start`, {});
        assert.equal(go.status, 200, JSON.stringify(go.body));
        await new Promise((r) => setTimeout(r, 600));
        const cancelled = await api('POST', `/api/campaigns/${id}/cancel`, {});
        assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
        await new Promise((r) => setTimeout(r, 1500));
        const report = (await api('GET', `/api/campaigns/${id}/analytics`)).body;
        assert.equal(report.campaign.status, 'cancelled');
        assert.deepEqual(report.recipients.filter((r) => ['QUEUED', 'SENDING'].includes(r.status)), [], 'nobody left waiting');
        assert.equal((await api('GET', '/api/campaigns')).body.campaigns.find((c) => c.id === id).status, 'cancelled');
    });

    it('cancelled after this number finished its share: the campaign reads cancelled, not done', async () => {
        const other = (await api('GET', '/api/channels')).body.channels.find((c) => c.displayName === 'B').id;
        const audience = Array.from({ length: 4 }, (_, i) => ({ name: `D${i}`, phone: `9198555011${i}` }));
        const { id } = (await api('POST', '/api/campaigns', { name: 'Half done', body: 'Hi {name}', audience })).body.campaign;
        const copyId = (await api('POST', `/api/campaigns/${id}/split`, { channelIds: [other] })).body.campaigns[1].id;
        await idle();
        const go = await api('POST', `/api/campaigns/${id}/start`, {});
        assert.equal(go.status, 200, JSON.stringify(go.body));
        await idle();
        // This number is done; the other number's share is still going (a slower number, or one held for the day).
        db.db.prepare("UPDATE campaigns SET status = 'running' WHERE id = ?").run(copyId);
        db.db.prepare("UPDATE messages SET status = 'QUEUED' WHERE campaign_id = ?").run(`camp-${copyId}`);
        assert.equal((await api('GET', `/api/campaigns/${id}`)).body.campaign.status, 'running', 'still sending on the other number');
        assert.equal((await api('POST', `/api/campaigns/${id}/cancel`, {})).status, 200);
        const after = (await api('GET', `/api/campaigns/${id}`)).body.campaign;
        assert.equal(after.status, 'cancelled', JSON.stringify(after.numbers));
        assert.deepEqual(db.db.prepare("SELECT status FROM messages WHERE campaign_id = ? AND status = 'QUEUED'").all(`camp-${copyId}`), [],
            'its waiting people are cancelled too');
    });

    it('the island reads a new run as sending after the last one was stopped', async () => {
        const audience = Array.from({ length: 4 }, (_, i) => ({ name: `S${i}`, phone: `9198555009${i}` }));
        const first = (await api('POST', '/api/campaigns', { name: 'Stopped', body: 'Hi', audience })).body.campaign;
        await idle();
        const go = await api('POST', `/api/campaigns/${first.id}/start`, {});
        assert.equal(go.status, 200, JSON.stringify(go.body));
        assert.equal((await api('POST', '/api/campaign/stop')).body.stats.state, 'STOPPED');
        const next = (await api('POST', '/api/campaigns', { name: 'Next', body: 'Hi', audience })).body.campaign;
        const started = await api('POST', `/api/campaigns/${next.id}/start`, {});
        assert.equal(started.status, 200, JSON.stringify(started.body));
        const island = (await api('GET', '/api/campaign/stats')).body.stats;
        assert.notEqual(island.state, 'STOPPED');
    });
});
