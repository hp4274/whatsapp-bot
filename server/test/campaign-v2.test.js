/**
 * Bulk Campaigns v2: the engine side.
 *
 * Claims under test: column mapping + per-variable fallbacks produce the right
 * text through the REAL CampaignManager; interactive blocks are validated and
 * personalised per recipient; speed presets never undercut the policy floor;
 * PER_USER_CAP (Meta 131049) is never retried; campaign options persist;
 * retry-failed re-queues only the failed recipients; analytics/export read the
 * latest row per recipient; retargeting resolves the right people; and a
 * scheduled campaign waits for a connected transport.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { PACING_PRESETS, paceFor } from '../src/campaign/safety.js';
import { CampaignStore, campaignKey } from '../src/campaigns/store.js';
import { DEFAULTS, TRANSPORT_CLOUD_API, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { ErrorCode, FRIENDLY } from '../src/messaging/errors.js';
import { InteractiveError } from '../src/messaging/interactive.js';
import { Status } from '../src/protocol.js';
import { TemplateStore } from '../src/templates/store.js';
import { TransportSendError } from '../src/transports/base.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-campv2-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (predicate, timeoutMs = 6000) => {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
        if (await predicate()) return true;
        await sleep(25);
    }
    return false;
};

// ------------------------------------------------------------------ engine --
function fakeTransport(send) {
    return {
        name: 'fake', realDelivery: true, supportsReceipts: false,
        isConnected: () => true,
        sendMessage: send,
        getStatus: () => null,
        async disconnect() {},
    };
}

const engineConfig = (extra = {}) => ({
    ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', retryDelay: 0.01, ...extra,
});

describe('the engine', () => {
    let db;
    before(() => { db = new Database(path.join(tmp, 'engine.db')); });
    after(() => db?.close());

    it('applies the mapping, fallbacks, personalised buttons and media through the real manager', async () => {
        const sent = [];
        const transport = fakeTransport(async (to, text, opts) => {
            sent.push({ to, text, opts });
            return { providerId: `p${sent.length}`, status: Status.SENT };
        });
        const manager = new CampaignManager(db, transport, engineConfig());
        const media = { mediaId: 'm1', filename: 'menu.pdf', mimetype: 'application/pdf', size: 10 };
        manager.enqueueContacts([
            { name: 'Asha', phone: '919800000001', extra: { order_id: 'A1', city: '' } },
            { name: '', phone: '919800000002', extra: { order_id: 'B2' } },
        ], 'Hi {name}, order {order_id} ships to {city}', {
            campaignId: 'camp-v2-engine',
            media,
            fallbacks: { name: 'there', city: 'your city' },
            interactive: {
                type: 'buttons',
                header: 'Order {order_id}',
                buttons: [{ id: 'yes', title: 'Confirm', payload: 'CONFIRM_{order_id}' }, { id: 'no', title: 'Cancel' }],
            },
            pacing: 'fast',
        });
        assert.equal(manager.pacePreset, 'fast');
        manager.start();
        assert.ok(await waitFor(() => sent.length === 2));
        await manager.shutdown();

        const by = Object.fromEntries(sent.map((s) => [s.to, s]));
        assert.equal(by['919800000001'].text, 'Hi Asha, order A1 ships to your city');
        assert.equal(by['919800000002'].text, 'Hi there, order B2 ships to your city');
        assert.equal(by['919800000001'].opts.interactive.buttons[0].payload, 'CONFIRM_A1');
        assert.equal(by['919800000002'].opts.interactive.buttons[0].payload, 'CONFIRM_B2');
        assert.equal(by['919800000002'].opts.interactive.header, 'Order B2');
        assert.deepEqual(by['919800000001'].opts.media, media);
    });

    it('refuses an invalid interactive block before anything is queued', () => {
        const manager = new CampaignManager(db, fakeTransport(async () => ({ status: Status.SENT })), engineConfig());
        assert.throws(() => manager.enqueueContacts([{ name: 'A', phone: '919800000009' }], 'hi', {
            interactive: { type: 'buttons', buttons: [] },
        }), InteractiveError);
        assert.equal(manager.queue.pending, 0);
    });

    it('never retries a per-user marketing cap (131049)', async () => {
        let attempts = 0;
        const transport = fakeTransport(async () => {
            attempts += 1;
            throw new TransportSendError('(#131049) healthy ecosystem engagement', { retryable: true, code: 131049 });
        });
        const manager = new CampaignManager(db, transport, engineConfig({ maxRetries: 3 }));
        manager.enqueueContacts([{ name: 'Cap', phone: '919800000010' }], 'Hello {name}', { campaignId: 'camp-v2-cap' });
        manager.start();
        assert.ok(await waitFor(() => manager.stats.processed === 1));
        await manager.shutdown();
        assert.equal(attempts, 1);
        const row = db.history({ campaignId: 'camp-v2-cap' })[0];
        assert.equal(row.status, Status.FAILED);
        assert.match(row.error, /try again after 24h/);
    });
});

describe('speed presets', () => {
    it('keeps balanced as it was, makes safe slower and fast faster but never under the floor', () => {
        assert.deepEqual(PACING_PRESETS, ['safe', 'balanced', 'fast']);
        const balanced = paceFor(120, DEFAULTS);
        assert.deepEqual({ ...paceFor(120, DEFAULTS, 'balanced'), preset: undefined }, { ...balanced, preset: undefined });
        assert.equal(balanced.minSeconds, 15);
        assert.equal(balanced.maxSeconds, 40);

        const safe = paceFor(120, DEFAULTS, 'safe');
        assert.ok(safe.minSeconds > balanced.minSeconds && safe.maxSeconds > balanced.maxSeconds);

        const fast = paceFor(120, DEFAULTS, 'fast');
        assert.equal(fast.minSeconds, 7.5);
        assert.ok(fast.maxSeconds >= fast.minSeconds);

        const floored = paceFor(120, { ...DEFAULTS, minDelaySeconds: 12 }, 'fast');
        assert.equal(floored.minSeconds, 12, 'the policy floor wins');
        assert.ok(floored.maxSeconds >= 12);
        for (const size of [1, 10, 50, 200, 1000, 5000]) {
            assert.ok(paceFor(size, { ...DEFAULTS, minDelaySeconds: 9 }, 'fast').minSeconds >= 9);
        }
    });

    it('changes a live manager\'s pace', () => {
        const db = new Database(path.join(tmp, 'pace.db'));
        const manager = new CampaignManager(db, null, engineConfig());
        manager.pace = paceFor(120, manager.config);
        const before = manager.pace.minSeconds;
        manager.setPace('safe');
        assert.equal(manager.pacePreset, 'safe');
        assert.equal(manager.pace.minSeconds, before * 1.5);
        assert.equal(manager.safetyStatus(120, 'fast').pacing, 'fast');
        manager.setPace('nonsense');
        assert.equal(manager.pacePreset, 'balanced');
        db.close();
    });
});

// ------------------------------------------------------------------- store --
function fakeManager() {
    const manager = {
        calls: [],
        jobs: [],
        paces: [],
        started: 0,
        campaignId: '',
        quota: { limit: 500 },
        pausedByQuota: false,
        queue: { reset() {} },
        resetStats() {},
        enqueueContacts(contacts, template, options) {
            manager.calls.push({ contacts, template, options });
            manager.campaignId = options.campaignId;
            return { queued: contacts.length, skipped: 0, campaignId: options.campaignId };
        },
        enqueueJob(job) {
            manager.jobs.push(job);
            return `job-${manager.jobs.length}`;
        },
        setPace(preset, batch) { manager.paces.push([preset, batch]); },
        safetyStatus(batch, preset) { return { batch, pacing: preset }; },
        start() { manager.started += 1; },
        pause() {},
        resume() { return true; },
        stop() { return 0; },
        statsSnapshot() { return { total: 0, pending: 0 }; },
    };
    return manager;
}

describe('the campaign store', () => {
    let db;
    let scoped;
    let contacts;
    let manager;
    let store;
    let connected = true;
    const media = new Map([['m1', { mediaId: 'm1', filename: 'a.png', kind: 'image' }]]);

    const insertRow = (id, recipient, status, extra = {}) => scoped.insert({
        messageId: `m-${Math.random().toString(36).slice(2)}`,
        recipient,
        message: extra.message ?? `hello ${recipient}`,
        status,
        name: extra.name ?? '',
        error: extra.error ?? null,
        campaignId: campaignKey(id),
    });

    before(() => {
        db = new Database(path.join(tmp, 'store.db'));
        scoped = db.forTenant(1).forChannel(1);
        contacts = new ContactStore(scoped, '91');
        manager = fakeManager();
        store = new CampaignStore(scoped, {
            contacts,
            templates: new TemplateStore(scoped),
            manager,
            canSend: () => connected,
            media: (id) => media.get(id) ?? null,
        });
    });
    after(() => db?.close());

    it('persists options and reloads them in a fresh store', () => {
        const created = store.create({
            name: 'Opts',
            body: 'Hi {name}',
            audience: [{ name: 'A', phone: '919811100001' }],
            options: {
                pacing: 'safe',
                fallbacks: { name: 'friend', 'bad key': 'x' },
                interactive: { type: 'buttons', buttons: [{ title: 'Yes please' }] },
                variables: ['name'],
                mediaMeta: { filename: 'a.png' },
            },
        });
        const again = new CampaignStore(scoped, { contacts }).get(created.id);
        assert.equal(again.options.pacing, 'safe');
        assert.deepEqual(again.options.fallbacks, { name: 'friend' });
        assert.equal(again.options.interactive.buttons[0].id, 'YES_PLEASE');
        assert.deepEqual(again.options.mediaMeta, { filename: 'a.png' });
        assert.equal(again.audienceSize, 1);

        const listed = store.list().find((c) => c.id === created.id);
        assert.equal(listed.audience, null);
        assert.equal(listed.audienceSize, 1);
        assert.equal(listed.options.pacing, 'safe');
    });

    it('rejects a bad interactive block or pacing with a 400', () => {
        assert.throws(() => store.create({ name: 'x', options: { interactive: { type: 'buttons', buttons: [] } } }),
            (err) => err.status === 400 && /1 to 3 buttons/.test(err.message));
        assert.throws(() => store.create({ name: 'x', options: { pacing: 'warp' } }), (err) => err.status === 400);
    });

    it('migrates an old database that has no options column', () => {
        const old = new Database(path.join(tmp, 'old.db'));
        old.db.exec('DROP TABLE campaigns');
        old.db.exec(`CREATE TABLE campaigns (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL,
            channel_id INTEGER, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', template_id INTEGER,
            body TEXT NOT NULL DEFAULT '', segment_id INTEGER, audience TEXT NOT NULL DEFAULT 'null', media_id TEXT,
            scheduled_at TEXT, started_at TEXT, finished_at TEXT, stats TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
        const oldScoped = old.forTenant(1).forChannel(1);
        const oldStore = new CampaignStore(oldScoped, { contacts: new ContactStore(oldScoped, '91') });
        new CampaignStore(oldScoped, { contacts: new ContactStore(oldScoped, '91') }); // idempotent
        const c = oldStore.create({ name: 'Old', body: 'hi', options: { pacing: 'fast' } });
        assert.equal(oldStore.get(c.id).options.pacing, 'fast');
        old.close();
    });

    it('refuses to start while no transport is connected, and hands options to the manager', () => {
        const c = store.create({
            name: 'Start',
            body: 'Hi {name}',
            mediaId: 'm1',
            audience: [{ name: 'A', phone: '919811100002', extra: { order_id: 'Z9' } }],
            options: { pacing: 'fast', fallbacks: { name: 'there' }, interactive: { type: 'buttons', buttons: [{ title: 'OK' }] } },
        });
        connected = false;
        assert.throws(() => store.start(c.id), (err) => err.status === 409 && /Connect a transport/.test(err.message));
        assert.equal(store.get(c.id).status, 'draft');
        connected = true;
        store.start(c.id);
        const { options } = manager.calls.at(-1);
        assert.equal(options.pacing, 'fast');
        assert.deepEqual(options.fallbacks, { name: 'there' });
        assert.equal(options.interactive.type, 'buttons');
        assert.equal(options.media.mediaId, 'm1');

        const speed = store.setSpeed(c.id, 'safe');
        assert.equal(speed.campaign.options.pacing, 'safe');
        assert.equal(speed.safety.pacing, 'safe');
        assert.deepEqual(manager.paces.at(-1), ['safe', undefined], 'live run re-paced');
        assert.throws(() => store.setSpeed(c.id, 'warp'), (err) => err.status === 400);
        store.cancel(c.id);
    });

    it('retries only the recipients whose latest row failed, with the stored text and media', () => {
        const c = store.create({
            name: 'Retry',
            body: 'Hi {name}',
            mediaId: 'm1',
            audience: [
                { name: 'Ann', phone: '919822200001' },
                { name: 'Ben', phone: '919822200002' },
                { name: 'Cara', phone: '919822200003', extra: { order_id: 'C3' } },
            ],
            options: { interactive: { type: 'buttons', buttons: [{ id: 'ok', title: 'OK', payload: 'OK_{order_id}' }] } },
        });
        assert.throws(() => store.retryFailed(c.id), (err) => err.status === 409, 'a draft has nothing to retry');
        store.start(c.id);
        insertRow(c.id, '919822200001', 'SENT', { name: 'Ann' });
        insertRow(c.id, '919822200002', 'SENT', { name: 'Ben' });
        insertRow(c.id, '919822200003', 'FAILED', { name: 'Cara', message: 'Hi Cara (stored)', error: 'boom' });

        const before = manager.jobs.length;
        const result = store.retryFailed(c.id); // stats() marks it done first
        const jobs = manager.jobs.slice(before);
        assert.equal(result.queued, 1);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].recipient, '919822200003');
        assert.equal(jobs[0].text, 'Hi Cara (stored)');
        assert.equal(jobs[0].campaignId, campaignKey(c.id));
        assert.deepEqual(jobs[0].media, media.get('m1'));
        assert.equal(jobs[0].interactive.buttons[0].payload, 'OK_C3');
        assert.equal(result.campaign.status, 'running');
        assert.equal(result.campaign.finishedAt, null);
    });

    it('reports the funnel, failure reasons and replies from the latest rows, and exports them', () => {
        const c = store.create({
            name: 'Analytics',
            body: 'hi',
            audience: ['919833300001', '919833300002', '919833300003', '919833300004']
                .map((phone, i) => ({ name: `P${i + 1}`, phone })),
        });
        store.start(c.id);
        insertRow(c.id, '919833300001', 'READ', { name: 'P1' });
        insertRow(c.id, '919833300002', 'DELIVERED', { name: 'P2' });
        insertRow(c.id, '919833300003', 'SENT', { name: 'P3' });
        insertRow(c.id, '919833300003', 'FAILED', { name: 'P3', error: FRIENDLY[ErrorCode.INVALID_RECIPIENT] });
        insertRow(c.id, '919833300004', 'SENT', { name: 'P4' });
        scoped.insertInbound({ sender: '919833300001', body: 'thanks!' });

        const report = store.analytics(c.id);
        assert.deepEqual(report.funnel, { audience: 4, queued: 4, sent: 3, delivered: 2, read: 1, replied: 1, failed: 1 });
        assert.deepEqual(report.failures, [{ code: ErrorCode.INVALID_RECIPIENT, label: FRIENDLY[ErrorCode.INVALID_RECIPIENT], count: 1 }]);
        assert.equal(report.clicks, null);
        const p1 = report.recipients.find((r) => r.phone === '919833300001');
        assert.equal(p1.replied, true);
        assert.equal(p1.clicked, null);
        const p3 = report.recipients.find((r) => r.phone === '919833300003');
        assert.equal(p3.status, 'FAILED');
        assert.equal(p3.errorCode, ErrorCode.INVALID_RECIPIENT);

        const csv = store.exportCsv(c.id).split('\r\n');
        assert.equal(csv[0], 'timestamp,phone,name,status,error,button_clicked');
        assert.ok(csv.some((line) => line.includes('919833300002,P2,DELIVERED')));
    });

    it('retargets failed, unread, no-reply, replied and clicked recipients of another campaign', () => {
        const a = store.create({
            name: 'Source',
            body: 'hi',
            audience: [
                { name: 'Fay', phone: '919844400001', extra: { order_id: 'F1' } },
                { name: 'Dee', phone: '919844400002' },
                { name: 'Rae', phone: '919844400003' },
            ],
        });
        store.start(a.id);
        insertRow(a.id, '919844400001', 'FAILED', { name: 'Fay' });
        insertRow(a.id, '919844400002', 'FAILED', { name: 'Dee' }); // superseded by the retry below
        insertRow(a.id, '919844400002', 'DELIVERED', { name: 'Dee' });
        insertRow(a.id, '919844400003', 'READ', { name: 'Rae' });
        scoped.insertInbound({ sender: '919844400003', body: 'yes' });

        const phones = (filter, extra = {}) => {
            const b = store.create({ name: `B ${filter}`, body: 'hi', audience: { retarget: { campaignId: a.id, filter, ...extra } } });
            assert.equal(b.audienceSize, null);
            return store.resolveAudience(store.get(b.id)).map((r) => r.phone);
        };
        assert.deepEqual(phones('failed'), ['919844400001']);
        assert.deepEqual(phones('unread'), ['919844400002']);
        assert.deepEqual(phones('noreply'), ['919844400002']);
        assert.deepEqual(phones('replied'), ['919844400003']);
        assert.deepEqual(phones('clicked', { optionId: 'yes' }), []);

        // The source list's extras travel with the person.
        const b = store.create({ name: 'B start', body: 'Your order {order_id}', audience: { retarget: { campaignId: a.id, filter: 'failed' } } });
        store.start(b.id);
        assert.deepEqual(manager.calls.at(-1).contacts, [{ name: 'Fay', phone: '919844400001', extra: { order_id: 'F1' } }]);

        const bad = store.create({ name: 'B bad', body: 'hi', audience: { retarget: { campaignId: a.id, filter: 'weird' } } });
        assert.throws(() => store.resolveAudience(bad), (err) => err.status === 400);
    });
});

// -------------------------------------------------------------------- HTTP --
describe('campaigns over HTTP', () => {
    let app;
    let server;
    let base;
    let db;

    before(async () => {
        db = new Database(path.join(tmp, 'http.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, retryDelay: 0.01, maxRetries: 1 };
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
    });

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let parsed = text;
        try { parsed = JSON.parse(text); } catch { /* csv */ }
        return { status: res.status, body: parsed, headers: res.headers };
    };

    it('keeps a due campaign scheduled while disconnected, then the sweep sends it', async () => {
        const created = await api('POST', '/api/campaigns', {
            name: 'Scheduled',
            body: 'Hi {name}, code {code}',
            status: 'scheduled',
            scheduledAt: '2020-01-01T00:00:00+00:00',
            audience: [{ name: 'Sam', phone: '919855500001' }, { name: 'Tia', phone: '919855500002' }],
            options: { pacing: 'fast', fallbacks: { code: 'WELCOME' } },
        });
        assert.equal(created.status, 201);
        const { id } = created.body.campaign;
        assert.equal(created.body.campaign.options.pacing, 'fast');

        await app.locals.sweep();
        assert.equal((await api('GET', `/api/campaigns/${id}`)).body.campaign.status, 'scheduled');

        assert.equal((await api('POST', '/api/connection/connect')).status, 200);
        await app.locals.sweep();
        const status = (await api('GET', `/api/campaigns/${id}`)).body.campaign.status;
        assert.ok(['running', 'done'].includes(status), status);
        assert.ok(await waitFor(() => db.history({ campaignId: campaignKey(id) })
            .filter((r) => r.status === Status.SANDBOX).length === 2));
        const texts = db.history({ campaignId: campaignKey(id) }).map((r) => r.message).sort();
        assert.deepEqual(texts, ['Hi Sam, code WELCOME', 'Hi Tia, code WELCOME']);

        const analytics = await api('GET', `/api/campaigns/${id}/analytics`);
        assert.equal(analytics.status, 200);
        assert.equal(analytics.body.funnel.sent, 2);
        assert.equal(analytics.body.campaign.status, 'done');

        const csv = await api('GET', `/api/campaigns/${id}/export.csv`);
        assert.equal(csv.status, 200);
        assert.match(csv.headers.get('content-type'), /text\/csv/);
        assert.match(csv.headers.get('content-disposition'), new RegExp(`attachment; filename="campaign-${id}.csv"`));
        assert.match(csv.body, /^timestamp,phone,name,status,error,button_clicked/);
    });

    it('pauses, resumes, re-paces and cancels; lists without the audience', async () => {
        const created = await api('POST', '/api/campaigns', {
            name: 'Controls', body: 'Hi {name}',
            audience: Array.from({ length: 5 }, (_, i) => ({ name: `N${i}`, phone: `91986660000${i}` })),
        });
        const { id } = created.body.campaign;
        const listed = (await api('GET', '/api/campaigns')).body.campaigns.find((c) => c.id === id);
        assert.equal(listed.audience, null);
        assert.equal(listed.audienceSize, 5);

        assert.equal((await api('POST', `/api/campaigns/${id}/start`)).status, 200);
        assert.equal((await api('POST', `/api/campaigns/${id}/pause`)).body.campaign.status, 'paused');
        const speed = await api('POST', `/api/campaigns/${id}/speed`, { pacing: 'safe' });
        assert.equal(speed.status, 200);
        assert.equal(speed.body.campaign.options.pacing, 'safe');
        assert.equal(speed.body.safety.pacing, 'safe');
        assert.equal((await api('POST', `/api/campaigns/${id}/speed`, { pacing: 'warp' })).status, 400);
        assert.equal((await api('POST', `/api/campaigns/${id}/resume`)).body.campaign.status, 'running');
        assert.equal((await api('POST', `/api/campaigns/${id}/cancel`)).body.campaign.status, 'cancelled');
        // Whatever the cancel stopped is FAILED and may be retried; if every
        // sandbox send beat the pause there is nothing to retry (409).
        const retry = await api('POST', `/api/campaigns/${id}/retry-failed`);
        assert.ok([200, 409].includes(retry.status), JSON.stringify(retry.body));
        if (retry.status === 200) assert.equal(retry.body.campaign.status, 'running');
    });

    it('answers live speed and safety with a preset', async () => {
        const speed = await api('POST', '/api/campaign/speed', { pacing: 'fast' });
        assert.equal(speed.status, 200);
        assert.equal(speed.body.stats.safety.pacing, 'fast');
        assert.equal((await api('POST', '/api/campaign/speed', { pacing: 'nope' })).status, 400);
        const safety = await api('GET', '/api/safety?contacts=120&pacing=safe');
        assert.equal(safety.body.safety.pacing, 'safe');
        assert.equal(safety.body.safety.minSeconds, 22.5);
        await api('POST', '/api/campaign/speed', { pacing: 'balanced' });
    });

    it('resolves an import into an explicit list at create time', async () => {
        const form = new FormData();
        form.set('file', new Blob(['Name,Phone,Order\nAsha,9800011111,A1\nBad,123,B2\n'], { type: 'text/csv' }), 'list.csv');
        const preview = await fetch(`${base}/api/campaign/import/preview`, { method: 'POST', body: form });
        assert.equal(preview.status, 200);
        const sheet = await preview.json();
        const created = await api('POST', '/api/campaigns', {
            name: 'Imported',
            body: 'Hi {name}, order {order}',
            audience: { importId: sheet.importId, mapping: { phone: sheet.guess.phone, name: sheet.guess.name }, countryCode: '91' },
        });
        assert.equal(created.status, 201);
        assert.equal(created.body.campaign.audienceSize, 1);
        assert.deepEqual(created.body.campaign.audience[0], { name: 'Asha', phone: '919800011111', extra: { order: 'A1' } });

        assert.equal((await api('POST', '/api/campaigns', {
            name: 'Gone', body: 'hi', audience: { importId: 'nope', mapping: { phone: 'phone' } },
        })).status, 404);
        assert.equal((await api('POST', '/api/campaigns', {
            name: 'Bad map', body: 'hi', audience: { importId: sheet.importId, mapping: { phone: 'missing' } },
        })).status, 400);
        assert.equal((await api('POST', '/api/campaigns', {
            name: 'Bad buttons', body: 'hi', options: { interactive: { type: 'list' } },
        })).status, 400);
    });
});

