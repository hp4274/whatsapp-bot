/** Super-admin demo seeder: only enabled services, idempotent, never sends. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-seed-'));
let app;
let server;
let base;
let db;
let shop;
let school;
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
const count = (sql, ...args) => db.db.prepare(sql).get(...args).n;
const objects = (tenantId, type) => count('SELECT COUNT(*) AS n FROM business_objects WHERE tenant_id = ? AND type = ?', tenantId, type);

before(async () => {
    db = new Database(path.join(tmp, 's.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    shop = app.locals.tenancy.createTenant('Demo Shop', 'demo-shop', { services: ['contacts', 'templates', 'orders', 'workflows'] });
    school = app.locals.tenancy.createTenant('Sunrise School', 'sunrise', {
        services: ['school_whatsapp_bot', 'contacts', 'tickets', 'faq', 'inbox', 'auto_replies', 'campaigns', 'appointments',
            'leads', 'subscriptions', 'events', 'payment_reminders', 'workflows', 'templates'],
    });
    tokens.superAdmin = sessionFor(app, { role: 'super_admin' });
    tokens.owner = sessionFor(app, { tenantId: shop.id, role: 'owner' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('demo seeder', () => {
    it('seeds only the enabled services, and a second run adds nothing', async () => {
        const first = await call(tokens.superAdmin, 'POST', `/api/admin/tenants/${shop.id}/seed`, {});
        assert.equal(first.status, 200);
        const { created } = first.body;
        assert.equal(created.contacts, 15);
        assert.equal(created.segments, 2);
        assert.equal(created.templates, 5);
        assert.equal(created.orders, 6);
        assert.equal(created.workflows, 3);
        for (const key of ['tickets', 'faqItems', 'appointments', 'students', 'inboundMessages', 'campaigns']) {
            assert.equal(created[key], undefined, key);
        }
        assert.equal(objects(shop.id, 'order'), 6);
        assert.equal(objects(shop.id, 'appointment'), 0);
        assert.equal(count('SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ?', shop.id), 0);
        assert.equal(count("SELECT COUNT(*) AS n FROM workflows WHERE tenant_id = ? AND status != 'draft'", shop.id), 0);

        const again = await call(tokens.superAdmin, 'POST', `/api/admin/tenants/${shop.id}/seed`, {});
        assert.equal(again.status, 200);
        assert.deepEqual(again.body.created, {});
        assert.ok(again.body.skipped.some((s) => s.startsWith('contacts: 15')));
        assert.equal(objects(shop.id, 'order'), 6);
        assert.equal(count('SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ?', shop.id), 15);
    });

    it('fills a school tenant without queueing a single message', async () => {
        const { status, body } = await call(tokens.superAdmin, 'POST', `/api/admin/tenants/${school.id}/seed`, {});
        assert.equal(status, 200);
        const c = body.created;
        assert.equal(c.students, 20);
        assert.equal(c.attendance, 100);
        assert.equal(c.timetable, 30);
        assert.equal(c.homework, 2);
        assert.equal(c.fees, 20);
        assert.equal(c.notices, 2);
        assert.equal(c.examResults, 8);
        assert.equal(c.tickets, 6);
        assert.equal(c.faqCategories, 2);
        assert.equal(c.faqItems, 8);
        assert.equal(c.conversations, 4);
        assert.ok(c.inboundMessages >= 8);
        assert.ok(c.autoReplies >= 3); // "hi" is a default rule already
        assert.equal(c.campaigns, 1);
        for (const key of ['appointments', 'leads', 'subscriptions', 'events', 'payments']) assert.equal(c[key], 6, key);
        const fees = db.db.prepare("SELECT DISTINCT status FROM business_objects WHERE tenant_id = ? AND type = 'fee'").all(school.id);
        assert.deepEqual(fees.map((r) => r.status).sort(), ['overdue', 'paid', 'pending']);
        assert.equal(count("SELECT COUNT(*) AS n FROM contacts WHERE tenant_id = ? AND tags LIKE '%class-10a%'", school.id), 8);

        const again = await call(tokens.superAdmin, 'POST', `/api/admin/tenants/${school.id}/seed`, {});
        assert.deepEqual(again.body.created, {});
        assert.equal(objects(school.id, 'attendance'), 100);

        assert.equal(count('SELECT COUNT(*) AS n FROM messages'), 0);
        assert.equal(count('SELECT COUNT(*) AS n FROM workflow_runs'), 0);
    });

    it('rejects unknown tenants and non-super-admins', async () => {
        assert.equal((await call(tokens.superAdmin, 'POST', '/api/admin/tenants/999/seed', {})).status, 404);
        assert.equal((await call(tokens.owner, 'POST', `/api/admin/tenants/${shop.id}/seed`, {})).status, 403);
        const logs = db.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'tenant.seed'").get().n;
        assert.equal(logs, 4);
    });
});
