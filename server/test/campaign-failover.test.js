/**
 * Opt-in failover (channels.failover): a paused number's running campaign goes on from a healthy sibling, as a
 * share of the same campaign. Off, nothing moves.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-failover-'));

describe('campaign failover off a paused number', () => {
    let app;
    let server;
    let base;
    let db;
    let sup;
    let numberB;
    let numberC;

    before(async () => {
        db = new Database(path.join(tmp, 'failover.db'));
        // One send a second, so the pause lands with most of the list still waiting.
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1, rateLimitBurst: 1 };
        delete config.misc;
        app = createTestApp({ db, config });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
        sup = { authorization: `Bearer ${sessionFor(app, { role: 'super_admin' })}` };

        const settings = { transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1, rateLimitBurst: 1 };
        numberB = (await api('POST', '/api/channels', { displayName: 'B', settings })).body.channel.id;
        numberC = (await api('POST', '/api/channels', { displayName: 'C', settings })).body.channel.id;
        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        for (const id of [numberB, numberC]) {
            assert.equal((await api('POST', '/api/connection/connect', null, on(id))).status, 200);
        }
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        db?.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    async function api(method, url, body, headers = {}) {
        const res = await fetch(base + url, {
            method,
            headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    }
    const on = (id) => ({ 'x-channel-id': String(id) });
    const wait = async (check, ms = 15000) => {
        const t0 = Date.now();
        while (!(await check())) {
            if (Date.now() - t0 > ms) return false;
            await new Promise((r) => setTimeout(r, 50));
        }
        return true;
    };
    const rows = (key) => db.db.prepare('SELECT recipient, status, channel_id FROM messages WHERE campaign_id = ?').all(key);
    const failover = async (on) => assert.equal((await api('PUT', '/api/admin/policy/tenant:1',
        { values: { 'channels.failover': on } }, sup)).status, 200);
    /** Start a campaign of `n` people on `number` and pause that number once it sent its first message. */
    const startThenPause = async (number, n, name) => {
        const audience = Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `9198555008${number}${i}` }));
        const { id } = (await api('POST', '/api/campaigns', { name, body: 'Hi {name}', audience }, on(number))).body.campaign;
        assert.equal((await api('POST', `/api/campaigns/${id}/start`, {}, on(number))).status, 200);
        assert.ok(await wait(() => rows(`camp-${id}`).some((r) => r.status === 'SANDBOX')), 'the first message went out');
        assert.equal((await api('POST', `/api/admin/numbers/${number}/pause`, { reason: 'test' }, sup)).status, 200);
        return id;
    };

    it('off: the paused number keeps its campaign and nothing moves', async () => {
        await failover(false);
        const id = await startThenPause(numberC, 5, 'Stays');
        const left = rows(`camp-${id}`);
        assert.ok(left.some((r) => r.status === 'QUEUED'), 'people still waiting');
        assert.ok(left.every((r) => r.channel_id === numberC), 'every row stays on the paused number');
        const campaign = db.db.prepare('SELECT status, options FROM campaigns WHERE id = ?').get(id);
        assert.equal(campaign.status, 'running');
        assert.equal(JSON.parse(campaign.options).shares, undefined);
    });

    it('on: the unsent people go out from the sibling, the sent ones are not sent again, one campaign is listed', async () => {
        await failover(true);
        const later = (await api('POST', '/api/campaigns', { name: 'Later', body: 'Hi {name}', status: 'scheduled',
            scheduledAt: '2099-01-01T00:00:00+00:00', audience: [{ name: 'L', phone: '919855500900' }] }, on(1))).body.campaign;
        const id = await startThenPause(1, 6, 'Moves'); // number 1 (the default); C is paused, so B is the only sibling
        const campaign = (await api('GET', `/api/campaigns/${id}`, null, on(numberB))).body.campaign;
        assert.equal(campaign.options.shares.length, 1);
        const moved = campaign.options.shares[0];
        assert.equal(moved.channelId, numberB);
        const people = rows(`camp-${moved.id}`).length;
        assert.ok(people >= 1, 'someone was still waiting');
        assert.match(campaign.options.statusReason, new RegExp(`^"[^"]+" was paused; the remaining ${people} people? continues? from "B"\\.$`));
        assert.ok(db.db.prepare("SELECT 1 FROM audit_logs WHERE action = 'campaign.auto_failover' AND target = ?").get(String(id)));

        assert.ok(await wait(async () => (await api('GET', `/api/campaigns/${id}`, null, on(numberB))).body.campaign.status === 'done'),
            'the campaign finishes from the sibling');
        const stayed = rows(`camp-${id}`);
        const rest = rows(`camp-${moved.id}`);
        // The one the paused engine was holding when it stopped is closed there (CANCELLED), not moved: it may have gone out.
        assert.ok(stayed.some((r) => r.status === 'SANDBOX') && stayed.every((r) => r.channel_id === 1 && r.status !== 'QUEUED'),
            'sent before the pause: from the paused number, and nothing left waiting there');
        assert.ok(rest.every((r) => r.channel_id === numberB && r.status === 'SANDBOX'), 'the rest: sent from the sibling');
        const all = [...stayed, ...rest].map((r) => r.recipient);
        assert.equal(all.length, 6, 'one row a person');
        assert.equal(new Set(all).size, 6, 'nobody twice');

        const listed = (await api('GET', '/api/campaigns', null, on(numberB))).body.campaigns.filter((c) => c.name === 'Moves');
        assert.equal(listed.length, 1, 'one campaign, not two');
        assert.deepEqual([listed[0].status, listed[0].audienceSize, listed[0].stats.total], ['done', 6, 6]);

        // A scheduled one moves whole, still scheduled, and its own number will not start it too.
        const booked = (await api('GET', '/api/campaigns', null, on(numberB))).body.campaigns.filter((c) => c.name === 'Later');
        assert.deepEqual([booked.length, booked[0].status, booked[0].audienceSize], [1, 'scheduled', 1]);
        assert.deepEqual(booked[0].numbers.map((n) => [n.channelId, n.status]), [[1, 'done'], [numberB, 'scheduled']]);
        assert.equal(booked[0].id, later.id);
    });
});
