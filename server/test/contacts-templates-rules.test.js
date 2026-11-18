/**
 * Templates and Contacts additions of 2026-11-18: campaign sends count toward a template's "Sent N", preview with a
 * real contact, the template rules (auto-approve, longest body), the contact rules (cap, group import, export),
 * pasting numbers, and the birthday greeting sweep.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { greetingSweep, parseDayMonth } from '../src/contactGreetings.js';
import { pastedNumbers } from '../src/contacts.js';
import { MODULE_SWEEPS } from '../src/moduleSweeps.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-ct-rules-'));
let app;
let server;
let base;
let db;
let owner;
let admin;
let state;

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* CSV */ }
    return { status: res.status, body: parsed };
};
const api = (method, url, body) => call(owner, method, `/api${url}`, body);
const rules = async (values) => {
    const res = await call(admin, 'PUT', '/api/admin/policy/tenant:1', { values });
    assert.equal(res.status, 200, JSON.stringify(res.body));
};

before(async () => {
    db = new Database(path.join(tmp, 'c.db'));
    app = createTestApp({ db, dataDir: tmp, config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, defaultCountryCode: '91' } });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/api/connection/connect`, { method: 'POST' });
    const rt = app.locals.runtimeFor(1);
    state = rt.runtimeFor(rt.channels.getDefault()).state;
    owner = sessionFor(app, { tenantId: 1, role: 'owner' });
    admin = sessionFor(app, { role: 'super_admin' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('templates', () => {
    it('counts campaign messages in the template use count', async () => {
        const template = state.templates.create({ name: 'promo-count', body: 'Hi {name}' });
        const camp = await api('POST', '/campaigns', {
            name: 'Count', templateId: template.id,
            audience: [{ phone: '919800000101', name: 'A' }, { phone: '919800000102', name: 'B' }],
        });
        assert.equal(camp.status, 201, JSON.stringify(camp.body));
        const started = await api('POST', `/campaigns/${camp.body.campaign.id}/start`);
        assert.equal(started.status, 200, JSON.stringify(started.body));
        assert.equal(state.templates.get(template.id).useCount, started.body.queued);
        assert.ok(started.body.queued >= 1);
        await api('POST', `/campaigns/${camp.body.campaign.id}/cancel`);
    });

    it('previews with a real contact and counts contacts missing a field', async () => {
        state.contacts.upsert({ phone: '919800000201', name: 'Asha', customFields: { city: 'Pune' } });
        const bare = state.contacts.upsert({ phone: '919800000202', name: '' });
        const template = state.templates.create({ name: 'preview-real', body: 'Hi {name} from {city}' });
        const asha = state.contacts.getByPhone('919800000201');
        const res = await api('POST', `/templates/${template.id}/preview`, { contactId: asha.id });
        assert.equal(res.status, 200);
        assert.equal(res.body.body, 'Hi Asha from Pune');
        assert.deepEqual(res.body.missing, []);
        assert.ok(res.body.missingCounts.city >= 1);
        assert.ok(res.body.missingCounts.name >= 1);
        const draft = await api('POST', '/templates/draft/preview', { contactId: bare.id, body: 'Yo {city}' });
        assert.equal(draft.body.body, 'Yo {city}');
        assert.deepEqual(draft.body.missing, ['city']);
        assert.equal((await api('POST', `/templates/${template.id}/preview`, { contactId: 999999 })).status, 404);
    });

    it('refuses a body over templates.maxBodyChars', async () => {
        await rules({ 'templates.maxBodyChars': 10 });
        const res = await api('POST', '/templates', { name: 'too-long', body: 'This body is far too long' });
        assert.equal(res.status, 400);
        assert.equal(res.body.rule, 'maxBodyChars');
        await rules({ 'templates.maxBodyChars': null });
    });

    it('approves a low-spam template by itself when templates.autoApproveBelowSpam is set', async () => {
        await rules({ 'templates.requireApproval': 'all', 'templates.autoApproveBelowSpam': 10 });
        const clean = await api('POST', '/templates', { name: 'clean-auto', body: 'Your order has shipped.' });
        assert.equal(clean.body.template.reviewStatus, 'approved');
        const spammy = await api('POST', '/templates', { name: 'spam-auto', body: 'WIN FREE CASH NOW!!! CLICK HERE' });
        assert.equal(spammy.body.template.reviewStatus, 'pending');
        await rules({ 'templates.autoApproveBelowSpam': null });
        const off = await api('POST', '/templates', { name: 'clean-off', body: 'Your order has shipped again.' });
        assert.equal(off.body.template.reviewStatus, 'pending');
        await rules({ 'templates.requireApproval': null });
    });

    it('shows the templates and contacts usage lines', async () => {
        const t = await call(admin, 'GET', '/api/admin/services/templates/usage');
        assert.match(t.body.usage[1], /^\d+ templates · \d+ pending review$/);
        const c = await call(admin, 'GET', '/api/admin/services/contacts/usage');
        assert.match(c.body.usage[1], /^\d+ contacts · \d+ opted out$/);
    });
});

describe('contacts', () => {
    it('finds numbers in pasted text', () => {
        const got = pastedNumbers('Rahul 98765 43210\nPriya: +91 98765-43211, 98765 43210\nbad 12\n9876543212 9876543213', '91');
        assert.deepEqual(got.valid, ['919876543210', '919876543211', '919876543212', '919876543213']);
        assert.equal(got.duplicates, 1);
    });

    it('previews then imports pasted numbers with a tag', async () => {
        const text = '98111 00001\n98111 00002, 98111 00001';
        const preview = await api('POST', '/contacts/paste', { text });
        assert.equal(preview.status, 200);
        assert.equal(preview.body.valid, 2);
        assert.equal(preview.body.duplicates, 1);
        assert.equal(preview.body.new, 2);
        const saved = await api('POST', '/contacts/paste', { text, tags: ['Pasted'], save: true });
        assert.equal(saved.body.saved.created, 2);
        assert.deepEqual(state.contacts.getByPhone('919811100001').tags, ['pasted']);
    });

    it('enforces contacts.maxContacts on add, paste and import', async () => {
        const have = state.contacts.count();
        await rules({ 'contacts.maxContacts': have });
        const add = await api('POST', '/contacts', { phone: '919822200001' });
        assert.equal(add.status, 403);
        assert.match(add.body.errors[0], /allows/);
        // A number already in the book is an update, never refused.
        assert.equal((await api('POST', '/contacts', { phone: '919811100001', name: 'Known' })).status, 200);
        assert.equal((await api('POST', '/contacts/paste', { text: '98222 00002', save: true })).status, 403);
        await rules({ 'contacts.maxContacts': null });
        assert.equal((await api('POST', '/contacts', { phone: '919822200001' })).status, 201);
    });

    it('turns off group import and export by rule', async () => {
        await rules({ 'contacts.allowGroupImport': false, 'contacts.allowExport': false });
        assert.equal((await api('GET', '/contacts/whatsapp-groups')).status, 403);
        assert.equal((await api('POST', '/contacts/whatsapp-groups/import', { all: true })).status, 403);
        assert.equal((await api('GET', '/contacts/export')).status, 403);
        await rules({ 'contacts.allowGroupImport': null, 'contacts.allowExport': null });
        assert.equal((await api('GET', '/contacts/export')).status, 200);
    });

    it('filters and segments by a contact detail', async () => {
        const filter = JSON.stringify({ custom: { city: 'Pune' } });
        const res = await api('GET', `/contacts?filter=${encodeURIComponent(filter)}`);
        assert.ok(res.body.contacts.every((c) => c.customFields.city === 'Pune'));
        assert.ok(res.body.contacts.length >= 1);
        const seg = await api('POST', '/segments', { name: 'Pune', filter: { custom: { city: 'Pune' } } });
        assert.equal(seg.body.count, res.body.total);
    });
});

describe('birthday greetings', () => {
    it('reads the accepted date formats', () => {
        assert.deepEqual(parseDayMonth('18/11'), { day: 18, month: 11 });
        assert.deepEqual(parseDayMonth('18-11-1990'), { day: 18, month: 11 });
        assert.deepEqual(parseDayMonth('1990-11-18'), { day: 18, month: 11 });
        assert.equal(parseDayMonth('31/02'), null);
        assert.equal(parseDayMonth('hello'), null);
    });

    it('is registered as a contacts module sweep', () => {
        assert.ok(MODULE_SWEEPS.some((s) => s.service === 'contacts' && s.run === greetingSweep));
    });

    it('greets once a year on the day after 9am, within the daily cap', async () => {
        state.contacts.upsert({ phone: '919833300001', name: 'Ravi', customFields: { dob: '18/11/1990' } });
        state.contacts.upsert({ phone: '919833300002', name: 'Mira', customFields: { dob: '2001-11-18' } });
        state.contacts.upsert({ phone: '919833300003', name: 'Off', customFields: { dob: '19-11' } });

        const off = await api('PUT', '/contacts/greetings', { enabled: true });
        assert.equal(off.status, 400); // no field yet
        const saved = await api('PUT', '/contacts/greetings', { enabled: true, field: 'dob', message: 'Happy birthday {name}!' });
        assert.equal(saved.status, 200);
        assert.equal((await api('GET', '/contacts/greetings')).body.settings.field, 'dob');

        // 03:30 UTC on 18 Nov: before 9am in UTC, after 9am in India.
        const early = new Date('2026-11-18T03:30:00Z');
        const late = new Date('2026-11-18T12:00:00Z');
        const zone = state.channel.timezone;
        state.channel.timezone = 'UTC';
        assert.equal(greetingSweep(state, early), null);

        await rules({ 'contacts.maxGreetingsPerDay': 1 });
        const first = greetingSweep(state, late);
        assert.equal(first.sent, 1);
        assert.equal(greetingSweep(state, late), null); // done for today

        await rules({ 'contacts.maxGreetingsPerDay': null });
        await api('PUT', '/contacts/greetings', { message: 'Happy birthday {name}!' }); // a save runs today again
        const second = greetingSweep(state, late);
        assert.equal(second.sent, 1); // the other one; the first is a duplicate key
        const sent = db.db.prepare("SELECT message FROM messages WHERE recipient LIKE '%98333000%'").all().map((r) => r.message);
        assert.equal(sent.length, 2);
        assert.ok(sent.includes('Happy birthday Ravi!'));

        await rules({ 'contacts.allowDateGreetings': false });
        await api('PUT', '/contacts/greetings', {});
        assert.equal(greetingSweep(state, late), null);
        await rules({ 'contacts.allowDateGreetings': null });
        state.channel.timezone = zone;
    });
});
