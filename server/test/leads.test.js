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
        assert.throws(() => new Leads(db).create({ name: 'Asha', business: 'Shop', email: 'a@b.co' }), /WhatsApp number/, 'WhatsApp number is required');
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


    it('accepts a lead as a pending tenant that cannot sign in until activated', async () => {
        const [lead] = (await call(sup, 'GET', '/api/admin/leads')).body.leads;
        const url = `/api/admin/leads/${lead.id}/convert`;
        const res = await call(sup, 'POST', url, {});
        assert.equal(res.status, 201, JSON.stringify(res.body));
        const tenant = res.body.tenant;
        assert.equal(tenant.name, 'Asha <Sarees>');
        assert.equal(tenant.status, 'pending');
        assert.equal(tenant.slug, 'asha-sarees');
        assert.equal(tenant.subscription.planKey, 'starter', 'the first active plan until the admin picks one');
        assert.equal(tenant.subscription.payment, 'paid');
        assert.equal(tenant.contactPhone, '+91 98765 43210', "the lead's WhatsApp is the business's contact number");
        assert.equal(res.body.lead.status, 'converted');
        assert.equal(res.body.lead.tenantId, tenant.id);
        assert.equal((await call(sup, 'POST', url, {})).status, 409, 'once');
        assert.equal((await call(sup, 'PATCH', `/api/admin/leads/${lead.id}`, { status: 'dismissed' })).status, 409);
        // Tenant settings shows the request it came from.
        assert.equal((await call(sup, 'GET', `/api/admin/tenants/${tenant.id}/lead`)).body.lead.id, lead.id);

        // While pending the plan is not live, so nothing is charged, whatever plans are tried.
        await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'business' });
        const bill = async () => (await call(sup, 'GET', `/api/admin/tenants/${tenant.id}/payments`)).body;
        assert.deepEqual((await bill()).entries, []);

        // Pending: the owner's sign-in is refused with a "being set up" answer, and nothing was emailed yet.
        const mailsBefore = outbox.length;
        const early = await call(null, 'POST', '/api/auth/login', { email: 'asha@shop.test', password: 'password123' });
        assert.equal(early.status, 401, 'the password is still the random one');
        const activateUrl = `/api/admin/tenants/${tenant.id}/activate`;
        assert.equal((await call(sup, 'POST', activateUrl, { password: 'short' })).status, 400);
        assert.equal((await call(sup, 'GET', '/api/admin/tenants')).body.tenants.find((t) => t.id === tenant.id).status, 'pending',
            'a refused activation leaves it pending');

        // Activate: the owner gets the chosen password by email and can sign in.
        const on = await call(sup, 'POST', activateUrl, { password: 'password123' });
        assert.equal(on.status, 200, JSON.stringify(on.body));
        assert.equal(on.body.tenant.status, 'active');
        // Live from now: the plan's price is charged at once.
        assert.deepEqual((await bill()).entries.map((e) => [e.kind, e.amount]), [['plan', 2999]]);
        assert.equal(on.body.email.sent, true);
        assert.equal(outbox.length, mailsBefore + 1);
        const welcome = outbox.at(-1);
        assert.equal(welcome.to, 'asha@shop.test');
        assert.ok(welcome.html.includes('password123') && welcome.html.includes('https://app.wapzo.test/login'));
        assert.equal((await call(sup, 'POST', activateUrl, { password: 'password123' })).status, 409, 'only a pending one');
        const ok = await call(null, 'POST', '/api/auth/login', { email: 'asha@shop.test', password: 'password123' });
        assert.equal(ok.status, 200);
        const wrong = await call(null, 'POST', '/api/auth/login', { email: 'asha@shop.test', password: 'wrong-one' });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.body.signup, undefined, 'a wrong password on a real account is no "sign up" hint');

        // Payment is changed with the plan, and kept when only the plan changes.
        const tenantUrl = `/api/admin/tenants/${tenant.id}/subscription`;
        const put = await call(sup, 'PUT', tenantUrl, { planKey: 'starter', payment: 'paid' });
        // Account emails: the owner gets the plan confirmed and, below, a receipt; replies reach the team.
        const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
        await settle();
        const confirmed = outbox.at(-1);
        assert.equal(confirmed.to, 'asha@shop.test');
        assert.equal(confirmed.subject, 'Your Starter plan is confirmed');
        assert.equal(confirmed.replyTo, 'team@wapzo.test');
        assert.ok(confirmed.html.includes('Asha &lt;Sarees&gt;') && confirmed.text.includes('Renews on:'));
        const paid = await call(sup, 'POST', `/api/admin/tenants/${tenant.id}/payments`, { amount: 999, method: 'upi' });
        assert.equal(paid.status, 201, JSON.stringify(paid.body));
        await settle();
        assert.ok(outbox.at(-1).subject.startsWith('Payment received:') && outbox.at(-1).html.includes('receipt'));
        const ends = new Date(Date.now() + 10 * 864e5).toISOString();
        assert.equal((await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/validity`, { validUntil: ends })).status, 200);
        const sentBefore = outbox.length;
        app.locals.notifyPlanEnds(new Date(Date.now() + 11 * 864e5));
        await settle();
        app.locals.notifyPlanEnds(new Date(Date.now() + 11 * 864e5));
        await settle();
        assert.equal(outbox.filter((m) => m.subject.endsWith('has ended')).length, 1, 'the hourly check emails once');
        assert.equal(outbox.length, sentBefore + 1);
        assert.equal(put.body.tenant.subscription.payment, 'paid');
        const again = await call(sup, 'PUT', tenantUrl, { planKey: 'business' });
        assert.equal(again.body.tenant.subscription.payment, 'paid');
        // Payment alone leaves the plan and its period as they were.
        const paymentUrl = `/api/admin/tenants/${tenant.id}/payment`;
        const alone = await call(sup, 'PUT', paymentUrl, { payment: 'free' });
        assert.equal(alone.body.subscription.payment, 'free');
        assert.equal(alone.body.subscription.planKey, 'business');
        assert.equal(alone.body.subscription.startsAt, again.body.subscription.startsAt);
        assert.equal((await call(sup, 'PUT', paymentUrl, { payment: 'later' })).status, 400);
    });

    it('holds, dismisses and reopens a lead; a pending owner is told it is being set up', async () => {
        new Leads(db).create({ name: 'Ravi', business: 'Ravi Tutors', email: 'ravi@t.test', phone: '98765 43210' });
        const lead = (await call(sup, 'GET', '/api/admin/leads?status=new')).body.leads[0];
        const patch = (status) => call(sup, 'PATCH', `/api/admin/leads/${lead.id}`, { status });
        assert.equal((await patch('hold')).body.lead.status, 'hold');
        assert.equal((await call(sup, 'GET', '/api/admin/leads')).body.counts.hold, 1);
        // A second request from the same email while on hold refreshes it rather than adding another.
        new Leads(db).create({ name: 'Ravi', business: 'Ravi Tutors', email: 'ravi@t.test', phone: '98765 43210', message: 'still keen' });
        assert.equal((await call(sup, 'GET', '/api/admin/leads?status=hold')).body.leads[0].message, 'still keen');
        assert.equal((await patch('dismissed')).body.lead.status, 'dismissed');
        assert.equal((await patch('new')).body.lead.status, 'new');
        assert.equal((await patch('converted')).status, 400);

        // Accepting while the slug is taken picks the next free one.
        const res = await call(sup, 'POST', `/api/admin/leads/${lead.id}/convert`, { planKey: 'business' });
        assert.equal(res.status, 201);
        assert.equal(res.body.tenant.subscription.planKey, 'business');
        await app.locals.tenancy.setPassword(res.body.tenant.id,
            app.locals.tenancy.listUsers(res.body.tenant.id)[0].id, 'password123');
        const refused = await call(null, 'POST', '/api/auth/login', { email: 'ravi@t.test', password: 'password123' });
        assert.equal(refused.status, 403);
        assert.match(refused.body.errors[0], /being set up/);
        assert.equal(new Leads(db).forTenant(res.body.tenant.id).id, lead.id);
        assert.equal(app.locals.tenancy.freeSlug('Ravi Tutors'), 'ravi-tutors-2');
    });
});
