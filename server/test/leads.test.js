/** Account requests: the public form, the sign-in hint for an unknown email, and converting a lead into a tenant. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { Leads } from '../src/leads.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-leads-'));
let db;
let app;
let server;
let base;
let sup;
/** A stand-in mailer: what would have been emailed, in order. */
const outbox = [];
const mailer = { configured: true, notifyTo: 'team@wapzo.test', send: async (mail) => { outbox.push(mail); return { sent: true }; } };

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

before(async () => {
    db = new Database(path.join(tmp, 'leads.db'));
    app = createTestApp({
        db, dataDir: tmp, mailer, publicBaseUrl: 'https://app.wapzo.test',
        config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 },
    });
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

describe('leads', () => {
    it('takes a request from the public form, validates it and keeps one open request per email', async () => {
        assert.equal((await call(null, 'POST', '/api/leads', { name: 'Asha', business: '', email: 'a@b.co' })).status, 400);
        assert.equal((await call(null, 'POST', '/api/leads', { name: 'Asha', business: 'Shop', email: 'nope' })).status, 400);
        const lead = { name: 'Asha', business: 'Asha <Sarees>', email: 'Asha@Shop.test', phone: '+91 98765 43210', message: 'Hi' };
        outbox.length = 0;
        assert.equal((await call(null, 'POST', '/api/leads', lead)).status, 201);
        // A confirmation to the visitor and an alert to the team, which replies straight to the visitor.
        assert.deepEqual(outbox.map((m) => m.to), ['asha@shop.test', 'team@wapzo.test']);
        assert.equal(outbox[1].replyTo, 'asha@shop.test');
        assert.ok(outbox[1].html.includes('https://app.wapzo.test/admin/leads'));
        assert.ok(outbox[0].html.includes('Asha &lt;Sarees&gt;') && !outbox[0].html.includes('<Sarees>'), 'what a visitor typed is escaped');
        assert.ok(outbox[0].text.includes('Asha <Sarees>'));
        assert.equal((await call(null, 'POST', '/api/leads', { ...lead, message: 'again', source: 'login' })).status, 201);
        // A bot filling the hidden box is answered the same and nothing is kept.
        assert.equal((await call(null, 'POST', '/api/leads', { ...lead, email: 'bot@x.test', website: 'x' })).status, 201);
        // Five requests a burst from one address, then one a minute.
        assert.equal((await call(null, 'POST', '/api/leads', lead)).status, 429);
        const { body } = await call(sup, 'GET', '/api/admin/leads');
        assert.equal(body.leads.length, 1);
        assert.equal(body.leads[0].email, 'asha@shop.test');
        assert.equal(body.leads[0].message, 'again');
        assert.equal(body.leads[0].business, 'Asha <Sarees>');
        assert.equal(body.leads[0].source, 'login');
        assert.equal(body.counts.new, 1);
        const owner = sessionFor(app, { tenantId: 1, role: 'owner' });
        assert.equal((await call(owner, 'GET', '/api/admin/leads')).status, 403);
    });

    it('tells the sign-in page when an email has no account', async () => {
        const unknown = await call(null, 'POST', '/api/auth/login', { email: 'nobody@x.test', password: 'whatever1' });
        assert.equal(unknown.status, 401);
        assert.equal(unknown.body.signup, true);
    });

    it('converts a lead into a tenant on the chosen plan with its payment, once', async () => {
        const [lead] = (await call(sup, 'GET', '/api/admin/leads')).body.leads;
        const url = `/api/admin/leads/${lead.id}/convert`;
        assert.equal((await call(sup, 'POST', url, { slug: 'asha' })).status, 400, 'a plan is required');
        assert.equal((await call(sup, 'POST', url, {
            slug: 'asha', planKey: 'starter', payment: 'sometimes', owner: { password: 'password123' },
        })).status, 400, 'an unknown payment creates nothing');
        const res = await call(sup, 'POST', url, {
            slug: 'asha', planKey: 'business', payment: 'free', trialDays: 0, owner: { password: 'password123' },
        });
        assert.equal(res.status, 201, JSON.stringify(res.body));
        assert.equal(res.body.tenant.name, 'Asha <Sarees>');
        // The owner gets their sign-in details by email.
        assert.equal(res.body.email.sent, true);
        const welcome = outbox.at(-1);
        assert.equal(welcome.to, 'asha@shop.test');
        assert.ok(welcome.html.includes('password123') && welcome.html.includes('https://app.wapzo.test/login'));
        assert.equal(res.body.tenant.subscription.planKey, 'business');
        assert.equal(res.body.tenant.subscription.payment, 'free');
        assert.equal(res.body.owner.email, 'asha@shop.test');
        assert.equal(res.body.lead.status, 'converted');
        assert.equal(res.body.lead.tenantId, res.body.tenant.id);
        assert.equal((await call(sup, 'POST', url, { planKey: 'business' })).status, 409);
        assert.equal((await call(sup, 'PATCH', `/api/admin/leads/${lead.id}`, { status: 'dismissed' })).status, 409);

        // The new owner signs in, and a wrong password on a real account is no "sign up" hint.
        const ok = await call(null, 'POST', '/api/auth/login', { email: 'asha@shop.test', password: 'password123' });
        assert.equal(ok.status, 200);
        const wrong = await call(null, 'POST', '/api/auth/login', { email: 'asha@shop.test', password: 'wrong-one' });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body.signup, undefined);

        // Payment is changed with the plan, and kept when only the plan changes.
        const tenantUrl = `/api/admin/tenants/${res.body.tenant.id}/subscription`;
        const put = await call(sup, 'PUT', tenantUrl, { planKey: 'starter', payment: 'paid' });
        assert.equal(put.body.tenant.subscription.payment, 'paid');
        const again = await call(sup, 'PUT', tenantUrl, { planKey: 'business' });
        assert.equal(again.body.tenant.subscription.payment, 'paid');
        // Payment alone leaves the plan and its period as they were.
        const paymentUrl = `/api/admin/tenants/${res.body.tenant.id}/payment`;
        const alone = await call(sup, 'PUT', paymentUrl, { payment: 'unpaid' });
        assert.equal(alone.body.subscription.payment, 'unpaid');
        assert.equal(alone.body.subscription.planKey, 'business');
        assert.equal(alone.body.subscription.startsAt, again.body.subscription.startsAt);
        assert.equal((await call(sup, 'PUT', paymentUrl, { payment: 'later' })).status, 400);
    });

    it('dismisses and reopens a lead', async () => {
        new Leads(db).create({ name: 'Ravi', business: 'Ravi Tutors', email: 'ravi@t.test' });
        const lead = (await call(sup, 'GET', '/api/admin/leads?status=new')).body.leads[0];
        const patch = (status) => call(sup, 'PATCH', `/api/admin/leads/${lead.id}`, { status });
        assert.equal((await patch('dismissed')).body.lead.status, 'dismissed');
        assert.equal((await call(sup, 'GET', '/api/admin/leads?status=dismissed')).body.leads.length, 1);
        assert.equal((await patch('new')).body.lead.status, 'new');
        // Unticking "email the sign-in details" sends nothing.
        const before = outbox.length;
        const quiet = await call(sup, 'POST', `/api/admin/leads/${lead.id}/convert`, {
            slug: 'ravi', planKey: 'starter', sendWelcome: false, owner: { password: 'password123' },
        });
        assert.equal(quiet.status, 201);
        assert.equal(quiet.body.email.sent, false);
        assert.equal(outbox.length, before);
    });
});
