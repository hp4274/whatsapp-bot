/** Sign-in changes: your own (account dialog) and a member's (Team), and removing a member. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-team-'));
let db;
let app;
let server;
let base;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};

/** A real user with a known password, signed in. */
const member = async (role, email) => {
    const user = await app.locals.tenancy.createUser({ tenantId: 1, email, password: 'password123', role });
    return { user, token: app.locals.tenancy.createSession(user.id) };
};
const signIn = (email, password) => call(null, 'POST', '/api/auth/login', { email, password });

before(async () => {
    db = new Database(path.join(tmp, 'team.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sign-in changes', () => {
    it('lets anyone change their own password with the current one, and keeps that session', async () => {
        const agent = await member('agent', 'agent@team.test');
        const other = app.locals.tenancy.createSession(agent.user.id);
        assert.equal((await call(agent.token, 'PUT', '/api/account', { currentPassword: 'nope', password: 'newpass123' })).status, 403);
        const ok = await call(agent.token, 'PUT', '/api/account', { currentPassword: 'password123', password: 'newpass123' });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal((await signIn('agent@team.test', 'newpass123')).status, 200);
        assert.equal((await call(agent.token, 'GET', '/api/auth/me')).status, 200, 'the session that changed it stays');
        assert.equal((await call(other, 'GET', '/api/auth/me')).status, 401, 'other sessions end');
        // An agent's email is their admin's to change.
        const email = await call(agent.token, 'PUT', '/api/account', { currentPassword: 'newpass123', email: 'me@else.test' });
        assert.equal(email.status, 403);
    });

    it('lets an owner change their own email', async () => {
        const owner = await member('owner', 'owner@team.test');
        const res = await call(owner.token, 'PUT', '/api/account', { currentPassword: 'password123', email: 'Boss@Team.test' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.user.email, 'boss@team.test');
        assert.equal((await signIn('boss@team.test', 'password123')).status, 200);
    });

    it('lets an owner reset a member below them, not one at their level or themselves', async () => {
        const owner = await member('owner', 'owner2@team.test');
        const agent = await member('agent', 'agent2@team.test');
        const peer = await member('owner', 'owner3@team.test');
        const url = (u) => `/api/users/${u.user.id}/credentials`;
        const res = await call(owner.token, 'PUT', url(agent), { email: 'renamed@team.test', password: 'reset-pass-1' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal((await signIn('renamed@team.test', 'reset-pass-1')).status, 200);
        assert.equal((await call(agent.token, 'GET', '/api/auth/me')).status, 401, 'a reset signs the member out');
        assert.equal((await call(owner.token, 'PUT', url(peer), { password: 'reset-pass-1' })).status, 403);
        assert.equal((await call(owner.token, 'PUT', url(owner), { password: 'reset-pass-1' })).status, 400);
        assert.equal((await call(owner.token, 'PUT', url(agent), { email: 'owner3@team.test' })).status, 409);
        assert.equal((await call(agent.token, 'PUT', url(owner), { password: 'x'.repeat(9) })).status, 401);
    });

    it('removes a member: signed out, gone from the team, and the email free again', async () => {
        const owner = await member('owner', 'owner4@team.test');
        const agent = await member('agent', 'agent4@team.test');
        assert.equal((await call(owner.token, 'DELETE', `/api/users/${agent.user.id}`)).status, 200);
        assert.equal((await call(agent.token, 'GET', '/api/auth/me')).status, 401);
        assert.equal((await signIn('agent4@team.test', 'password123')).status, 401);
        const { body } = await call(owner.token, 'GET', '/api/users');
        assert.ok(!body.users.some((u) => u.id === agent.user.id));
        assert.equal((await call(owner.token, 'DELETE', `/api/users/${agent.user.id}`)).status, 404);
        assert.equal((await call(owner.token, 'POST', '/api/users', { email: 'agent4@team.test', password: 'password123', role: 'agent' })).status, 201);
    });
});
