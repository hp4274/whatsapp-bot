/** Wuzie's own WhatsApp number: linked on a hidden tenant, writing to clients on platform events. */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { renderText } from '../src/platform/notify.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-wapzo-'));
let db;
let app;
let server;
let base;
let sup;
let systemId;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
};
/** What the Wuzie number queued or sent, as [kind, recipient, text], oldest first. */
const sent = () => db.db.prepare(
    "SELECT campaign_id, recipient, message FROM messages WHERE tenant_id = ? AND direction = 'outbound' ORDER BY rowid")
    .all(systemId).map((m) => [m.campaign_id.replace('wapzo:', ''), m.recipient, m.message]);
const kinds = () => sent().map(([kind]) => kind);

before(async () => {
    db = new Database(path.join(tmp, 'wapzo.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 } });
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

describe('Wuzie WhatsApp number', () => {
    it('fills a message and tidies what an empty value leaves', () => {
        assert.equal(renderText('Hi {name}, on {plan}{amount_text}.', { name: 'Asha', plan: 'Starter' }), 'Hi Asha, on Starter.');
    });

    it('sends nothing, and fails nothing, before the number is linked', async () => {
        const res = await call(null, 'POST', '/api/leads', { name: 'Early', business: 'Early Shop', email: 'early@shop.test', phone: '98765 11111' });
        assert.equal(res.status, 201);
        const page = await call(sup, 'GET', '/api/admin/wapzo');
        assert.equal(page.status, 200);
        systemId = page.body.tenantId;
        assert.ok(page.body.channelId);
        assert.equal(page.body.messages.length, 8);
        assert.deepEqual(kinds(), []);
        assert.equal((await call(sup, 'POST', '/api/admin/wapzo/test', { to: '98765 00000' })).status, 409);
    });

    it('links like any number, through its own API, and sends a test', async () => {
        assert.equal((await call(sup, 'PUT', '/api/admin/wapzo/api/config', { transport: 'sandbox', defaultCountryCode: '91' })).status, 200);
        const up = await call(sup, 'POST', '/api/admin/wapzo/api/connection/connect');
        assert.equal(up.status, 200, JSON.stringify(up.body));
        assert.equal((await call(sup, 'GET', '/api/admin/wapzo/api/connection')).body.connected, true);
        const test = await call(sup, 'POST', '/api/admin/wapzo/test', { to: '98765 00000', text: 'Checking the link' });
        assert.equal(test.status, 200, JSON.stringify(test.body));
        assert.deepEqual(sent().at(-1), ['test', '919876500000', 'Checking the link']);
        // Not a business: never in the tenant list.
        assert.ok(!(await call(sup, 'GET', '/api/admin/tenants')).body.tenants.some((t) => t.id === systemId));
        // Its account messages take the fast lane (manager PLATFORM_LANE); businesses keep the default, off.
        assert.equal(app.locals.notifier.systemState().manager.platformLane, true);
    });

    it('thanks a visitor for their request; a switched-off message is not sent', async () => {
        await call(null, 'POST', '/api/leads', { name: 'Asha', business: 'Asha Sarees', email: 'asha@shop.test', phone: '+91 98765 22222' });
        const [kind, to, text] = sent().at(-1);
        assert.equal(kind, 'lead_received');
        assert.equal(to, '919876522222');
        assert.match(text, /^Hi Asha, thanks for asking for a Wuzie account for Asha Sarees\./);
        const off = await call(sup, 'PUT', '/api/admin/wapzo/messages/lead_received', { enabled: false });
        assert.equal(off.body.message.enabled, false);
        await call(null, 'POST', '/api/leads', { name: 'Ravi', business: 'Ravi Tutors', email: 'ravi@t.test', phone: '98765 33333' });
        assert.notEqual(sent().at(-1)[1], '919876533333');
        // Its own words, with the same fill-ins; empty text goes back to the default.
        await call(sup, 'PUT', '/api/admin/wapzo/messages/lead_received', { enabled: true, text: 'Namaste {name} from {business}!' });
        await call(null, 'POST', '/api/leads', { name: 'Meena', business: 'Meena Foods', email: 'meena@f.test', phone: '98765 44444' });
        assert.equal(sent().at(-1)[2], 'Namaste Meena from Meena Foods!');
        const reset = await call(sup, 'PUT', '/api/admin/wapzo/messages/lead_received', { text: '' });
        assert.match(reset.body.message.text, /thanks for asking/);
    });

    it('writes to a business when it is activated, its plan renews, it tops up and pays', async () => {
        const lead = (await call(sup, 'GET', '/api/admin/leads')).body.leads.find((l) => l.email === 'asha@shop.test');
        const tenant = (await call(sup, 'POST', `/api/admin/leads/${lead.id}/convert`, {})).body.tenant;
        assert.equal(tenant.contactPhone, '+91 98765 22222');
        const count = sent().length;
        await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'business' });
        assert.equal(sent().length, count, 'nothing while it is still being set up');
        await call(sup, 'POST', `/api/admin/tenants/${tenant.id}/activate`, { password: 'password123', sendWelcome: false });
        assert.deepEqual(sent().at(-1).slice(0, 2), ['account_activated', '919876522222']);
        assert.match(sent().at(-1)[2], /Asha Sarees is ready\. Sign in with asha@shop\.test/);
        await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/subscription`, { planKey: 'business' });
        assert.equal(kinds().at(-1), 'plan_renewed');
        assert.match(sent().at(-1)[2], /Business plan for Asha Sarees has been renewed \(₹2,999\)/);
        await call(sup, 'POST', `/api/admin/tenants/${tenant.id}/topup`, { days: 10, amount: 500 });
        assert.match(sent().at(-1)[2], /added 10 days to Asha Sarees \(₹500\)/);
        await call(sup, 'POST', `/api/admin/tenants/${tenant.id}/payments`, { amount: 2000, method: 'upi' });
        assert.equal(kinds().at(-1), 'payment_received');
        assert.match(sent().at(-1)[2], /received ₹2,000 for Asha Sarees.*Still due: ₹/);

        // The plan's end: 3 days before, then the day it ends; each once, however often the check runs.
        const soon = new Date(Date.now() + 2 * 864e5).toISOString();
        await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/validity`, { validUntil: soon });
        assert.deepEqual(app.locals.notifyPlanEnds().map((s) => s.kind), ['plan_ending']);
        assert.match(sent().at(-1)[2], /ends on .* \(2 days left\)/);
        assert.deepEqual(app.locals.notifyPlanEnds(), [], 'once');
        assert.deepEqual(app.locals.notifyPlanEnds(new Date(Date.now() + 3 * 864e5)).map((s) => s.kind), ['plan_expired']);

        // The business asked for no WhatsApp updates.
        await call(sup, 'PUT', `/api/admin/tenants/${tenant.id}/details`, { wapzoUpdates: false });
        const before = sent().length;
        await call(sup, 'POST', `/api/admin/tenants/${tenant.id}/payments`, { amount: 100, method: 'cash' });
        assert.equal(sent().length, before);

        const page = (await call(sup, 'GET', '/api/admin/wapzo')).body;
        assert.equal(page.log[0].kind, 'plan_expired');
        assert.ok(page.log.some((m) => m.kind === 'test'));
    });

    it('sends one message to many: all businesses, chosen ones or typed numbers, paced as bulk', async () => {
        const asha = (await call(sup, 'GET', '/api/admin/tenants')).body.tenants.find((t) => t.name === 'Asha Sarees');
        assert.equal((await call(sup, 'POST', '/api/admin/wapzo/broadcast', { tenants: 'all', text: '' })).status, 400);
        assert.equal((await call(sup, 'POST', '/api/admin/wapzo/broadcast', { tenants: [], text: 'Hi' })).status, 400);
        // All: Asha switched Wuzie updates off, so she is left out.
        const all = await call(sup, 'POST', '/api/admin/wapzo/broadcast', { tenants: 'all', text: 'Hi {name}' });
        assert.equal(all.status, 200, JSON.stringify(all.body));
        assert.ok(!sent().some(([kind, to]) => kind === 'broadcast' && to === '919876522222'));
        // Chosen by name, filled in per business; a typed number counted once however it is written.
        const res = await call(sup, 'POST', '/api/admin/wapzo/broadcast', {
            tenants: [asha.id], numbers: '98765 55555\n+91 98765 55555, abc', text: 'Hi {name} of {business}, we are live.',
        });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.queued, 2);
        assert.deepEqual(res.body.skipped.map((s) => s.to), ['abc']);
        const out = sent().filter(([kind]) => kind === 'broadcast').slice(-2);
        assert.deepEqual(out.map(([, to]) => to), ['919876522222', '919876555555']);
        assert.equal(out[0][2], 'Hi Asha of Asha Sarees, we are live.');
        assert.equal(out[1][2], 'Hi of, we are live.', 'a typed number has no business to fill in');
        const types = db.db.prepare("SELECT DISTINCT message_type FROM messages WHERE campaign_id = 'wapzo:broadcast'").all();
        assert.deepEqual(types.map((r) => r.message_type), ['campaign']);
    });

    it('sends to open leads only: new and on hold, not accepted or dismissed', async () => {
        const all = (await call(sup, 'GET', '/api/admin/leads')).body.leads;
        const by = (email) => all.find((l) => l.email === email);
        await call(sup, 'PATCH', `/api/admin/leads/${by('ravi@t.test').id}`, { status: 'hold' });
        await call(sup, 'PATCH', `/api/admin/leads/${by('meena@f.test').id}`, { status: 'dismissed' });
        const ids = ['early@shop.test', 'ravi@t.test', 'meena@f.test', 'asha@shop.test'].map((e) => by(e).id);
        const res = await call(sup, 'POST', '/api/admin/wapzo/broadcast', { tenants: [], leads: ids, text: 'Hi {name} of {business}' });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.queued, 2);
        const out = sent().filter(([kind]) => kind === 'broadcast').slice(-2);
        assert.deepEqual(out.map(([, to, text]) => [to, text]), [
            ['919876511111', 'Hi Early of Early Shop'],
            ['919876533333', 'Hi Ravi of Ravi Tutors'],
        ]);
        const closed = ids.slice(2);
        assert.equal((await call(sup, 'POST', '/api/admin/wapzo/broadcast', { tenants: [], leads: closed, text: 'Hi' })).status, 400);
    });

    it('sends an image, alone or with text, to every business and typed numbers together', async () => {
        const form = new FormData();
        form.set('file', new Blob([Buffer.from('89504e470d0a1a0a0000', 'hex')], { type: 'image/png' }), 'offer.png');
        const up = await fetch(`${base}/api/admin/wapzo/api/media/upload`, {
            method: 'POST', headers: { authorization: `Bearer ${sup}` }, body: form,
        });
        assert.equal(up.status, 201);
        const { mediaId } = await up.json();
        assert.equal((await call(sup, 'POST', '/api/admin/wapzo/broadcast', { tenants: 'all', mediaId: 'med_nope' })).status, 404);
        const before = sent().length;
        const res = await call(sup, 'POST', '/api/admin/wapzo/broadcast', { tenants: 'all', numbers: ['98765 66666', '+971 50 123 4567'], mediaId });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const out = sent().slice(before);
        assert.ok(out.some(([, to]) => to === '919876566666'), 'the typed number, beside every business');
        assert.ok(out.some(([, to]) => to === '971501234567'), 'its own country code kept, not +91 put in front');
        assert.equal(out.length, res.body.queued);
        assert.ok(out.every(([kind, , text]) => kind === 'broadcast' && text === ''), 'the image alone');
    });
});
