/**
 * Phase 2 stabilisation of the contact book: defects found reviewing contacts end to end.
 * Each test pins one behaviour a real operator would hit.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { importContacts, parseCsv } from '../src/contacts.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-cstab-'));
let app;
let server;
let base;
let db;
let token;

const call = async (method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text && json ? JSON.parse(text) : text };
};
const store = () => new ContactStore(db.forTenant(1), '91');

before(async () => {
    db = new Database(path.join(tmp, 'c.db'));
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

describe('re-importing a sheet', () => {
    it('keeps the saved name and email when the sheet leaves them blank', () => {
        const contacts = store();
        contacts.upsert({ phone: '+919870000001', name: 'Asha Rao', email: 'asha@example.com' });
        const out = contacts.importMany([{ phone: '919870000001', name: '', email: '' }], { normalized: true });
        assert.equal(out.updated, 1);
        const after2 = contacts.getByPhone('919870000001');
        assert.equal(after2.name, 'Asha Rao', 'a blank cell is not an instruction to erase');
        assert.equal(after2.email, 'asha@example.com');
        // A filled cell still updates.
        contacts.importMany([{ phone: '919870000001', name: 'Asha R.' }], { normalized: true });
        assert.equal(contacts.getByPhone('919870000001').name, 'Asha R.');
    });
});

describe('opting out through a write', () => {
    it('writing opt_in_status opted_out also writes the opt-out the send path obeys', () => {
        const contacts = store();
        const c = contacts.upsert({ phone: '+919870000002', optInStatus: 'opted_out' });
        assert.equal(c.optedOut, true, 'the send path reads opt_outs, not the status column');
        assert.equal(c.messageable, false);
        // And it can be lifted the normal way.
        assert.equal(contacts.setOptOut(c.id, false, 'asked to rejoin').optedOut, false);
    });

    it('lets the public-style upsert of an existing contact opt it out too', () => {
        const contacts = store();
        const c = contacts.upsert({ phone: '+919870000003', name: 'Ravi' });
        const out = contacts.upsert({ phone: '+919870000003', optInStatus: 'opted_out' });
        assert.equal(out.id, c.id);
        assert.equal(out.optedOut, true);
    });
});

describe('segments', () => {
    it('refuses a filter that is not an object, so one bad row cannot break every list', async () => {
        for (const filter of [null, 'x', [1], 5]) {
            const res = await call('POST', '/api/segments', { name: 'bad', filter });
            assert.equal(res.status, 400, JSON.stringify(filter));
        }
        const list = await call('GET', '/api/segments');
        assert.equal(list.status, 200);
    });

    it('still accepts no filter at all (everyone)', async () => {
        const res = await call('POST', '/api/segments', { name: 'everyone' });
        assert.equal(res.status, 201);
    });
});

describe('search', () => {
    before(() => {
        const contacts = store();
        contacts.upsert({ phone: '+919830000011', name: 'Search One' });
        contacts.upsert({ phone: '+919830000012', name: '100% Bakery' });
        contacts.upsert({ phone: '+919830000013', name: 'Plain Name' });
    });

    it('finds a number typed the way people type it', async () => {
        for (const term of ['+91 98300 00011', '98300 00011', '(98300) 00011', '09830000011']) {
            const res = await call('GET', `/api/contacts?search=${encodeURIComponent(term)}`);
            assert.deepEqual(res.body.contacts.map((c) => c.phone), ['919830000011'], term);
        }
    });

    it('treats % and _ as plain characters', async () => {
        const res = await call('GET', `/api/contacts?search=${encodeURIComponent('100%')}`);
        assert.deepEqual(res.body.contacts.map((c) => c.name), ['100% Bakery']);
        const under = await call('GET', `/api/contacts?search=${encodeURIComponent('_')}`);
        assert.equal(under.body.contacts.length, 0);
    });
});

describe('export', () => {
    it('exports every match, not just the first 5000', async () => {
        const contacts = store();
        const rows = Array.from({ length: 5003 }, (_, i) => ({ phone: String(917000000000 + i), name: `bulk${i}` }));
        const out = contacts.importMany(rows, { normalized: true, tags: ['export-all'] });
        assert.equal(out.created, 5003);
        const res = await call('GET', `/api/contacts/export?filter=${encodeURIComponent(JSON.stringify({ tags: ['export-all'] }))}`);
        assert.equal(res.status, 200);
        const lines = res.body.trim().split('\r\n');
        assert.equal(lines.length - 1, 5003);
    });
});

describe('merge', () => {
    it('moves tickets, objects, conversations and runs to the kept contact', () => {
        const contacts = store();
        const keep = contacts.upsert({ phone: '+919840000001', name: 'Keep' });
        const gone = contacts.upsert({ phone: '+919840000002', name: 'Gone' });
        const raw = db.db;
        const now = '2026-01-01T00:00:00+00:00';
        raw.prepare(`INSERT INTO tickets (tenant_id, contact_id, reference, created_at, updated_at) VALUES (1, ?, 'T-MERGE', ?, ?)`)
            .run(gone.id, now, now);
        raw.prepare(`INSERT INTO business_objects (tenant_id, type, reference, contact_id, status, created_at, updated_at)
                     VALUES (1, 'order', 'O-MERGE', ?, 'new', ?, ?)`).run(gone.id, now, now);
        raw.prepare(`INSERT INTO conversations (tenant_id, channel_id, contact_id, phone, created_at, updated_at)
                     VALUES (1, 77, ?, ?, ?, ?)`).run(gone.id, gone.phone, now, now);
        contacts.merge(keep.id, [gone.id]);
        assert.equal(raw.prepare(`SELECT contact_id AS c FROM tickets WHERE reference = 'T-MERGE'`).get().c, keep.id);
        assert.equal(raw.prepare(`SELECT contact_id AS c FROM business_objects WHERE reference = 'O-MERGE'`).get().c, keep.id);
        assert.equal(raw.prepare(`SELECT contact_id AS c FROM conversations WHERE channel_id = 77`).get().c, keep.id);
    });
});

describe('tags endpoint', () => {
    it('answers 400 to a body that is not lists of tags, instead of a 500', async () => {
        const made = await call('POST', '/api/contacts', { phone: '+919850000001' });
        const res = await call('POST', `/api/contacts/${made.body.contact.id}/tags`, { add: null, remove: 'x' });
        assert.equal(res.status, 400);
    });
});

describe('csv parsing', () => {
    it('reads a file that only uses CR line endings', () => {
        assert.deepEqual(parseCsv('name,phone\rA,9876543210\rB,9876543211\r'), [
            ['name', 'phone'], ['A', '9876543210'], ['B', '9876543211'],
        ]);
    });

    it('imports a CR-only file as rows, not as one giant line', async () => {
        const out = await importContacts('x.csv', Buffer.from('name,phone\rA,9876543210\rB,9876543211\r'), '91');
        assert.equal(out.contacts.length, 2);
    });

    it('keeps CRLF and quoted newlines working', () => {
        assert.deepEqual(parseCsv('a,b\r\n"x\r\ny",2\r\n'), [['a', 'b'], ['x\r\ny', '2']]);
    });
});

describe('a paused number', () => {
    it('does not lock the contact book, which belongs to the business, not the number', async () => {
        db.db.prepare("UPDATE whatsapp_channels SET status = 'disabled' WHERE tenant_id = 1").run();
        try {
            assert.equal((await call('GET', '/api/contacts')).status, 200);
            assert.equal((await call('GET', '/api/segments')).status, 200);
            assert.equal((await call('POST', '/api/contacts', { phone: '+919860000001', name: 'While paused' })).status, 201);
            // Sending things stay shut.
            assert.equal((await call('GET', '/api/templates')).status, 409);
        } finally {
            db.db.prepare("UPDATE whatsapp_channels SET status = 'active' WHERE tenant_id = 1").run();
        }
    });
});

describe('adding a number that is already saved', () => {
    it('keeps its name and email when the form leaves them blank, and PUT still clears them', async () => {
        await call('POST', '/api/contacts', { phone: '+919870000090', name: 'Meera', email: 'meera@example.com' });
        const again = await call('POST', '/api/contacts', { phone: '98700 00090', name: '', email: '' });
        assert.equal(again.status, 200);
        assert.equal(again.body.contact.name, 'Meera');
        assert.equal(again.body.contact.email, 'meera@example.com');
        const cleared = await call('PUT', `/api/contacts/${again.body.contact.id}`, { name: '', email: '' });
        assert.equal(cleared.body.contact.name, '');
    });
});

describe('Excel phone numbers stored as numbers', () => {
    it('keeps every digit of a 12-digit number Excel would show as 9.19877E+11', async () => {
        const XLSX = await import('xlsx');
        const sheet = XLSX.utils.aoa_to_sheet([['name', 'phone', 'qty'], ['A', 919876543210, 3], ['B', 9876543211, 4]]);
        const book = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(book, sheet, 'People');
        const buffer = XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });

        const out = await importContacts('people.xlsx', buffer, '91');
        assert.deepEqual(out.errors, []);
        assert.deepEqual(out.contacts.map((c) => c.phone), ['919876543210', '919876543211']);

        const { parseTable } = await import('../src/contacts.js');
        const table = await parseTable('people.xlsx', buffer);
        assert.deepEqual(table.rows.map((r) => r[1]), ['919876543210', '9876543211']);
        assert.equal(table.rows[0][2], '3', 'other numbers are untouched');
    });
});
