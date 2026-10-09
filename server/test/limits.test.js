/** Per-tenant plan limits set by the platform admin, and where they bite. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { CampaignManager } from '../src/campaign/manager.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Status } from '../src/protocol.js';
import { blockedWordIn, normalizeLimits } from '../src/tenancy.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-limits-'));
let db;
let app;
let server;
let base;
let sup;
let owner;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
    db = new Database(path.join(tmp, 'l.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('plan limits', () => {
    it('defaults to no limit, and rejects nonsense', async () => {
        assert.equal(normalizeLimits({}).maxChannels, 0);
        assert.throws(() => normalizeLimits({ maxChannels: -1 }, true), /maxChannels/);
        assert.throws(() => normalizeLimits({ allowCloudApi: false, allowWhatsappWeb: false }, true), /transport/);
        assert.equal(blockedWordIn({ blockedWords: 'casino, free crypto' }, 'Win at the Casino!'), 'casino');
        assert.equal(blockedWordIn({ blockedWords: 'casino' }, 'a casinos'), null, 'whole words only');
    });

    it('saves through the admin API and shows on the tenant', async () => {
        const put = await call(sup, 'PUT', '/api/admin/tenants/1/limits', {
            maxChannels: 1, maxTemplates: 1, maxMediaMb: 1, maxContactsPerCampaign: 2, blockedWords: 'casino',
        });
        assert.equal(put.status, 200);
        assert.equal(put.body.limits.maxChannels, 1);
        assert.equal((await call(owner, 'PUT', '/api/admin/tenants/1/limits', {})).status, 403, 'tenants cannot set their own');
        const list = await call(sup, 'GET', '/api/admin/tenants');
        assert.equal(list.body.tenants.find((t) => t.id === 1).limits.maxTemplates, 1);
    });

    it('caps numbers, templates and campaign size, and blocks banned words', async () => {
        assert.equal((await call(owner, 'POST', '/api/channels', { displayName: 'Second' })).status, 403, 'one number only');

        const first = await call(owner, 'POST', '/api/templates', { name: 'one', body: 'Hello {name}' });
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal((await call(owner, 'POST', '/api/templates', { name: 'two', body: 'Hi' })).status, 403, 'template cap');
        assert.equal((await call(owner, 'PUT', `/api/templates/${first.body.template.id}`, { body: 'Play casino now' })).status, 400, 'banned word');

        await call(owner, 'POST', '/api/connection/connect');
        const three = [1, 2, 3].map((n) => ({ name: `P${n}`, phone: `91980000000${n}` }));
        const big = await call(owner, 'POST', '/api/campaign/start', { contacts: three, template: 'Hi' });
        assert.equal(big.status, 403, 'over the contact cap');
        const bad = await call(owner, 'POST', '/api/campaign/start', { contacts: three.slice(0, 2), template: 'Visit our casino' });
        assert.equal(bad.status, 400, 'banned word in a campaign');
        const ok = await call(owner, 'POST', '/api/campaign/start', { contacts: three.slice(0, 2), template: 'Hi {name}' });
        assert.equal(ok.status, 200);
    });

    it('blocks a transport the plan does not include', async () => {
        await call(sup, 'PUT', '/api/admin/tenants/1/limits', { allowCloudApi: false });
        const res = await call(owner, 'PUT', '/api/config', { transport: 'cloud_api', phoneNumberId: '1', accessToken: 'x' });
        assert.equal(res.status, 403);
        await call(sup, 'PUT', '/api/admin/tenants/1/limits', { allowCloudApi: true });
    });
});

describe('stop on high failure rate', () => {
    it('pauses a campaign once failures pass the limit', async () => {
        const fdb = new Database(path.join(tmp, 'f.db'));
        const failing = {
            name: 'fail', realDelivery: false, supportsReceipts: false,
            isConnected: () => true,
            async sendMessage() { return { providerId: null, status: Status.FAILED, detail: 'nope' }; },
            getStatus: () => null,
            async disconnect() {},
        };
        const manager = new CampaignManager(fdb, failing, {
            ...DEFAULTS, rateLimitPerSecond: 1000, pacingMode: 'fixed', maxRetries: 0, failureStopPercent: 10,
        });
        const events = [];
        manager.on('event', (e) => events.push(e));
        manager.enqueueContacts(
            Array.from({ length: 60 }, (_, i) => ({ name: `N${i}`, phone: `9197000${String(10000 + i)}` })), 'Hi');
        manager.start();
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && !events.some((e) => e.type === 'failureStop')) {
            await new Promise((r) => setTimeout(r, 25));
        }
        await manager.shutdown();
        fdb.close();
        const stop = events.find((e) => e.type === 'failureStop');
        assert.ok(stop, 'paused on failures');
        assert.ok(stop.processed < 60, 'rest stayed queued');
    });
});
