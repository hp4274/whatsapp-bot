/** Super-admin school pack: catalogue and one-click tenant provisioning. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-school-admin-'));
let app;
let server;
let base;
let db;
let plain;
const tokens = {};

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
    db = new Database(path.join(tmp, 's.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    plain = app.locals.tenancy.createTenant('No School', 'no-school', { services: ['contacts'] });
    tokens.superAdmin = sessionFor(app, { role: 'super_admin' });
    tokens.owner = sessionFor(app, { tenantId: 1, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('school pack admin', () => {
    it('serves the catalogue', async () => {
        const { status, body } = await call(tokens.superAdmin, 'GET', '/api/admin/school/catalog');
        assert.equal(status, 200);
        assert.ok(body.recipes.some((r) => r.key === 'fee_payment_receipt'));
        assert.ok(body.recipes.every((r) => r.key && r.name && r.description));
        assert.ok(body.templates.some((t) => t.name === 'school_fee_due' && t.body));
        assert.ok(body.studentColumns.includes('Roll No'));
    });

    it('provisions templates and workflows, then skips on repeat', async () => {
        const first = await call(tokens.superAdmin, 'POST', '/api/admin/tenants/1/school/provision', {});
        assert.equal(first.status, 201);
        assert.ok(first.body.templates.includes('school_late_alert'));
        assert.ok(first.body.workflows.length >= 5);
        assert.deepEqual(first.body.skipped, []);

        const again = await call(tokens.superAdmin, 'POST', '/api/admin/tenants/1/school/provision', {});
        assert.deepEqual(again.body.workflows, []);
        assert.deepEqual(again.body.templates, []);
        assert.ok(again.body.skipped.includes('late_arrival_alert'));
    });

    it('rejects unknown tenants, missing service, and non-super-admins', async () => {
        assert.equal((await call(tokens.superAdmin, 'POST', '/api/admin/tenants/999/school/provision', {})).status, 404);
        assert.equal((await call(tokens.superAdmin, 'POST', `/api/admin/tenants/${plain.id}/school/provision`, {})).status, 409);
        assert.equal((await call(tokens.owner, 'POST', '/api/admin/tenants/1/school/provision', {})).status, 403);
        assert.equal((await call(tokens.owner, 'GET', '/api/admin/school/catalog')).status, 403);
    });
});
