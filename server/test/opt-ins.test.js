/**
 * Proof of consent: every move to opted_in leaves an append-only opt_ins row saying how, when and in
 * what words, so an opt-in can be shown later to WhatsApp or to someone who complains.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { processOptOut } from '../src/autoreply/optout.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-optins-'));
let app;
let server;
let base;
let db;
let token;

const call = async (method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
};

const store = () => new ContactStore(db.forTenant(1), '91');
const proofs = (phone) => db.db.prepare('SELECT * FROM opt_ins WHERE tenant_id = 1 AND phone = ? ORDER BY id').all(phone);

before(async () => {
    db = new Database(path.join(tmp, 'o.db'));
    app = createTestApp({
        db,
        dataDir: tmp,
        config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000, safetyEnabled: false, defaultCountryCode: '91' },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    token = sessionFor(app, { tenantId: 1, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('opt-in proof', () => {
    it('a manual opt-in writes one row with the reason and who; a repeat writes none', async () => {
        const id = store().upsert({ phone: '+919870100001', name: 'Manual' }).id;
        const first = await call('POST', `/api/contacts/${id}/consent`, { optedOut: false, reason: 'Asked at the counter' });
        assert.equal(first.status, 200);
        assert.equal(first.body.contact.optInStatus, 'opted_in');
        await call('POST', `/api/contacts/${id}/consent`, { optedOut: false });
        await call('POST', '/api/contacts/bulk', { ids: [id], action: 'optIn' });

        const rows = proofs('919870100001');
        assert.equal(rows.length, 1, 'already opted in: nothing new to prove');
        assert.equal(rows[0].source, 'manual');
        assert.equal(rows[0].consent_text, 'Asked at the counter');
        assert.equal(rows[0].contact_id, id);
        assert.ok(Number.isInteger(rows[0].user_id), 'the operator is named');

        // The drawer reads it from the contact payload.
        const got = await call('GET', `/api/contacts/${id}`);
        assert.deepEqual(got.body.contact.optIn, { source: 'manual', text: 'Asked at the counter', at: rows[0].at });

        // Opted out and back in again is a new consent, so a new row.
        await call('POST', `/api/contacts/${id}/consent`, { optedOut: true });
        await call('POST', `/api/contacts/${id}/consent`, { optedOut: false });
        assert.equal(proofs('919870100001').length, 2);
    });

    it('START records the keyword as sent, also after a STOP', async () => {
        const tenant = db.forTenant(1);
        const phone = '919870100002';
        store().upsert({ phone: `+${phone}`, optInStatus: 'opted_in' });
        assert.equal(proofs(phone).length, 1, 'created opted in');
        await processOptOut(tenant, null, { sender: phone, body: 'STOP' });
        const start = await processOptOut(tenant, null, { sender: phone, body: 'Start' });
        assert.equal(start.action, 'opted_in');

        const rows = proofs(phone);
        assert.equal(rows.length, 2);
        assert.equal(rows[1].source, 'keyword');
        assert.equal(rows[1].consent_text, 'Start');
        assert.equal(store().getByPhone(phone).optInStatus, 'opted_in');

        await processOptOut(tenant, null, { sender: phone, body: 'START' });
        assert.equal(proofs(phone).length, 2, 'already opted in');

        // A number with no contact yet becomes one, opted in, so the opt-in gate lets it through.
        await processOptOut(tenant, null, { sender: '919870100003', body: 'subscribe' });
        assert.equal(store().getByPhone('919870100003').optInStatus, 'opted_in');
        assert.equal(proofs('919870100003')[0].consent_text, 'subscribe');
    });

    it('an import with a consent column writes a row per consenting contact', async () => {
        const csv = 'Phone,Name,Consent\n+919870100011,A,Signed form 3 Mar\n+919870100012,B,no\n+919870100013,C,\n';
        const form = new FormData();
        form.append('mapping', JSON.stringify(['phone', 'name', 'consent']));
        form.append('file', new Blob([csv], { type: 'text/csv' }), 'people.csv');
        const res = await fetch(`${base}/api/contacts/import?save=true`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
        assert.equal(res.status, 200);
        assert.equal((await res.json()).saved.created, 3);

        const rows = proofs('919870100011');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].source, 'import');
        assert.equal(rows[0].consent_text, 'Signed form 3 Mar');
        assert.equal(store().getByPhone('919870100011').optInStatus, 'opted_in');
        assert.equal(proofs('919870100012').length, 0, 'a no is not consent');
        assert.equal(store().getByPhone('919870100012').optInStatus, 'unknown');
        assert.equal(proofs('919870100013').length, 0);
    });

    it('the database refuses to edit or delete a proof row', () => {
        store().upsert({ phone: '+919870100021', optInStatus: 'opted_in', source: 'api' });
        assert.equal(proofs('919870100021')[0].consent_text, 'Opted in through the API');
        assert.throws(() => db.db.prepare("UPDATE opt_ins SET consent_text = 'forged' WHERE phone = '919870100021'").run(), /immutable/);
        assert.throws(() => db.db.prepare("DELETE FROM opt_ins WHERE phone = '919870100021'").run(), /immutable/);
        assert.equal(proofs('919870100021').length, 1);
    });

    it('the CSV export carries opted_in_at and opt_in_source', async () => {
        const c = store().upsert({ phone: '+919870100031', name: 'Export', optInStatus: 'opted_in', source: 'api' });
        const res = await call('GET', `/api/contacts/export?ids=${c.id}`);
        const [head, row] = res.body.replace(/^﻿/, '').trim().split('\r\n').map((l) => l.split(','));
        assert.ok(head.includes('opted_in_at') && head.includes('opt_in_source'));
        assert.equal(row[head.indexOf('opt_in_source')], 'api');
        assert.equal(row[head.indexOf('opted_in_at')], proofs('919870100031')[0].at);
    });
});