describe('retrying a Meta template campaign', () => {
    it('re-sends the approved template to a Meta-mode campaign, plain text to a plain one', () => {
        const db = new Database(path.join(tmp, 'retry-meta.db'));
        try {
            const scoped = db.forTenant(1).forChannel(1);
            const templates = new TemplateStore(scoped);
            const t = templates.create({
                name: 'Order', templateType: 'provider_template', body: 'Hi {{1}}', approvalStatus: 'approved',
                providerTemplateName: 'order_update', language: 'en', paramMapping: { body: [{ var: 'name' }] },
            });
            const manager = fakeManager();
            const store = new CampaignStore(scoped, {
                contacts: new ContactStore(scoped, '91'), templates, manager, canSend: () => true,
            });
            store.channel = () => ({ id: 1, provider: TRANSPORT_CLOUD_API });
            const retryJob = (fields) => {
                const c = store.create({ name: 'R', audience: [{ name: 'Dev', phone: '919844400001' }], ...fields });
                store.start(c.id);
                scoped.insert({
                    messageId: `m-${Math.random().toString(36).slice(2)}`, recipient: '919844400001',
                    message: 'Hi Dev (stored)', status: 'FAILED', name: 'Dev', error: 'boom', campaignId: campaignKey(c.id),
                });
                const before = manager.jobs.length;
                store.retryFailed(c.id);
                return manager.jobs.slice(before)[0];
            };

            const meta = retryJob({ templateId: t.id, options: { templateMode: 'meta', templateParams: { body: [{ var: 'name' }] } } });
            assert.equal(meta.text, 'Hi Dev (stored)');
            assert.equal(meta.template.name, 'order_update');
            assert.deepEqual(meta.template.components, [{ type: 'body', parameters: [{ type: 'text', text: 'Dev' }] }]);

            const plain = retryJob({ body: 'Hi {name}' });
            assert.equal(plain.text, 'Hi Dev (stored)');
            assert.equal(plain.template, null);
        } finally {
            db.close();
        }
    });
});
