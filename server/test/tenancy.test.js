/**
 * Tenant isolation, sign-in and roles.  Isolation is tested, not assumed:
 * every block below tries to reach one tenant's data as another.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tenancy-'));
let app;
let server;
let base;
let db;
let tenancy;
let tenantB;
const tokens = {};

const call = async (token, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(token ? { authorization: `Bearer ${token}` } : { authorization: '' }),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    // Most routes answer JSON, but the webhook verify handshake replies in plain text.
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text && json ? JSON.parse(text) : (text || null) };
};

before(async () => {
    db = new Database(path.join(tmp, 't.db'));
    app = createTestApp({
        db,
        dataDir: tmp,
        config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    tenancy = app.locals.tenancy;

    tenantB = tenancy.createTenant('Business B', 'biz-b');
    tokens.superAdmin = sessionFor(app, { role: 'super_admin' });
    tokens.ownerA = sessionFor(app, { tenantId: 1, role: 'owner' });
    tokens.agentA = sessionFor(app, { tenantId: 1, role: 'agent' });
    tokens.ownerB = sessionFor(app, { tenantId: tenantB.id, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sign-in', () => {
    it('refuses every tenant route without a session', async () => {
        for (const url of ['/api/config', '/api/history', '/api/inbox/conversations', '/api/auth/me']) {
            const { status } = await call(null, 'GET', url);
            assert.equal(status, 401, url);
        }
    });

    it('refuses a made-up token', async () => {
        assert.equal((await call('not-a-token', 'GET', '/api/history')).status, 401);
    });

    it('signs in with a password and rejects a wrong one', async () => {
        await tenancy.createUser({ tenantId: 1, email: 'Login@Test.dev', password: 'correct-horse', role: 'admin' });
        const bad = await call(null, 'POST', '/api/auth/login', { email: 'login@test.dev', password: 'nope' });
        assert.equal(bad.status, 401);
        const good = await call(null, 'POST', '/api/auth/login', { email: 'login@test.dev', password: 'correct-horse' });
        assert.equal(good.status, 200);
        assert.equal(good.body.user.role, 'admin');
        assert.equal(good.body.user.passwordHash, undefined, 'the hash never leaves the server');
        assert.equal((await call(good.body.token, 'GET', '/api/auth/me')).status, 200);
        await call(good.body.token, 'POST', '/api/auth/logout');
        assert.equal((await call(good.body.token, 'GET', '/api/auth/me')).status, 401, 'logout kills the session');
    });

    it('locks an account after repeated failures, even for the right password', async () => {
        await tenancy.createUser({ tenantId: 1, email: 'locked@test.dev', password: 'correct-horse', role: 'agent' });
        for (let i = 0; i < 5; i += 1) {
            await call(null, 'POST', '/api/auth/login', { email: 'locked@test.dev', password: 'bad' });
        }
        const { status } = await call(null, 'POST', '/api/auth/login',
            { email: 'locked@test.dev', password: 'correct-horse' });
        assert.equal(status, 429);
    });
});

describe('tenant isolation', () => {
    it('keeps auto-reply rules apart, including by guessed id', async () => {
        const made = await call(tokens.ownerA, 'POST', '/api/auto-replies',
            { keyword: 'secret-a', matchType: 'EXACT', replyBody: 'A only' });
        assert.equal(made.status, 201);
        const id = made.body.rule.id;

        const listB = await call(tokens.ownerB, 'GET', '/api/auto-replies');
        assert.ok(!listB.body.rules.some((r) => r.keyword === 'secret-a'));
        assert.equal((await call(tokens.ownerB, 'PUT', `/api/auto-replies/${id}`,
            { replyBody: 'hijacked' })).status, 404);
        assert.equal((await call(tokens.ownerB, 'DELETE', `/api/auto-replies/${id}`)).body.deleted, 0);

        const listA = await call(tokens.ownerA, 'GET', '/api/auto-replies');
        assert.equal(listA.body.rules.find((r) => r.id === id).replyBody, 'A only');
    });

    it('keeps message history, inbox and opt-outs apart', async () => {
        const dbA = db.forTenant(1);
        const dbB = db.forTenant(tenantB.id);
        dbA.insert({ messageId: 'msg-a', recipient: '919876543210', message: 'for A', status: 'SENT' });
        dbA.insertInbound({ messageId: 'in-a', sender: '919876543210', body: 'hello A' });
        dbA.addOptOut('919876543210', 'test');

        const history = await call(tokens.ownerB, 'GET', '/api/history');
        assert.deepEqual(history.body.records, []);
        assert.equal(dbB.get('msg-a'), null);
        assert.deepEqual((await call(tokens.ownerB, 'GET', '/api/inbox/conversations')).body.conversations, []);
        assert.deepEqual((await call(tokens.ownerB, 'GET', '/api/inbox/messages')).body.messages, []);
        assert.deepEqual((await call(tokens.ownerB, 'GET', '/api/optouts')).body.optouts, []);
        assert.equal(dbB.sentRecipients().size, 0, 'B may message a number A already messaged');

        assert.equal((await call(tokens.ownerA, 'GET', '/api/history')).body.records.length, 1);
        assert.equal((await call(tokens.ownerA, 'GET', '/api/optouts')).body.optouts.length, 1);
    });

    it('does not let one tenant mark or opt-out through another', async () => {
        assert.equal((await call(tokens.ownerB, 'POST', '/api/inbox/mark-read',
            { sender: '919876543210' })).body.updated, 0);
        assert.equal((await call(tokens.ownerB, 'DELETE', '/api/optouts/919876543210')).body.deleted, 0);
        assert.equal(db.forTenant(1).getAllOptOuts().length, 1);
    });

    it('gives every tenant its own config and connection', async () => {
        await call(tokens.ownerB, 'PUT', '/api/config', { defaultCountryCode: '44', transport: TRANSPORT_SANDBOX });
        assert.equal((await call(tokens.ownerB, 'GET', '/api/config')).body.config.defaultCountryCode, '44');
        assert.notEqual((await call(tokens.ownerA, 'GET', '/api/config')).body.config.defaultCountryCode, '44');

        await call(tokens.ownerB, 'POST', '/api/connection/connect');
        assert.equal((await call(tokens.ownerB, 'GET', '/api/connection')).body.connected, true);
        assert.equal((await call(tokens.ownerA, 'GET', '/api/connection')).body.connected, false,
            'A cannot send through B\'s connection');
        const send = await call(tokens.ownerA, 'POST', '/api/messages', { recipient: '+919876543210', message: 'x' });
        assert.equal(send.status, 409);
    });

    it('seeds a new tenant its own starter rules', async () => {
        const rules = (await call(tokens.ownerB, 'GET', '/api/auto-replies')).body.rules;
        assert.ok(rules.length > 0);
        assert.ok(!rules.some((r) => r.keyword === 'secret-a'));
    });
});

describe('roles', () => {
    it('lets an agent read and send but not change the account', async () => {
        assert.equal((await call(tokens.agentA, 'GET', '/api/history')).status, 200);
        assert.equal((await call(tokens.agentA, 'PUT', '/api/config', { dailyLimit: 5 })).status, 403);
        assert.equal((await call(tokens.agentA, 'POST', '/api/auto-replies',
            { keyword: 'x', matchType: 'EXACT', replyBody: 'y' })).status, 403);
        assert.equal((await call(tokens.agentA, 'POST', '/api/messages',
            { recipient: '+919876543210', message: 'hi' })).status, 409, 'allowed through; just not connected');
        assert.equal((await call(tokens.agentA, 'GET', '/api/users')).status, 403);
    });

    it('keeps platform routes for super admins', async () => {
        assert.equal((await call(tokens.ownerA, 'GET', '/api/admin/tenants')).status, 403);
        assert.equal((await call(tokens.ownerA, 'POST', '/api/admin/tenants',
            { name: 'x', owner: {} })).status, 403);
        assert.equal((await call(tokens.superAdmin, 'GET', '/api/admin/tenants')).body.tenants.length >= 2, true);
    });

    it('makes a super admin choose a tenant before touching tenant data', async () => {
        assert.equal((await call(tokens.superAdmin, 'GET', '/api/history')).status, 400);
        assert.equal((await call(tokens.superAdmin, 'GET', '/api/history', null,
            { 'x-tenant-id': String(tenantB.id) })).status, 200);
        assert.equal((await call(tokens.superAdmin, 'GET', '/api/history', null,
            { 'x-tenant-id': '9999' })).status, 400);
    });

    it('adds team members only below the adder\'s own role', async () => {
        const adminToken = sessionFor(app, { tenantId: 1, role: 'admin' });
        const asAdmin = await call(adminToken, 'POST', '/api/users',
            { email: 'owner2@test.dev', password: 'long-enough-1', role: 'owner' });
        assert.equal(asAdmin.status, 403);
        const agent = await call(adminToken, 'POST', '/api/users',
            { email: 'new-agent@test.dev', password: 'long-enough-1', role: 'agent' });
        assert.equal(agent.status, 201);

        const listB = await call(tokens.ownerB, 'GET', '/api/users');
        assert.ok(!listB.body.users.some((u) => u.email === 'new-agent@test.dev'), 'B cannot see A\'s team');
        assert.equal((await call(tokens.ownerB, 'PATCH', `/api/users/${agent.body.user.id}`,
            { disabled: true })).status, 404, 'B cannot disable A\'s user');
    });

    it('ends a disabled user\'s session straight away', async () => {
        const made = await call(tokens.ownerA, 'POST', '/api/users',
            { email: 'temp@test.dev', password: 'long-enough-1', role: 'agent' });
        const login = await call(null, 'POST', '/api/auth/login',
            { email: 'temp@test.dev', password: 'long-enough-1' });
        assert.equal((await call(login.body.token, 'GET', '/api/history')).status, 200);
        await call(tokens.ownerA, 'PATCH', `/api/users/${made.body.user.id}`, { disabled: true });
        assert.equal((await call(login.body.token, 'GET', '/api/history')).status, 401);
    });
});

describe('tenant lifecycle', () => {
    it('creates a tenant with its owner and records it in the audit log', async () => {
        const made = await call(tokens.superAdmin, 'POST', '/api/admin/tenants', {
            name: 'Clinic C', slug: 'clinic-c',
            services: ['contacts', 'campaigns', 'payment_reminders'],
            controls: { sendingEnabled: true, inboundEnabled: false },
            owner: { email: 'owner@clinic-c.dev', password: 'long-enough-1' },
        });
        assert.equal(made.status, 201);
        assert.equal(made.body.owner.role, 'owner');
        assert.deepEqual(made.body.tenant.services, ['contacts', 'campaigns', 'payment_reminders']);
        assert.equal(made.body.tenant.controls.inboundEnabled, false);
        const logs = await call(tokens.superAdmin, 'GET', '/api/admin/audit-logs');
        assert.ok(logs.body.logs.some((l) => l.action === 'tenant.create'));
        const dup = await call(tokens.superAdmin, 'POST', '/api/admin/tenants', {
            name: 'Clinic C', slug: 'clinic-c', owner: { email: 'x@clinic-c.dev', password: 'long-enough-1' },
        });
        assert.equal(dup.status, 409);
    });

    it('does not leave an orphan tenant when owner creation is invalid', async () => {
        const before = tenancy.listTenants().length;
        const bad = await call(tokens.superAdmin, 'POST', '/api/admin/tenants', {
            name: 'Broken Tenant', slug: 'broken-tenant',
            owner: { email: 'bad-owner@test.dev', password: 'short' },
        });
        assert.equal(bad.status, 400);
        assert.equal(tenancy.listTenants().length, before);
    });

    it('lets super admin edit services and operational controls', async () => {
        const made = await call(tokens.superAdmin, 'POST', '/api/admin/tenants', {
            name: 'Limited Tenant', slug: 'limited-tenant',
            services: ['contacts'],
            controls: { sendingEnabled: false, inboundEnabled: false },
            owner: { email: 'owner@limited-tenant.dev', password: 'long-enough-1' },
        });
        assert.equal(made.status, 201);
        const tenantId = made.body.tenant.id;
        const token = sessionFor(app, { tenantId, role: 'owner' });

        assert.equal((await call(token, 'GET', '/api/contacts')).status, 200);
        const blockedService = await call(token, 'GET', '/api/campaign/stats');
        assert.equal(blockedService.status, 403);
        assert.match(blockedService.body.errors[0], /campaigns is disabled/);

        const updated = await call(tokens.superAdmin, 'PATCH', `/api/admin/tenants/${tenantId}`, {
            services: ['contacts', 'bulk_messages'],
            controls: { sendingEnabled: false },
        });
        assert.equal(updated.status, 200);
        assert.ok(updated.body.tenant.services.includes('bulk_messages'));
        const blockedSend = await call(token, 'POST', '/api/messages', { recipient: '+919876543210', message: 'x' });
        assert.equal(blockedSend.status, 403);
        assert.match(blockedSend.body.errors[0], /sending is disabled/);
        assert.equal((await call(null, 'GET', `/api/webhook/${tenantId}`)).status, 404);
    });

    it('gates object types by their singular router path, case-insensitively', async () => {
        const shop = tenancy.createTenant('Shop Gate', 'shop-gate', { services: ['orders'] });
        const token = sessionFor(app, { tenantId: shop.id, role: 'owner' });
        assert.equal((await call(token, 'GET', '/api/objects/order')).status, 200);
        for (const url of ['/api/objects/lead', '/api/objects/LEAD', '/api/objects/appointment/1', '/api/api-keys', '/api/recipes']) {
            assert.equal((await call(token, 'GET', url)).status, 403, url);
        }
        assert.match((await call(token, 'GET', '/api/objects/lead')).body.errors[0], /leads is disabled/);
    });

    it('locks a suspended tenant out immediately, and its webhook goes dark', async () => {
        const victim = tenancy.createTenant('Suspend Me', 'suspend-me');
        const token = sessionFor(app, { tenantId: victim.id, role: 'owner' });
        assert.equal((await call(token, 'GET', '/api/history')).status, 200);
        assert.equal((await call(null, 'GET', `/api/webhook/${victim.id}`)).status, 403,
            'live tenant: verification runs (and fails without the token)');

        const res = await call(tokens.superAdmin, 'PATCH', `/api/admin/tenants/${victim.id}`, { status: 'suspended' });
        assert.equal(res.body.tenant.status, 'suspended');
        assert.equal((await call(token, 'GET', '/api/history')).status, 401);
        assert.equal((await call(null, 'GET', `/api/webhook/${victim.id}`)).status, 404);
    });

    it('archives a deleted tenant, hides it from admin lists, and kills sessions', async () => {
        const victim = tenancy.createTenant('Delete Me', 'delete-me');
        const token = sessionFor(app, { tenantId: victim.id, role: 'owner' });
        assert.equal((await call(token, 'GET', '/api/history')).status, 200);

        const deleted = await call(tokens.superAdmin, 'DELETE', `/api/admin/tenants/${victim.id}`);
        assert.equal(deleted.status, 200);
        assert.equal(deleted.body.deleted, 1);
        assert.equal(deleted.body.tenant.status, 'archived');
        assert.equal(tenancy.getTenant(victim.id).status, 'archived');
        assert.ok(!tenancy.listTenants().some((tenant) => tenant.id === victim.id));
        assert.ok(tenancy.listTenants({ includeArchived: true }).some((tenant) => tenant.id === victim.id));
        assert.equal((await call(token, 'GET', '/api/history')).status, 401);

        const listed = await call(tokens.superAdmin, 'GET', '/api/admin/tenants');
        assert.ok(!listed.body.tenants.some((tenant) => tenant.id === victim.id));
        assert.equal((await call(tokens.superAdmin, 'DELETE', '/api/admin/tenants/9999')).status, 404);
    });

    it('lets only the platform admin set anti-ban limits, and they beat tenant config', async () => {
        const made = tenancy.createTenant('Paced', 'paced');
        const owner = sessionFor(app, { tenantId: made.id, role: 'owner' });
        const url = `/api/admin/tenants/${made.id}/safety`;

        assert.equal((await call(owner, 'PUT', url, { dailyLimit: 5 })).status, 403);
        assert.equal((await call(tokens.superAdmin, 'PUT', url, { dailyLimit: -1 })).status, 400);
        assert.equal((await call(tokens.superAdmin, 'PUT', url, { minDelaySeconds: 30, maxDelaySeconds: 10 })).status, 400);
        const set = await call(tokens.superAdmin, 'PUT', url, { dailyLimit: 5, minDelaySeconds: 20 });
        assert.equal(set.body.safety.dailyLimit, 5);
        assert.equal(set.body.safety.restEvery, DEFAULTS.restEvery);

        await call(owner, 'PUT', '/api/config', { dailyLimit: 9999, minDelaySeconds: 0 });
        const cfg = await call(owner, 'GET', '/api/config');
        assert.equal(cfg.body.config.dailyLimit, 5);
        assert.equal(cfg.body.config.minDelaySeconds, 20);
    });

    it('audits tenant-side changes with the acting user', async () => {
        await call(tokens.ownerA, 'POST', '/api/auto-replies',
            { keyword: 'audited', matchType: 'EXACT', replyBody: 'ok' });
        const logs = tenancy.listAudit({ tenantId: 1 });
        assert.ok(logs.some((l) => l.action === 'POST /auto-replies' && l.userId !== null));
        assert.ok(!tenancy.listAudit({ tenantId: tenantB.id }).some((l) => l.action === 'POST /auto-replies'
            && l.detail === 'audited'));
    });
});

describe('moving a single-tenant database', () => {
    it('adopts existing rows into tenant 1 and keeps opt-outs and inbox intact', () => {
        const file = path.join(tmp, 'legacy.db');
        const old = new DatabaseSync(file);
        old.exec(`
            CREATE TABLE messages (message_id TEXT PRIMARY KEY, recipient TEXT NOT NULL, message TEXT NOT NULL,
                status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, provider_id TEXT, error TEXT,
                name TEXT DEFAULT '', campaign_id TEXT DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            CREATE TABLE inbound_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id TEXT UNIQUE,
                sender TEXT NOT NULL, sender_name TEXT DEFAULT '', body TEXT NOT NULL, media_url TEXT, media_type TEXT,
                replied_rule TEXT DEFAULT NULL, is_read INTEGER DEFAULT 0, received_at TEXT NOT NULL);
            CREATE INDEX idx_inbound_sender ON inbound_messages(sender);
            CREATE TABLE opt_outs (phone TEXT PRIMARY KEY, reason TEXT DEFAULT 'user_requested', opted_out_at TEXT NOT NULL);
            CREATE TABLE auto_replies (id INTEGER PRIMARY KEY AUTOINCREMENT, keyword TEXT NOT NULL, match_type TEXT NOT NULL,
                reply_body TEXT NOT NULL, is_active INTEGER DEFAULT 1, cooldown_sec INTEGER DEFAULT 300,
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
            INSERT INTO messages VALUES ('m1','919','hi','SENT',1,NULL,NULL,'','c','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
            INSERT INTO inbound_messages (message_id, sender, body, received_at) VALUES ('i1','919','yo','2026-01-01T00:00:00Z');
            INSERT INTO opt_outs VALUES ('919','stop','2026-01-01T00:00:00Z');
            INSERT INTO auto_replies (keyword, match_type, reply_body, created_at, updated_at)
                VALUES ('kept','EXACT','r','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
        `);
        old.close();

        const migrated = new Database(file);
        try {
            const mine = migrated.forTenant(1);
            assert.equal(mine.get('m1').recipient, '919');
            assert.equal(mine.getInboundMessages().length, 1);
            assert.deepEqual(mine.getAllOptOuts(), ['919']);
            assert.ok(mine.getAutoReplies().some((r) => r.keyword === 'kept'));
            const other = migrated.forTenant(2);
            assert.equal(other.get('m1'), null);
            assert.deepEqual(other.getAllOptOuts(), []);
            // the same number can opt out of two businesses independently
            other.addOptOut('919', 'other');
            assert.equal(mine.getOptOuts()[0].reason, 'stop');
        } finally {
            migrated.close();
        }
    });
});

describe('super admin password reset', () => {
    it('sets a tenant user password, signs them out, and is super-admin only', async () => {
        const { createTestApp: make, sessionFor: as } = await import('./helpers.js');
        const { closeApp: close } = await import('../src/app.js');
        const app = make();
        const server = app.listen(0);
        await new Promise((r) => server.once('listening', r));
        const base = `http://127.0.0.1:${server.address().port}`;
        const tenancy = app.locals.tenancy;
        const user = await tenancy.createUser({ tenantId: 1, email: 'reset@test.dev', password: 'old-password', role: 'agent' });
        const userToken = tenancy.createSession(user.id);
        const call = (token, url, body) => fetch(base + url, {
            method: body ? 'PUT' : 'GET',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: body && JSON.stringify(body),
        });
        const sup = as(app, { role: 'super_admin' });
        const list = await (await call(sup, '/api/admin/tenants/1/users')).json();
        assert.ok(list.users.some((u) => u.email === 'reset@test.dev'));
        assert.equal((await call(sup, `/api/admin/tenants/1/users/${user.id}/password`, { password: 'short' })).status, 400);
        assert.equal((await call(sup, `/api/admin/tenants/2/users/${user.id}/password`, { password: 'new-password' })).status, 404);
        assert.equal((await call(as(app), `/api/admin/tenants/1/users/${user.id}/password`, { password: 'new-password' })).status, 403);
        assert.equal((await call(sup, `/api/admin/tenants/1/users/${user.id}/password`, { password: 'new-password' })).status, 200);
        assert.equal(tenancy.resolveSession(userToken), null);
        assert.ok(await tenancy.authenticate('reset@test.dev', 'new-password'));
        server.close();
        await close(app);
    });
});
