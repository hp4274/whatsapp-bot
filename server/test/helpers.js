/**
 * Test plumbing: every request needs a signed-in user, so createTestApp hands
 * each listening app an owner session and a fetch that presents it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';

const tokens = new Map(); // origin -> bearer token
const realFetch = globalThis.fetch;

globalThis.fetch = (url, options = {}) => {
    const token = tokens.get(new URL(url).origin);
    const headers = new Headers(options.headers);
    if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
    return realFetch(url, { ...options, headers });
};

/** A signed-in session for a fresh user, without paying for a password hash. */
export function sessionFor(app, { tenantId = 1, role = 'owner', email } = {}) {
    const tenancy = app.locals.tenancy;
    const address = email ?? `${role}-${tenantId}-${Math.random().toString(36).slice(2)}@test.dev`;
    const info = tenancy.db.prepare(
        `INSERT INTO users (tenant_id, email, name, password_hash, role, created_at)
         VALUES (?, ?, '', 'x', ?, '2026-01-01T00:00:00Z')`)
        .run(role === 'super_admin' ? null : tenantId, address, role);
    return tenancy.createSession(Number(info.lastInsertRowid));
}

export function createTestApp(options = {}) {
    const app = createApp({
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-data-')),
        ...options,
    });
    const listen = app.listen.bind(app);
    app.listen = (...args) => {
        const server = listen(...args);
        server.once('listening', () => {
            tokens.set(`http://127.0.0.1:${server.address().port}`, sessionFor(app));
        });
        return server;
    };
    return app;
}
