/** Add tenant (pending, details first) and Tenant settings > Edit: name, ID, contact WhatsApp, owner, Wapzo updates. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-details-'));
let db;
let app;
let server;
let base;
let sup;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};

before(async () => {
    db = new Database(path.join(tmp, 'details.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('tenant details', () => {
    let id;

    it('adds a business as pending from its details alone, on the first plan', async () => {
        const made = await call(sup, 'POST', '/api/admin/tenants', {
            name: 'Kiran Opticals', status: 'pending', contactPhone: '+91 90000 11111',
            owner: { name: 'Kiran', email: 'kiran@optic.test' },
        });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        id = made.body.tenant.id;
        assert.equal(made.body.tenant.status, 'pending');
        assert.equal(made.body.tenant.contactPhone, '+91 90000 11111');
        assert.equal(made.body.tenant.subscription.planKey, 'starter');
        assert.equal(made.body.tenant.subscription.payment, 'paid');
        // The owner cannot sign in until the business is activated with a password the admin chooses.
        const login = await call(null, 'POST', '/api/auth/login', { email: 'kiran@optic.test', password: 'password123' });
        assert.equal(login.status, 401, 'its password is a random one nobody knows');
        assert.equal((await call(sup, 'POST', '/api/admin/tenants', {
            name: 'Bad Phone', status: 'pending', contactPhone: 'call me', owner: { email: 'bad@optic.test' },
        })).status, 400);
    });

    it('edits the name, ID, contact number, Wapzo updates and the owner', async () => {
        const url = `/api/admin/tenants/${id}/details`;
        const res = await call(sup, 'PUT', url, {
            name: 'Kiran Eye Care', slug: 'Kiran Eye Care', contactPhone: '98765 43210', wapzoUpdates: false,
            ownerName: 'Kiran Rao', ownerEmail: 'Rao@Optic.test',
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.tenant.name, 'Kiran Eye Care');
        assert.equal(res.body.tenant.slug, 'kiran-eye-care');
        assert.equal(res.body.tenant.contactPhone, '98765 43210');
        assert.equal(res.body.tenant.wapzoUpdates, false);
        assert.equal(res.body.owner.email, 'rao@optic.test');
        assert.equal(res.body.owner.name, 'Kiran Rao');
        // Only what is sent changes.
        const again = await call(sup, 'PUT', url, { wapzoUpdates: true });
        assert.equal(again.body.tenant.name, 'Kiran Eye Care');
        assert.equal(again.body.tenant.wapzoUpdates, true);
        const log = (await call(sup, 'GET', `/api/admin/audit-logs?tenant=${id}&actions=tenant.details`)).body.logs.at(-1);
        assert.match(log.summary, /Changed the details of .*rao@optic\.test/);
    });

    it('keeps the business on paper: GSTIN and PAN checked and upper-cased, blanks dropped', async () => {
        const url = `/api/admin/tenants/${id}/details`;
        assert.equal((await call(sup, 'PUT', url, { profile: { gstin: '12345' } })).status, 400);
        const ok = await call(sup, 'PUT', url, {
            profile: { legalName: 'Kiran Eye Care Pvt Ltd', gstin: '27aapfu0939f1zv', pan: 'aapfu0939f', city: 'Pune', state: '' },
        });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.deepEqual(ok.body.tenant.profile, { legalName: 'Kiran Eye Care Pvt Ltd', gstin: '27AAPFU0939F1ZV', pan: 'AAPFU0939F', city: 'Pune' });
        // Only what is sent changes.
        const more = await call(sup, 'PUT', url, { profile: { pincode: '411001' } });
        assert.equal(more.body.tenant.profile.city, 'Pune');
        assert.equal(more.body.tenant.profile.pincode, '411001');
    });

    it('refuses an ID or owner email that another business has, changing nothing', async () => {
        const other = await call(sup, 'POST', '/api/admin/tenants', {
            name: 'Other Shop', status: 'pending', contactPhone: '+91 90000 22222', owner: { email: 'other@shop.test' },
        });
        const url = `/api/admin/tenants/${id}/details`;
        assert.equal((await call(sup, 'PUT', url, { slug: 'other-shop' })).status, 409);
        const taken = await call(sup, 'PUT', url, { name: 'Renamed', ownerEmail: 'other@shop.test' });
        assert.equal(taken.status, 409);
        const list = (await call(sup, 'GET', '/api/admin/tenants')).body.tenants;
        assert.equal(list.find((t) => t.id === id).name, 'Kiran Eye Care', 'a refused email renames nothing');
        assert.equal((await call(sup, 'PUT', url, { contactPhone: 'x' })).status, 400);
        assert.ok(list.find((t) => t.id === other.body.tenant.id));
    });

    it('charges a plan without a list price as soon as its price is set, once a period', async () => {
        const bill = async () => (await call(sup, 'GET', `/api/admin/tenants/${id}/payments`)).body;
        await call(sup, 'POST', `/api/admin/tenants/${id}/activate`, { password: 'password123', sendWelcome: false });
        assert.equal((await bill()).charged, 0, "activated on its first plan's trial: not live yet");
        await call(sup, 'PUT', `/api/admin/tenants/${id}/subscription`, { planKey: 'enterprise' });
        assert.equal((await bill()).charged, 0, 'no price yet, nothing to charge');
        const priced = await call(sup, 'PUT', `/api/admin/tenants/${id}/price`, { amount: 25000 });
        assert.equal(priced.body.tenant.balance.charged, 25000);
        await call(sup, 'PUT', `/api/admin/tenants/${id}/price`, { amount: 30000 });
        assert.equal((await bill()).charged, 25000, 'a new price is charged from the next period');
    });

    it("keeps Wapzo's own system tenant out of every business list", async () => {
        const system = app.locals.tenancy.systemTenant({ create: true });
        assert.equal(system.status, 'system');
        assert.equal(app.locals.tenancy.systemTenant({ create: true }).id, system.id, 'made once');
        const list = (await call(sup, 'GET', '/api/admin/tenants')).body.tenants;
        assert.ok(!list.some((t) => t.id === system.id));
        assert.ok(!(await call(sup, 'GET', '/api/admin/payments')).body.rows.some((r) => r.tenantId === system.id));
        assert.equal((await call(sup, 'PUT', `/api/admin/tenants/${system.id}/details`, { name: 'x' })).status, 404);
    });
});
