/**
 * A campaign whose number cannot send (not connected, unlinked, banned, paused, deleted, a different phone linked):
 * it says why, nothing fails, its owner hears about it, and it carries on (or can be moved or stopped) when it can.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { HOLD } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-holds-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// One send every 2 s: a run is still going when its number drops.
const CONFIG = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 0.5, rateLimitBurst: 1 };
delete CONFIG.misc;

const serve = async (db) => {
    const app = createTestApp({ db, dataDir: tmp, config: CONFIG });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (method, url, body, headers = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
            body: body ? JSON.stringify(body) : undefined,
        });
        return { status: res.status, body: await res.json() };
    };
    /** A number's live runtime state, its owner notices caught instead of sent. */
    const stateOf = (channelId = null) => {
        const tenant = app.locals.runtimeFor(1);
        const state = tenant.runtimeFor(channelId ? tenant.channels.get(channelId) : tenant.channels.getDefault()).state;
        state.notices ??= [];
        state.notifyOwner = (kind, vars) => state.notices.push({ kind, ...vars });
        return state;
    };
    const stop = async () => {
        await closeApp(app);
        await new Promise((resolve) => server.close(resolve));
    };
    return { app, api, stateOf, stop };
};

const waitFor = async (check, ms = 10000) => {
    const t0 = Date.now();
    while (!(await check())) {
        if (Date.now() - t0 > ms) return false;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return true;
};

describe('a campaign whose number cannot send', () => {
    let db;
    let s;
    let sup;
    let numberB;
    const on = (id) => ({ 'x-channel-id': String(id) });
    const rows = (id, status) => db.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND status = ?')
        .get(`camp-${id}`, status).n;
    const campaignOf = (id) => {
        const row = db.db.prepare('SELECT status, options FROM campaigns WHERE id = ?').get(id);
        return { status: row.status, options: JSON.parse(row.options || '{}') };
    };
    /** The platform's problems log ("Problems only" on the audit page). */
    const alerts = () => db.db.prepare("SELECT detail FROM audit_logs WHERE action = 'ops.alert' ORDER BY id")
        .all().map((r) => JSON.parse(r.detail));
    const people = (prefix, n) => Array.from({ length: n }, (_, i) => ({ name: `${prefix}${i}`, phone: `91985${prefix}${String(i).padStart(5, '0')}` }));
    const startOn = async (number, name, n, prefix) => {
        const { campaign } = (await s.api('POST', '/api/campaigns', { name, body: 'Hi', audience: people(prefix, n) }, on(number))).body;
        assert.equal((await s.api('POST', `/api/campaigns/${campaign.id}/start`, {}, on(number))).status, 200);
        assert.ok(await waitFor(() => rows(campaign.id, 'SANDBOX') > 0), 'its first message went out');
        return campaign.id;
    };

    before(async () => {
        db = new Database(path.join(tmp, 'holds.db'));
        s = await serve(db);
        sup = { authorization: `Bearer ${sessionFor(s.app, { role: 'super_admin' })}` };
        numberB = (await s.api('POST', '/api/channels', { displayName: 'B', settings: { transport: TRANSPORT_SANDBOX } })).body.channel.id;
        assert.equal((await s.api('POST', '/api/connection/connect')).status, 200);
        assert.equal((await s.api('POST', '/api/connection/connect', null, on(numberB))).status, 200);
    });
    after(async () => {
        await s.stop();
        db.close();
    });

    it('Resume is refused while its number is not connected, and nothing fails', async () => {
        const id = await startOn(1, 'Refused', 12, '1');
        assert.equal((await s.api('POST', `/api/campaigns/${id}/pause`, {})).status, 200);
        await s.api('POST', '/api/connection/disconnect');
        const resume = await s.api('POST', `/api/campaigns/${id}/resume`, {});
        assert.equal(resume.status, 409);
        assert.match(resume.body.errors[0], /not connected/);
        assert.equal((await s.api('POST', '/api/campaign/resume')).status, 409, 'nor through the island');
        await new Promise((resolve) => setTimeout(resolve, 600));
        assert.equal(rows(id, 'FAILED'), 0, 'nothing failed');
        assert.equal(campaignOf(id).status, 'paused');

        assert.equal((await s.api('POST', '/api/connection/connect')).status, 200);
        assert.equal((await s.api('POST', `/api/campaigns/${id}/resume`, {})).status, 200);
        assert.equal(campaignOf(id).status, 'running');
        await s.api('POST', `/api/campaigns/${id}/cancel`, {});
    });

    it('a paused number holds its campaigns: they say why, can still be stopped, or moved to another number', async () => {
        const moved = await startOn(numberB, 'Moved', 8, '2');
        const stopped = (await s.api('POST', '/api/campaigns', { name: 'Stopped', body: 'Hi', audience: people('3', 4) }, on(numberB))).body.campaign.id;
        assert.equal((await s.api('POST', `/api/campaigns/${stopped}/start`, {}, on(numberB))).status, 200);
        assert.equal((await s.api('POST', `/api/admin/numbers/${numberB}/pause`, { reason: 'Too many reports' }, sup)).status, 200);

        for (const id of [moved, stopped]) {
            const held = campaignOf(id);
            assert.equal(held.status, 'paused', 'no longer reads Running');
            assert.match(held.options.statusReason, /on hold for now/);
            assert.doesNotMatch(held.options.statusReason, /ban|block|restrict|report/i, 'calm words for the business');
            assert.equal(held.options.linkHold, true);
        }
        const resume = await s.api('POST', `/api/campaigns/${moved}/resume`, {});
        assert.equal(resume.status, 409);
        assert.match(resume.body.errors[0], /paused or was removed/);

        // The super admin's card for the business carries the error sign, saying what is wrong.
        const card = (await s.api('GET', '/api/admin/tenants', null, sup)).body.tenants.find((t) => t.id === 1);
        assert.ok(card.problems.some((p) => p.level === 'bad' && /B was paused: Too many reports/.test(p.text)), JSON.stringify(card.problems));
        assert.ok(card.problems.some((p) => /2 campaigns waiting for its number/.test(p.text)), JSON.stringify(card.problems));

        // Stopped from the business's own pages, though its number is paused.
        const cancel = await s.api('POST', `/api/campaigns/${stopped}/cancel`, {});
        assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
        assert.equal(campaignOf(stopped).status, 'cancelled');
        assert.equal(rows(stopped, 'QUEUED'), 0, 'nobody left waiting');

        // The rest of the other goes from the main number, as one campaign.
        const waiting = rows(moved, 'QUEUED');
        assert.ok(waiting > 0);
        const move = await s.api('POST', `/api/campaigns/${moved}/move`, { channelId: 1 });
        assert.equal(move.status, 200, JSON.stringify(move.body));
        assert.equal(move.body.people, waiting);
        assert.equal(move.body.campaign.status, 'running');
        const copy = move.body.campaign.numbers.find((n) => n.channelId === 1);
        assert.ok(copy, 'the main number now sends a share');
        assert.ok(await waitFor(() => rows(copy.id, 'SANDBOX') > 0), 'and its first message went out');
        assert.equal(rows(moved, 'QUEUED'), 0, 'nothing stays on the paused number');
        assert.equal((await s.api('POST', `/api/campaigns/${moved}/move`, { channelId: numberB })).status, 409, 'not onto a paused number');

        assert.equal((await s.api('POST', `/api/admin/numbers/${numberB}/resume`, null, sup)).status, 200);
        await s.api('POST', '/api/connection/connect', null, on(numberB));
        await s.api('POST', `/api/campaigns/${moved}/cancel`, {});
    });

    it('a number with campaigns on it cannot be deleted', async () => {
        const { campaign } = (await s.api('POST', '/api/campaigns', {
            name: 'Later', body: 'Hi', status: 'scheduled', scheduledAt: '2099-01-01T00:00:00+00:00', audience: people('4', 2),
        }, on(numberB))).body;
        const refused = await s.api('DELETE', `/api/channels/${numberB}`);
        assert.equal(refused.status, 409);
        assert.match(refused.body.errors[0], /"Later"/);
        await s.api('POST', `/api/campaigns/${campaign.id}/cancel`, {});
        assert.equal((await s.api('DELETE', `/api/channels/${numberB}`)).status, 200);
    });

    it('a different phone linked keeps held campaigns paused for their owner, who is told', async () => {
        const state = s.stateOf();
        state.transport.events.emit('ready', { account: '919811100001', connected: true });
        const id = await startOn(1, 'Phone', 12, '5');
        state.transport.events.emit('state', { state: 'auth_failure', detail: 'removed from the phone' });
        assert.equal(campaignOf(id).status, 'paused');
        assert.equal(campaignOf(id).options.statusReason, HOLD.unlinked);
        assert.equal(state.notices.at(-1)?.kind, 'number_down', 'its owner hears it from Wuzie');
        assert.ok(alerts().some((a) => a.kind === 'logout'), 'and it is in the problems log');

        const sent = rows(id, 'SANDBOX');
        state.transport.events.emit('ready', { account: '919822200002', connected: true });
        const held = campaignOf(id);
        assert.equal(held.status, 'paused');
        assert.match(held.options.statusReason, /different phone \(\+919822200002\)/);
        assert.equal(held.options.linkHold, undefined, 'it waits for its owner, not for the next link');
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.equal(rows(id, 'SANDBOX'), sent, 'nothing went out from the new phone by itself');

        assert.equal((await s.api('POST', `/api/campaigns/${id}/resume`, {})).status, 200);
        assert.ok(await waitFor(() => rows(id, 'SANDBOX') > sent), 'its owner resumed it: it carries on');
        await s.api('POST', `/api/campaigns/${id}/cancel`, {});
    });

    it('a scheduled campaign past its time says why it has not started', async () => {
        await s.api('POST', '/api/connection/disconnect');
        const { campaign } = (await s.api('POST', '/api/campaigns', {
            name: 'Overdue', body: 'Hi', status: 'scheduled', scheduledAt: '2020-01-01T00:00:00+00:00', audience: people('6', 2),
        })).body;
        await s.app.locals.sweep();
        const due = campaignOf(campaign.id);
        assert.equal(due.status, 'scheduled');
        assert.match(due.options.statusReason, /^Not started yet: This WhatsApp number is not connected/);
        assert.ok(alerts().some((a) => a.kind === 'campaign_not_started' && /"Overdue"/.test(a.text)), 'in the problems log, once');
        await s.app.locals.sweep();
        assert.equal(alerts().filter((a) => a.kind === 'campaign_not_started').length, 1, 'not again every sweep');
        assert.equal((await s.api('POST', '/api/connection/connect')).status, 200);
        await s.app.locals.sweep();
        assert.equal(campaignOf(campaign.id).options.statusReason, null, 'started: the note is gone');
        await s.api('POST', `/api/campaigns/${campaign.id}/cancel`, {});
    });

    it('a campaign started right after another was stopped goes out to everyone', async () => {
        const first = await startOn(1, 'Stopped first', 10, '8');
        assert.equal((await s.api('POST', `/api/campaigns/${first}/cancel`, {})).status, 200);
        // Its last message may still be in flight: the next campaign must not join its closed queue.
        const { campaign } = (await s.api('POST', '/api/campaigns', { name: 'Next', body: 'Hi', audience: people('9', 10) })).body;
        const go = await s.api('POST', `/api/campaigns/${campaign.id}/start`, {});
        assert.equal(go.status, 200);
        assert.equal(go.body.queued, 10, JSON.stringify(go.body.campaign?.options?.statusReason));
        assert.equal(campaignOf(campaign.id).status, 'running');
        await s.api('POST', `/api/campaigns/${campaign.id}/cancel`, {});
    });

    it('its owner hears when a campaign has finished, once', async () => {
        const state = s.stateOf();
        const { campaign } = (await s.api('POST', '/api/campaigns', { name: 'Short', body: 'Hi', audience: people('7', 2) })).body;
        assert.equal((await s.api('POST', `/api/campaigns/${campaign.id}/start`, {})).status, 200);
        assert.ok(await waitFor(() => campaignOf(campaign.id).status === 'done'));
        const done = state.notices.filter((n) => n.kind === 'campaign_finished' && n.campaign === 'Short');
        assert.equal(done.length, 1);
        assert.deepEqual([done[0].sent, done[0].failed, done[0].skipped], [2, 0, 0]);
    });
});

describe('a campaign held across a restart', () => {
    it('carries on when its number is back, and one left running on an offline number is held', async () => {
        const db = new Database(path.join(tmp, 'restart.db'));
        const people = (p, n) => Array.from({ length: n }, (_, i) => ({ name: `${p}${i}`, phone: `9198${p}${String(i).padStart(6, '0')}` }));
        const rows = (id, status) => db.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND status = ?').get(`camp-${id}`, status).n;
        const statusOf = (id) => db.db.prepare('SELECT status, options FROM campaigns WHERE id = ?').get(id);
        let s = await serve(db);
        const restart = async () => {
            await s.stop();
            s = await serve(db);
        };
        try {
            await s.api('POST', '/api/connection/connect');
            const held = (await s.api('POST', '/api/campaigns', { name: 'Held', body: 'Hi', audience: people('1', 10) })).body.campaign.id;
            await s.api('POST', `/api/campaigns/${held}/start`, {});
            assert.ok(await waitFor(() => rows(held, 'SANDBOX') > 0));
            await s.api('POST', '/api/connection/disconnect');
            assert.equal(statusOf(held).status, 'paused');

            // A restart: the hold lives on the record, not in memory.
            await restart();
            await s.app.locals.sweep();
            assert.equal(statusOf(held).status, 'paused', 'not restored before its number is back');
            const sent = rows(held, 'SANDBOX');
            assert.equal((await s.api('POST', '/api/connection/connect')).status, 200);
            assert.equal(statusOf(held).status, 'running');
            assert.equal(JSON.parse(statusOf(held).options).statusReason, null);
            assert.ok(await waitFor(() => rows(held, 'SANDBOX') > sent), 'it carries on by itself');
            await s.api('POST', `/api/campaigns/${held}/cancel`, {});

            const offline = (await s.api('POST', '/api/campaigns', { name: 'Offline', body: 'Hi', audience: people('2', 10) })).body.campaign.id;
            assert.equal((await s.api('POST', `/api/campaigns/${offline}/start`, {})).status, 200);
            assert.ok(await waitFor(() => rows(offline, 'SANDBOX') > 0));

            // Restarted with its number not connected: the engine holds nothing, the table still reads running.
            await restart();
            s.stateOf().manager.emit('event', { type: 'linkLost', reason: HOLD.offline }); // what the offline watch does after 30 s
            assert.equal(statusOf(offline).status, 'paused');
            assert.equal(JSON.parse(statusOf(offline).options).statusReason, HOLD.offline);
            assert.equal((await s.api('POST', '/api/connection/connect')).status, 200);
            assert.equal(statusOf(offline).status, 'running');
            await s.api('POST', `/api/campaigns/${offline}/cancel`, {});
        } finally {
            await s.stop();
            db.close();
        }
    });
});
