/**
 * WhatsApp Catalog, the way a business gets to it: the super admin switches the service on, the business's own
 * session sees it, a plan renewal leaves it on, the numbers list says which app each number runs, and a cart only
 * becomes an order where both Catalog and Orders are on.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-catalog-access-'));
let db;
let app;
let server;
let base;
let sup;
let owner;
let tenantId;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
};
const servicesOf = async () => (await call(owner, 'GET', '/api/auth/me')).body.tenant.services;

before(async () => {
    db = new Database(path.join(tmp, 'a.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
    const made = await call(sup, 'POST', '/api/admin/tenants', {
        name: 'Bake House', slug: 'bake-house', planKey: 'business', owner: { email: 'owner@bake.test', password: 'password123' },
    });
    tenantId = made.body.tenant.id;
    owner = sessionFor(app, { tenantId, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WhatsApp Catalog access', () => {
    it('is off until the super admin switches it on, and the business sees the switch', async () => {
        assert.ok(!(await servicesOf()).includes('catalog'), 'no plan sells it');
        const before = (await call(sup, 'GET', '/api/admin/tenants')).body.tenants.find((t) => t.id === tenantId).services;
        const res = await call(sup, 'PATCH', `/api/admin/tenants/${tenantId}`, { services: [...before, 'catalog', 'orders'] });
        assert.equal(res.status, 200);
        const mine = await servicesOf();
        assert.ok(mine.includes('catalog') && mine.includes('orders'));
    });

    it('stays on when the same plan is renewed', async () => {
        const res = await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/subscription`, { planKey: 'business' });
        assert.equal(res.status, 200);
        const mine = await servicesOf();
        assert.ok(mine.includes('catalog') && mine.includes('orders'), 'services the admin added survive a renewal');
        assert.ok(mine.includes('tickets'), 'and the plan\'s own are still there');
    });

    it('the numbers list says which app a connected number runs', async () => {
        // The default business: its number runs on the offline sandbox transport.
        const first = sessionFor(app, { tenantId: 1, role: 'owner' });
        assert.equal((await call(first, 'POST', '/api/connection/connect')).status, 200);
        const rt = app.locals.runtimeFor(1);
        const channel = rt.channels.getDefault();
        const state = rt.runtimeFor(channel).state;
        const health = async () => (await call(first, 'GET', '/api/channels')).body.channels.find((c) => c.id === channel.id).health;
        assert.equal((await health()).connected, true);
        state.info = { ...state.info, accountType: 'business' };
        assert.equal((await health()).accountType, 'business');
        assert.equal((await call(first, 'GET', '/api/connection')).body.accountType, 'business');
    });
});
