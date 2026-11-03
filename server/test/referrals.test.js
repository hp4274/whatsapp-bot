/** Referrals: a marketer's code on a request, the business it becomes, and the commission each payment earns. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { commissionFor } from '../src/referrals.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-referrals-'));
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
const detail = async (id) => (await call(sup, 'GET', `/api/admin/referrals/${id}`)).body;

before(async () => {
    db = new Database(path.join(tmp, 'referrals.db'));
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

describe('referrals', () => {
    it('earns a percentage of a payment or a fixed amount', () => {
        assert.equal(commissionFor(1000, 'percent', 10), 100);
        assert.equal(commissionFor(5000, 'percent', 20), 1000);
        assert.equal(commissionFor(1000, 'fixed', 50), 50);
        assert.equal(commissionFor(10000, 'fixed', 50), 50);
        assert.equal(commissionFor(999, 'percent', 7.5), 75);
    });

    let ravi;
    let asha;
    let tenantId;
    let firstPayment;

    it('adds marketers with a code of their own or one made from the name', async () => {
        const made = await call(sup, 'POST', '/api/admin/referrals', { name: 'Ravi Kumar', commissionType: 'percent', commissionValue: 10 });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        ravi = made.body.referrer;
        assert.match(ravi.code, /^RAVIKUMA-\d+$/);
        const own = await call(sup, 'POST', '/api/admin/referrals', { name: 'Asha', code: 'asha-20', commissionType: 'fixed', commissionValue: 500 });
        asha = own.body.referrer;
        assert.equal(asha.code, 'ASHA-20');
        assert.equal((await call(sup, 'POST', '/api/admin/referrals', { name: 'X', code: 'ASHA-20' })).status, 409);
        assert.equal((await call(sup, 'POST', '/api/admin/referrals', { name: 'X', commissionType: 'percent', commissionValue: 150 })).status, 400);
        assert.equal((await call(sup, 'POST', '/api/admin/referrals', { name: 'X', commissionType: 'fixed', commissionValue: 2.5 })).status, 400);
    });

    it('ties the business a request became to the marketer whose link it came from', async () => {
        // An unknown code is dropped quietly: the visitor never sees an error for it.
        await call(null, 'POST', '/api/leads', { name: 'Nobody', business: 'Plain Shop', email: 'p@shop.test', phone: '98765 10000', ref: 'NOPE-1' });
        await call(null, 'POST', '/api/leads', { name: 'Meena', business: 'Meena Foods', email: 'm@foods.test', phone: '98765 20000', ref: ravi.code.toLowerCase() });
        const list = (await call(sup, 'GET', '/api/admin/leads')).body.leads;
        assert.equal(list.find((l) => l.email === 'p@shop.test').referralCode, '');
        const lead = list.find((l) => l.email === 'm@foods.test');
        assert.equal(lead.referralCode, ravi.code);
        tenantId = (await call(sup, 'POST', `/api/admin/leads/${lead.id}/convert`, {})).body.tenant.id;
        assert.deepEqual((await detail(ravi.id)).clients.map((c) => c.name), ['Meena Foods']);
        assert.equal((await call(sup, 'GET', `/api/admin/tenants/${tenantId}/referrer`)).body.referrer.id, ravi.id);
        // First one wins.
        const again = await call(sup, 'POST', `/api/admin/referrals/${asha.id}/clients`, { tenantId });
        assert.equal(again.status, 409);
    });

    it('earns on each payment at the rate of the day, and a rate change leaves earlier ones alone', async () => {
        const paid = await call(sup, 'POST', `/api/admin/tenants/${tenantId}/payments`, { amount: 1000, method: 'upi' });
        assert.equal(paid.status, 201, JSON.stringify(paid.body));
        firstPayment = paid.body.entry.id;
        await call(sup, 'PUT', `/api/admin/referrals/${ravi.id}`, { commissionType: 'fixed', commissionValue: 50 });
        await call(sup, 'POST', `/api/admin/tenants/${tenantId}/payments`, { amount: 10000, method: 'bank' });
        const { referrer, commissions } = await detail(ravi.id);
        assert.deepEqual(commissions.map((c) => [c.triggerAmount, c.commissionType, c.commissionValue, c.amount, c.status]), [
            [10000, 'fixed', 50, 50, 'pending'],
            [1000, 'percent', 10, 100, 'pending'],
        ]);
        assert.equal(commissions[0].tenantName, 'Meena Foods');
        assert.equal(referrer.pending, 150);
    });

    it('pays everything pending at once, and a payment removed after payout is taken back', async () => {
        const out = await call(sup, 'POST', `/api/admin/referrals/${ravi.id}/payout`, { reference: 'UPI-123' });
        assert.equal(out.status, 200);
        assert.equal(out.body.amount, 150);
        assert.deepEqual([out.body.referrer.pending, out.body.referrer.paid], [0, 150]);
        assert.equal((await call(sup, 'POST', `/api/admin/referrals/${ravi.id}/payout`, {})).status, 409);

        await call(sup, 'DELETE', `/api/admin/tenants/${tenantId}/payments/${firstPayment}`);
        const { referrer, commissions } = await detail(ravi.id);
        assert.deepEqual(commissions.slice(0, 2).map((c) => [c.amount, c.status]), [[-100, 'pending'], [50, 'paid']]);
        assert.equal(referrer.pending, -100);
        assert.equal(referrer.paid, 50);
    });

    it('a payment removed before payout just stops counting; a paused marketer earns nothing', async () => {
        const paid = await call(sup, 'POST', `/api/admin/tenants/${tenantId}/payments`, { amount: 300, method: 'cash' });
        assert.equal((await detail(ravi.id)).referrer.pending, -50);
        await call(sup, 'DELETE', `/api/admin/tenants/${tenantId}/payments/${paid.body.entry.id}`);
        assert.equal((await detail(ravi.id)).commissions[0].status, 'reversed');
        assert.equal((await detail(ravi.id)).referrer.pending, -100);

        await call(sup, 'PUT', `/api/admin/referrals/${ravi.id}`, { status: 'paused' });
        await call(sup, 'POST', `/api/admin/tenants/${tenantId}/payments`, { amount: 5000, method: 'upi' });
        assert.equal((await detail(ravi.id)).referrer.pending, -100);
        // Untied: later payments earn nothing either; earlier ones stay.
        await call(sup, 'PUT', `/api/admin/referrals/${ravi.id}`, { status: 'active' });
        await call(sup, 'DELETE', `/api/admin/referrals/${ravi.id}/clients/${tenantId}`);
        await call(sup, 'POST', `/api/admin/tenants/${tenantId}/payments`, { amount: 5000, method: 'upi' });
        const { clients, commissions } = await detail(ravi.id);
        assert.deepEqual([clients.length, commissions.length], [0, 4]);
        // Now free, it can go to another marketer.
        assert.equal((await call(sup, 'POST', `/api/admin/referrals/${asha.id}/clients`, { tenantId })).status, 201);
    });

    it('takes who brought a business as typed: a new name becomes a marketer, a known one is reused', async () => {
        const made = await call(sup, 'POST', '/api/admin/tenants', {
            name: 'Kiran Tutors', status: 'pending', contactPhone: '98765 30000', owner: { name: 'Kiran', email: 'kiran@t.test' }, referrer: 'Vijay Rao',
        });
        assert.equal(made.status, 201, JSON.stringify(made.body));
        const kiran = made.body.tenant.id;
        const referrerOf = async (id) => (await call(sup, 'GET', `/api/admin/tenants/${id}/referrer`)).body.referrer;
        const vijay = await referrerOf(kiran);
        assert.deepEqual([vijay.name, vijay.commissionType, vijay.commissionValue], ['Vijay Rao', 'percent', 10]);
        // Typed again, in any case, it is the same marketer.
        const second = await call(sup, 'POST', '/api/admin/tenants', {
            name: 'Lata Bakes', status: 'pending', contactPhone: '98765 40000', owner: { email: 'lata@b.test' }, referrer: 'vijay rao',
        });
        assert.equal((await referrerOf(second.body.tenant.id)).id, vijay.id);
        // The admin's answer, by name or code, replaces the one before; '' unties it.
        await call(sup, 'PUT', `/api/admin/tenants/${kiran}/details`, { referrer: 'ASHA-20' });
        assert.equal((await referrerOf(kiran)).name, 'Asha');
        await call(sup, 'PUT', `/api/admin/tenants/${kiran}/details`, { referrer: '' });
        assert.equal(await referrerOf(kiran), null);
        await call(sup, 'DELETE', `/api/admin/referrals/${vijay.id}/clients/${second.body.tenant.id}`);
    });

    it('lists marketers with their totals', async () => {
        const { referrers } = (await call(sup, 'GET', '/api/admin/referrals')).body;
        assert.deepEqual(referrers.map((r) => [r.code, r.clients, r.pending, r.paid]).slice(1), [
            ['ASHA-20', 1, 0, 0],
            [ravi.code, 0, -100, 50],
        ]);
    });
});
