/** Staff roles: a full super admin gives a staff member a role, and the role decides what they may do on each page. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { SECTION_ACTIONS, staffMayOpen } from '../src/adminRoles.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-admin-roles-'));
let db;
let app;
let server;
let base;
let sup;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};

before(async () => {
    db = new Database(path.join(tmp, 'roles.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX } });
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

describe('staff roles', () => {
    it('ties each admin write to the one thing it does on its page', () => {
        const may = (perms, method, path) => staffMayOpen(perms, method, path);
        assert.equal(may({ tenants: ['view', 'add'] }, 'POST', '/tenants'), true);
        assert.equal(may({ tenants: ['view', 'add'] }, 'POST', '/tenants/4/activate'), false, 'activating changes a business');
        assert.equal(may({ tenants: ['view', 'edit'] }, 'DELETE', '/tenants/4/payments/9'), true, 'removing a payment is a change');
        assert.equal(may({ tenants: ['view', 'edit'] }, 'DELETE', '/tenants/4'), false);
        assert.equal(may({ tenants: ['view', 'edit'] }, 'PUT', '/policy/tenant%3A4'), true, 'one business\'s own rules');
        assert.equal(may({ tenants: ['view', 'edit'] }, 'PUT', '/policy/campaigns'), false, 'but not a service\'s');
        assert.equal(may({ services: ['view', 'rules'] }, 'PUT', '/policy/campaigns'), true);
        assert.equal(may({ services: ['view', 'rules'] }, 'POST', '/campaigns/3/pause'), false);
        assert.equal(may({ services: ['view', 'numbers'] }, 'POST', '/numbers/3/pause'), true);
        assert.equal(may({ channels: ['view', 'edit'] }, 'POST', '/numbers/3/pause'), true);
        assert.equal(may({ referrals: ['view', 'edit'] }, 'POST', '/referrals/3/payout'), false, 'paying out is its own right');
        assert.equal(may({ usage: ['view'] }, 'GET', '/usage-summary'), true);
        assert.deepEqual(SECTION_ACTIONS.usage, ['view'], 'Usage is a page to read');
    });


    let roleId;
    let staffId;
    let token;

    it('makes a role that opens only the pages chosen', async () => {
        const bad = await call(sup, 'POST', '/api/admin/roles', { name: 'Support', permissions: { settings: ['view'] } });
        assert.equal(bad.status, 400);
        const made = await call(sup, 'POST', '/api/admin/roles',
            { name: 'Support', permissions: { referrals: ['add'], leads: ['answer'], plans: [] } });
        assert.equal(made.status, 200);
        const role = made.body.roles.find((r) => r.name === 'Support');
        assert.deepEqual(role.permissions, { leads: ['view', 'answer'], referrals: ['view', 'add'] }, 'any action implies seeing; an empty page is dropped');
        const usage = await call(sup, 'POST', '/api/admin/roles', { name: 'Ops', permissions: { usage: ['view', 'edit'] } });
        assert.deepEqual(usage.body.errors, ['usage allows view'], 'no action a page does not have');
        roleId = role.id;
        assert.equal((await call(sup, 'POST', '/api/admin/roles', { name: 'support', permissions: { leads: ['view'] } })).status, 409);
    });

    it('adds staff who sign in with only their role\'s pages', async () => {
        const added = await call(sup, 'POST', '/api/admin/staff',
            { name: 'Priya', email: 'priya@staff.test', password: 'Staff-pass-1', roleId });
        assert.equal(added.status, 200);
        assert.equal(added.body.mail.sent, false, 'the sign-in is emailed when mail is set up; the page shows it either way');
        staffId = added.body.staff.find((u) => u.email === 'priya@staff.test').id;
        token = (await call(null, 'POST', '/api/auth/login', { email: 'priya@staff.test', password: 'Staff-pass-1' })).body.token;
        assert.ok(token);
        assert.deepEqual(Object.keys((await call(token, 'GET', '/api/auth/me')).body.user.access), ['leads', 'referrals']);

        assert.equal((await call(token, 'GET', '/api/admin/leads')).status, 200);
        assert.equal((await call(token, 'GET', '/api/admin/referrals')).status, 200);
        assert.equal((await call(token, 'GET', '/api/admin/tenants')).status, 200, 'the list of names is shared');
        assert.equal((await call(token, 'GET', '/api/admin/billing/plans')).status, 403);
        assert.equal(staffMayOpen({ tenants: ['view', 'edit'] }, 'GET', '/billing/plans'), true, 'a business shows its plan');
        assert.equal(staffMayOpen({ tenants: ['view', 'edit'] }, 'PUT', '/billing/plans/starter'), false, 'but only Plans changes it');
        assert.equal((await call(token, 'POST', '/api/admin/tenants', { name: 'X', slug: 'x' })).status, 403);
        assert.equal((await call(token, 'GET', '/api/admin/staff')).status, 403, 'Settings is the full admin\'s');
        assert.equal((await call(token, 'POST', '/api/admin/roles', { name: 'Mine', permissions: { plans: ['view'] } })).status, 403);
        // Referrals: may add a marketer, not change one.
        const ravi = await call(token, 'POST', '/api/admin/referrals', { name: 'Ravi' });
        assert.equal(ravi.status, 201);
        const changed = await call(token, 'PUT', `/api/admin/referrals/${ravi.body.referrer.id}`, { name: 'Ravi K' });
        assert.equal(changed.status, 403);
        assert.deepEqual(changed.body.errors, ['Your role cannot do this.']);
        const tenant = await call(token, 'GET', '/api/contacts', undefined);
        assert.equal(tenant.status, 403, 'no Tenants, no business workspace');
    });

    it('follows a role change at once, and keeps a role in use', async () => {
        await call(sup, 'PUT', `/api/admin/roles/${roleId}`, { name: 'Support', permissions: { plans: ['view'] } });
        assert.equal((await call(token, 'GET', '/api/admin/leads')).status, 403);
        assert.equal((await call(token, 'GET', '/api/admin/billing/plans')).status, 200);
        assert.equal((await call(token, 'DELETE', '/api/admin/billing/plans/starter')).status, 403, 'view only');
        assert.equal((await call(sup, 'DELETE', `/api/admin/roles/${roleId}`)).status, 409);
    });

    it('never manages a full super admin as staff, and removes staff', async () => {
        const full = (await call(sup, 'GET', '/api/admin/staff')).body.staff.find((u) => !u.adminRoleId);
        assert.equal((await call(sup, 'PUT', `/api/admin/staff/${full.id}`, { roleId })).status, 404);
        assert.equal((await call(sup, 'DELETE', `/api/admin/staff/${full.id}`)).status, 404);

        assert.equal((await call(sup, 'DELETE', `/api/admin/staff/${staffId}`)).status, 200);
        assert.equal((await call(token, 'GET', '/api/auth/me')).status, 401);
        assert.equal((await call(sup, 'DELETE', `/api/admin/roles/${roleId}`)).status, 200);
    });
});
