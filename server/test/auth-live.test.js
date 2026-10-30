/**
 * A session ends everywhere at once. An open event stream carries inbound messages, so a user who is disabled or
 * signed out must lose it now, not when their tab closes. Also: a suspended business is told so (and never locked
 * out for it), and a disabled user does not hold a seat.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { createTestApp, sessionFor } from './helpers.js';

describe('sessions end everywhere at once', () => {
    let app;
    let server;
    let base;
    before(async () => {
        app = createTestApp();
        server = app.listen(0, '127.0.0.1');
        await new Promise((r) => server.once('listening', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(async () => {
        await closeApp(app);
        server?.closeAllConnections?.();
        server?.close();
    });

    it('a disabled user\'s open event stream is closed by the next prune', async () => {
        const tenancy = app.locals.tenancy;
        const token = sessionFor(app, { role: 'agent' });
        const userId = tenancy.resolveSession(token).id;
        const res = await fetch(`${base}/api/events?token=${token}`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(res.status, 200);
        const reader = res.body.getReader();
        await reader.read(); // the hello

        tenancy.setUserDisabled(1, userId, true);
        assert.equal(tenancy.sessionValid(token), false);
        app.locals.pruneRevokedStreams();
        const ended = await Promise.race([
            (async () => {
                for (;;) {
                    const { done } = await reader.read();
                    if (done) return true;
                }
            })(),
            new Promise((r) => setTimeout(() => r(false), 2000)),
        ]);
        assert.equal(ended, true, 'the server ended the stream');
    });

    it('sessionValid never extends an idle session', () => {
        const tenancy = app.locals.tenancy;
        const token = sessionFor(app, { role: 'agent' });
        const before = tenancy.db.prepare('SELECT last_seen_at FROM sessions').all().map((r) => r.last_seen_at).join();
        for (let i = 0; i < 5; i++) tenancy.sessionValid(token, Date.now() + 3_600_000);
        const after = tenancy.db.prepare('SELECT last_seen_at FROM sessions').all().map((r) => r.last_seen_at).join();
        assert.equal(after, before);
    });

    it('a suspended business gets a plain 403 and the right password never counts toward a lockout', async () => {
        const tenancy = app.locals.tenancy;
        const tenant = tenancy.createTenant('Paused Co', 'paused-co');
        await tenancy.createUser({ tenantId: tenant.id, email: 'owner@paused.test', password: 'Right-Pass-123', role: 'owner' });
        tenancy.setTenantStatus(tenant.id, 'suspended');
        const login = () => fetch(`${base}/api/auth/login`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer none' },
            body: JSON.stringify({ email: 'owner@paused.test', password: 'Right-Pass-123' }),
        });
        for (let i = 0; i < 7; i++) {
            const res = await login();
            assert.equal(res.status, 403, `attempt ${i + 1}`);
            assert.match((await res.json()).errors[0], /suspended/);
        }
        tenancy.setTenantStatus(tenant.id, 'active');
        assert.equal((await login()).status, 200, 'never locked out by the refused attempts');
    });

    it('a disabled user frees their seat, and turning them back on needs one', async () => {
        const tenancy = app.locals.tenancy;
        const tenant = tenancy.createTenant('Seats Co', 'seats-co');
        tenancy.db.prepare('UPDATE tenants SET limits = ? WHERE id = ?').run(JSON.stringify({ maxUsers: 2 }), tenant.id);
        const owner = sessionFor(app, { tenantId: tenant.id, role: 'owner' });
        const call = (method, path, body) => fetch(`${base}/api${path}`, {
            method, headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
            body: JSON.stringify(body),
        });
        const first = await call('POST', '/users', { email: 'a1@seats.test', password: 'Agent-Pass-123', role: 'agent' });
        assert.equal(first.status, 201);
        const agent = (await first.json()).user;
        assert.equal((await call('POST', '/users', { email: 'a2@seats.test', password: 'Agent-Pass-123', role: 'agent' })).status, 403, 'full');

        assert.equal((await call('PATCH', `/users/${agent.id}`, { disabled: true })).status, 200);
        assert.equal((await call('POST', '/users', { email: 'a2@seats.test', password: 'Agent-Pass-123', role: 'agent' })).status, 201, 'the seat came back');
        assert.equal((await call('PATCH', `/users/${agent.id}`, { disabled: false })).status, 403, 'no seat to come back to');
    });
});
