/** A business asks for more of its limits for a while; the platform admin approves or declines; it goes back after. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-limitreq-'));
let db;
let app;
let server;
let base;
let sup;
let owner;
let agent;
let tenantId;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};
const limits = async () => (await call(sup, 'GET', '/api/admin/tenants')).body.tenants.find((t) => t.id === tenantId).limits;

before(async () => {
    db = new Database(path.join(tmp, 'req.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    sup = sessionFor(app, { role: 'super_admin' });
    const made = await call(sup, 'POST', '/api/admin/tenants', {
        name: 'Ask Shop', planKey: 'starter', trialDays: 0, owner: { email: 'owner@ask.test', password: 'password123' },
    });
    tenantId = made.body.tenant.id;
    owner = sessionFor(app, { tenantId, role: 'owner' });
    agent = sessionFor(app, { tenantId, role: 'agent' });
});

after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await closeApp(app);
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('limit increase requests', () => {
    let id;

    it('lets an owner ask for several limits at once, checked; not an agent', async () => {
        const page = await call(owner, 'GET', '/api/limit-requests');
        assert.equal(page.status, 200);
        assert.equal(page.body.limits.find((l) => l.key === 'maxTemplates').now, 50, "Starter's templates");
        assert.equal((await call(agent, 'POST', '/api/limit-requests', { items: [{ key: 'maxTemplates', value: 80, days: 30 }] })).status, 403);
        assert.equal((await call(owner, 'POST', '/api/limit-requests', { items: [] })).status, 400);
        assert.equal((await call(owner, 'POST', '/api/limit-requests', { items: [{ key: 'maxTemplates', value: 80, days: 12 }] })).status, 400);
        assert.equal((await call(owner, 'POST', '/api/limit-requests', {
            items: [{ key: 'maxTemplates', value: 80, days: 30 }, { key: 'maxTemplates', value: 90, days: 7 }],
        })).status, 400, 'one ask per limit');
        const made = await call(owner, 'POST', '/api/limit-requests', {
            items: [
                { key: 'maxTemplates', value: 80, days: 30 },
                { key: 'messagesPerMonth', value: 5000, days: 7 },
                { key: 'dailyLimit', value: 400, days: 0 },
            ],
            note: 'Diwali campaign',
        });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        assert.equal(made.body.request.status, 'pending');
        id = made.body.request.id;
        const listed = (await call(sup, 'GET', `/api/admin/tenants/${tenantId}/limit-requests`)).body.requests;
        assert.equal(listed[0].note, 'Diwali campaign');
        assert.equal(listed[0].items[0].label, 'Templates');
    });

    it('applies every ask on approval, and puts the timed ones back when their time is up', async () => {
        const ok = await call(sup, 'POST', `/api/admin/tenants/${tenantId}/limit-requests/${id}/approve`, { reason: 'Fine' });
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.request.status, 'approved');
        let now = await limits();
        assert.equal(now.maxTemplates, 80);
        assert.equal(now.messagesPerMonth, 5000);
        const safety = (await call(sup, 'GET', `/api/admin/tenants/${tenantId}/safety`)).body.safety;
        assert.equal(safety.dailyLimit, 400);
        assert.equal((await call(sup, 'POST', `/api/admin/tenants/${tenantId}/limit-requests/${id}/decline`)).status, 409, 'answered once');
        const log = (await call(sup, 'GET', `/api/admin/audit-logs?tenant=${tenantId}&actions=limits.approve`)).body.logs[0];
        assert.match(log.summary, /Approved more for Ask Shop: templates to 80 for 30 days/);
        // The search matches the sentence an admin reads, not only the raw action.
        const found = (await call(sup, 'GET', `/api/admin/audit-logs?tenant=${tenantId}&q=approved more`)).body.logs;
        assert.deepEqual(found.map((l) => l.action), ['limits.approve']);

        // 8 days on: the 7-day messages go back to the plan's; the 30-day templates stay.
        assert.equal(app.locals.expireLimitRequests(new Date(Date.now() + 8 * 864e5)), 1);
        now = await limits();
        assert.ok(!('messagesPerMonth' in now), "back to the plan's quota");
        assert.equal(now.maxTemplates, 80);
        // An admin changed templates since: the expiry leaves the admin's value.
        await call(sup, 'PUT', `/api/admin/tenants/${tenantId}/limits`, { maxTemplates: 120 });
        assert.equal(app.locals.expireLimitRequests(new Date(Date.now() + 31 * 864e5)), 1);
        assert.equal((await limits()).maxTemplates, 120);
        // "Until changed" never goes back.
        assert.equal(app.locals.expireLimitRequests(new Date(Date.now() + 999 * 864e5)), 0);
    });

    it('changes nothing on a decline', async () => {
        const made = await call(owner, 'POST', '/api/limit-requests', { items: [{ key: 'maxUsers', value: 9, days: 30 }] });
        const before = await limits();
        const no = await call(sup, 'POST', `/api/admin/tenants/${tenantId}/limit-requests/${made.body.request.id}/decline`, { reason: 'Not now' });
        assert.equal(no.body.request.status, 'declined');
        assert.equal(no.body.request.reason, 'Not now');
        assert.deepEqual(await limits(), before);
    });
    it('shows what waits on the admin in the bell, until it is answered', async () => {
        const made = await call(owner, 'POST', '/api/limit-requests', { items: [{ key: 'maxChannels', value: 4, days: 7 }] });
        let bell = (await call(sup, 'GET', '/api/admin/notifications')).body;
        const mine = bell.limitRequests.find((r) => r.id === made.body.request.id);
        assert.equal(mine.tenantName, 'Ask Shop');
        assert.equal(mine.items[0].label, 'WhatsApp numbers');
        assert.equal(bell.count, bell.leads.length + bell.limitRequests.length);
        await call(sup, 'POST', `/api/admin/tenants/${tenantId}/limit-requests/${made.body.request.id}/decline`);
        bell = (await call(sup, 'GET', '/api/admin/notifications')).body;
        assert.ok(!bell.limitRequests.some((r) => r.id === made.body.request.id));
    });
});
