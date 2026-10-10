/**
 * The contacts page: bulk actions, consent toggles, the mapped import wizard,
 * CSV export, duplicate detection and merge, and the richer timeline.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore, canonicalPhone } from '../src/contactStore.js';
import {
    contactsToCsv, csvCell, importContacts, mappedRowsToContacts, resolveMapping, suggestMapping,
} from '../src/contacts.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-cpage-'));
let app;
let server;
let base;
let db;
let token;
let tokenB;

const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            authorization: `Bearer ${who}`,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, headers: res.headers, body: text && json ? JSON.parse(text) : text };
};

const upload = async (url, csv, fields = {}) => {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'people.csv');
    const res = await fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: res.status, body: await res.json() };
};

const store = () => new ContactStore(db.forTenant(1), '91');

before(async () => {
    db = new Database(path.join(tmp, 'c.db'));
    app = createTestApp({
        db,
        dataDir: tmp,
        config: {
            ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000,
            safetyEnabled: false, defaultCountryCode: '91',
        },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    const tenantB = app.locals.tenancy.createTenant('Page B', 'page-b');
    token = sessionFor(app, { tenantId: 1, role: 'owner' });
    tokenB = sessionFor(app, { tenantId: tenantB.id, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

describe('listing', () => {
    it('sorts by a whitelisted column and pages with offset', async () => {
        const contacts = store();
        contacts.upsert({ phone: '+919830000003', name: 'charlie', tags: ['sort-test'] });
        contacts.upsert({ phone: '+919830000001', name: 'Alpha', tags: ['sort-test'] });
        contacts.upsert({ phone: '+919830000002', name: 'bravo', tags: ['sort-test'] });

        const asc = await call(token, 'GET', '/api/contacts?tags=sort-test&sort=name&dir=asc');
        assert.deepEqual(asc.body.contacts.map((c) => c.name), ['Alpha', 'bravo', 'charlie'], 'case-insensitive');
        const desc = await call(token, 'GET', '/api/contacts?tags=sort-test&sort=name&dir=desc&limit=2&offset=1');
        assert.deepEqual(desc.body.contacts.map((c) => c.name), ['bravo', 'Alpha']);
        assert.equal(desc.body.total, 3);

        // An unknown sort key is ignored, never interpolated into SQL.
        const evil = await call(token, 'GET', `/api/contacts?tags=sort-test&sort=${encodeURIComponent('id; DROP TABLE contacts')}`);
        assert.equal(evil.status, 200);
        assert.equal(evil.body.contacts.length, 3);
    });
});

describe('bulk actions', () => {
    let ids;
    before(() => {
        const contacts = store();
        ids = ['+919840000001', '+919840000002', '+919840000003']
            .map((phone, i) => contacts.upsert({ phone, name: `Bulk ${i}`, tags: ['bulk'] }).id);
    });

    it('adds and removes tags across many contacts', async () => {
        const added = await call(token, 'POST', '/api/contacts/bulk', { ids, action: 'addTags', tags: ['VIP', 'q3'] });
        assert.equal(added.status, 200);
        assert.equal(added.body.affected, 3);
        assert.deepEqual(store().get(ids[0]).tags, ['bulk', 'vip', 'q3']);

        const removed = await call(token, 'POST', '/api/contacts/bulk', { ids: ids.slice(0, 2), action: 'removeTags', tags: ['q3'] });
        assert.equal(removed.body.affected, 2);
        assert.deepEqual(store().get(ids[1]).tags, ['bulk', 'vip']);
        assert.deepEqual(store().get(ids[2]).tags, ['bulk', 'vip', 'q3']);
    });

    it('opts out with a reason and back in, keeping both records in step', async () => {
        const out = await call(token, 'POST', '/api/contacts/bulk', { ids, action: 'optOut', reason: 'asked by phone' });
        assert.equal(out.body.affected, 3);
        const contact = store().get(ids[0]);
        assert.equal(contact.optedOut, true);
        assert.equal(contact.optInStatus, 'opted_out');
        assert.equal(contact.optOutReason, 'asked by phone');
        assert.equal(db.forTenant(1).isOptedOut(contact.phone), true, 'the send path sees it');

        await call(token, 'POST', '/api/contacts/bulk', { ids: [ids[0]], action: 'optIn' });
        const back = store().get(ids[0]);
        assert.equal(back.optedOut, false);
        assert.equal(back.optInStatus, 'opted_in');
        assert.equal(db.forTenant(1).isOptedOut(back.phone), false);
    });

    it('applies to every match of a filter', async () => {
        const res = await call(token, 'POST', '/api/contacts/bulk', { filter: { tags: ['bulk'] }, action: 'addTags', tags: ['filtered'] });
        assert.equal(res.body.affected, 3);
        assert.ok(store().get(ids[2]).tags.includes('filtered'));
    });

    it('validates the request', async () => {
        const bad = async (body) => (await call(token, 'POST', '/api/contacts/bulk', body)).status;
        assert.equal(await bad({ ids, action: 'explode' }), 400);
        assert.equal(await bad({ ids: [], action: 'delete' }), 400);
        assert.equal(await bad({ ids: 'all', action: 'delete' }), 400);
        assert.equal(await bad({ ids, action: 'addTags' }), 400, 'tag actions need tags');
        assert.equal(await bad({ ids, action: 'addTags', tags: 'vip' }), 400);
        assert.equal(await bad({ ids, action: 'optOut', reason: 42 }), 400);
    });

    it('cannot touch another tenant\'s contacts', async () => {
        const res = await call(tokenB, 'POST', '/api/contacts/bulk', { ids, action: 'delete' });
        assert.equal(res.status, 200);
        assert.equal(res.body.affected, 0);
        assert.deepEqual(res.body.missing.sort(), [...ids].sort());
        assert.ok(store().get(ids[0]), 'still there');
    });

    it('does not let an agent bulk delete', async () => {
        const agent = sessionFor(app, { tenantId: 1, role: 'agent' });
        assert.equal((await call(agent, 'POST', '/api/contacts/bulk', { ids, action: 'delete' })).status, 403);
    });

    it('deletes, reporting ids that were already gone', async () => {
        const res = await call(token, 'POST', '/api/contacts/bulk', { ids: [...ids, 99999999], action: 'delete' });
        assert.equal(res.body.affected, 3);
        assert.deepEqual(res.body.missing, [99999999]);
        assert.equal(store().get(ids[0]), null);
    });
});

describe('consent toggle', () => {
    it('writes opt_outs and opt_in_status together', async () => {
        const id = store().upsert({ phone: '+919850000001', name: 'Consent' }).id;
        const out = await call(token, 'POST', `/api/contacts/${id}/consent`, { optedOut: true, reason: 'STOP reply' });
        assert.equal(out.status, 200);
        assert.equal(out.body.contact.optedOut, true);
        assert.equal(out.body.contact.optInStatus, 'opted_out');
        assert.equal(out.body.contact.optOutReason, 'STOP reply');

        const back = await call(token, 'POST', `/api/contacts/${id}/consent`, { optedOut: false });
        assert.equal(back.body.contact.optedOut, false);
        assert.equal(back.body.contact.optInStatus, 'opted_in');

        assert.equal((await call(token, 'POST', `/api/contacts/${id}/consent`, { optedOut: 'yes' })).status, 400);
        assert.equal((await call(token, 'POST', '/api/contacts/99999999/consent', { optedOut: true })).status, 404);
        assert.equal((await call(tokenB, 'POST', `/api/contacts/${id}/consent`, { optedOut: true })).status, 404);
    });
});

describe('import wizard', () => {
    const csv = 'Mobile,Customer,E-mail,Labels,City\n'
        + '+919860000001,Isha,isha@x.dev,"gold, pune",Pune\n'
        + '9860000002,Rohan,,silver,Mumbai\n'
        + 'junk,Bad,,,\n'
        + '09860000002,Rohan again,,,\n';

    it('previews headers, sample rows and a suggested mapping', async () => {
        const res = await upload('/api/contacts/import/preview', csv);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.headers, ['Mobile', 'Customer', 'E-mail', 'Labels', 'City']);
        assert.equal(res.body.rowCount, 4);
        assert.equal(res.body.rows.length, 4);
        assert.deepEqual(res.body.mapping, ['phone', 'custom:customer', 'email', 'tags', 'custom:city']);
        assert.equal(store().getByPhone('919860000001'), null, 'a preview writes nothing');
    });

    it('imports with an explicit mapping: email, per-row tags, custom fields', async () => {
        const mapping = JSON.stringify(['phone', 'name', 'email', 'tags', 'custom:city']);
        const res = await upload('/api/contacts/import?save=true', csv, { mapping, tags: 'wizard' });
        assert.equal(res.status, 200);
        assert.equal(res.body.saved.created, 2);
        assert.equal(res.body.errors.length, 1, 'the junk row');
        assert.equal(res.body.duplicates, 1, 'the national form of Rohan');
        const isha = store().getByPhone('919860000001');
        assert.equal(isha.name, 'Isha');
        assert.equal(isha.email, 'isha@x.dev');
        assert.deepEqual(isha.tags, ['wizard', 'gold', 'pune']);
        assert.deepEqual(isha.customFields, { city: 'Pune' });
    });

    it('rejects a mapping without a phone column or with an unknown target', async () => {
        assert.equal((await upload('/api/contacts/import?save=true', csv,
            { mapping: JSON.stringify(['name', 'ignore', 'ignore', 'ignore', 'ignore']) })).status, 400);
        assert.equal((await upload('/api/contacts/import?save=true', csv,
            { mapping: JSON.stringify(['phone', 'shoe size']) })).status, 400);
        assert.equal((await upload('/api/contacts/import?save=true', csv, { mapping: '{nope' })).status, 400);
    });

    it('leaves the plain importer exactly as it was without a mapping', async () => {
        const plain = 'name,phone,city\nAnya,+919861000001,Goa\n';
        const res = await upload('/api/contacts/import', plain);
        const direct = await importContacts('x.csv', Buffer.from(plain), '91');
        assert.deepEqual(res.body, direct);
    });

    it('maps by header name too, and suggests sensible targets', () => {
        assert.deepEqual(resolveMapping(['Phone', 'Who'], { Phone: 'phone', Who: 'name' }), ['phone', 'name']);
        assert.throws(() => resolveMapping(['a', 'b'], ['phone', 'phone']), /only one/);
        assert.deepEqual(suggestMapping(['Name', 'Phone Number', 'Email', '', 'Tags']),
            ['name', 'phone', 'email', 'ignore', 'tags']);
        const out = mappedRowsToContacts([['+919862000001', 'a;b|c']], ['phone', 'tags'], '91');
        assert.deepEqual(out.contacts[0].tags, ['a', 'b', 'c']);
    });
});

describe('csv export', () => {
    it('escapes quotes, commas and newlines and defuses formulas', () => {
        assert.equal(csvCell('plain'), 'plain');
        assert.equal(csvCell('a,b'), '"a,b"');
        assert.equal(csvCell('say "hi"'), '"say ""hi"""');
        assert.equal(csvCell('two\nlines'), '"two\nlines"');
        assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
        assert.equal(csvCell('+1'), "'+1");
        assert.equal(csvCell('-2'), "'-2");
        assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
        assert.equal(csvCell(null), '');
        const csv = contactsToCsv([{ name: 'A', phone: '1', email: '', tags: ['x', 'y'], customFields: { k: 'v' } }]);
        assert.ok(csv.startsWith('﻿name,phone,email,tags'));
        assert.ok(csv.includes('"x, y"'));
    });

    it('exports selected ids or the filtered set as a download', async () => {
        const contacts = store();
        const a = contacts.upsert({ phone: '+919870000101', name: '=cmd|calc', tags: ['export'], customFields: { plan: 'gold' } });
        contacts.upsert({ phone: '+919870000102', name: 'Two, Jr', tags: ['export'] });

        const byFilter = await call(token, 'GET', '/api/contacts/export?tags=export');
        assert.equal(byFilter.status, 200);
        assert.match(byFilter.headers.get('content-type'), /text\/csv/);
        assert.match(byFilter.headers.get('content-disposition'), /attachment; filename="contacts-/);
        const lines = byFilter.body.replace(/^﻿/, '').trim().split('\r\n');
        assert.equal(lines.length, 3);
        assert.ok(lines[0].endsWith(',plan'));
        assert.ok(lines.some((l) => l.startsWith("'=cmd|calc,")));
        assert.ok(lines.some((l) => l.startsWith('"Two, Jr",')));

        const byIds = await call(token, 'GET', `/api/contacts/export?ids=${a.id}`);
        assert.equal(byIds.body.replace(/^﻿/, '').trim().split('\r\n').length, 2);

        const other = await call(tokenB, 'GET', `/api/contacts/export?ids=${a.id}`);
        assert.equal(other.body.replace(/^﻿/, '').trim().split('\r\n').length, 1, 'header only for another tenant');
    });
});

describe('duplicates and merge', () => {
    it('folds the shapes a legacy number can take', () => {
        for (const raw of ['919812345001', '+91 98123 45001', '09812345001', '9812345001', '0091 98123 45001', '91919812345001']) {
            assert.equal(canonicalPhone(raw, '91'), '919812345001', raw);
        }
        assert.equal(canonicalPhone('+15551234567', '91'), '15551234567');
        assert.equal(canonicalPhone('abc', '91'), null);
    });

    it('suggests groups and merges them, the kept contact winning conflicts', async () => {
        const contacts = store();
        const keep = contacts.upsert({
            phone: '+919880000001', name: 'Meera', tags: ['a'], customFields: { city: 'Pune' },
        });
        // Legacy rows written before numbers were normalised.
        const now = '2026-01-01T00:00:00+00:00';
        const insert = db.db.prepare(
            `INSERT INTO contacts (tenant_id, phone, name, email, custom_fields, tags, created_at, updated_at)
             VALUES (1, ?, ?, ?, ?, ?, ?, ?)`);
        const legacy1 = Number(insert.run('9880000001', '', 'meera@x.dev', '{"city":"Mumbai","plan":"gold"}', '["b"]', now, now).lastInsertRowid);
        const legacy2 = Number(insert.run('09880000001', 'M.', '', '{}', '["a","c"]', now, now).lastInsertRowid);
        db.forTenant(1).addOptOut('09880000001', 'STOP');

        const found = await call(token, 'GET', '/api/contacts/duplicates');
        assert.equal(found.status, 200);
        const group = found.body.groups.find((g) => g.key === '919880000001');
        assert.ok(group, 'the three rows are grouped');
        assert.deepEqual(group.contacts.map((c) => c.id).sort((x, y) => x - y), [keep.id, legacy1, legacy2]);
        assert.equal(group.suggestedKeepId, keep.id, 'the canonical row is the suggestion');

        assert.equal((await call(tokenB, 'GET', '/api/contacts/duplicates')).body.total, 0, 'per tenant');

        const merged = await call(token, 'POST', '/api/contacts/merge', { keepId: keep.id, mergeIds: [legacy1, legacy2] });
        assert.equal(merged.status, 200);
        const c = merged.body.contact;
        assert.equal(c.name, 'Meera');
        assert.equal(c.email, 'meera@x.dev', 'blanks filled from the others');
        assert.deepEqual(c.tags, ['a', 'b', 'c']);
        assert.deepEqual(c.customFields, { city: 'Pune', plan: 'gold' }, 'keep wins on conflict');
        assert.equal(c.optedOut, true, 'an opt-out anywhere survives the merge');
        assert.equal(c.optInStatus, 'opted_out');
        assert.deepEqual(merged.body.removed.sort((x, y) => x - y), [legacy1, legacy2]);
        assert.equal(store().get(legacy1), null);
        assert.equal((await call(token, 'GET', '/api/contacts/duplicates')).body.groups
            .some((g) => g.key === '919880000001'), false);
    });

    it('validates a merge', async () => {
        const id = store().upsert({ phone: '+919880000009' }).id;
        const bad = async (body, who = token) => (await call(who, 'POST', '/api/contacts/merge', body)).status;
        assert.equal(await bad({ keepId: id, mergeIds: [] }), 400);
        assert.equal(await bad({ keepId: id, mergeIds: [id] }), 400, 'cannot merge into itself');
        assert.equal(await bad({ keepId: 'x', mergeIds: [1] }), 400);
        assert.equal(await bad({ keepId: id, mergeIds: [99999999] }), 404);
        assert.equal(await bad({ keepId: id, mergeIds: [1] }, tokenB), 404, 'another tenant');
    });
});

describe('timeline', () => {
    it('shows sent messages with status and error, replies, and media', async () => {
        const contact = store().upsert({ phone: '+919890000001', name: 'Timeline' });
        db.db.prepare(
            `INSERT INTO messages (tenant_id, message_id, message_type, recipient, message, status, error, created_at, updated_at)
             VALUES (1, 'tl-1', 'campaign', ?, 'Hello', 'FAILED', 'blocked', '2026-02-01T10:00:00+00:00', '2026-02-01T10:00:00+00:00')`)
            .run(contact.phone);
        db.db.prepare(
            `INSERT INTO inbound_messages (tenant_id, message_id, sender, body, media_type, received_at)
             VALUES (1, NULL, ?, 'photo', 'image', '2026-02-01T11:00:00+00:00')`).run(contact.phone);
        const res = await call(token, 'GET', `/api/contacts/${contact.id}/timeline`);
        assert.equal(res.status, 200);
        const [inbound, outbound] = res.body.timeline;
        assert.equal(inbound.kind, 'media');
        assert.ok(inbound.messageId, 'a stable key even without a provider id');
        assert.equal(outbound.status, 'FAILED');
        assert.equal(outbound.error, 'blocked');
    });

    it('includes button clicks only when that table exists', () => {
        const raw = new DatabaseSync(':memory:');
        raw.exec(`
            CREATE TABLE contacts (id INTEGER PRIMARY KEY, tenant_id INTEGER, phone TEXT, name TEXT, email TEXT,
              status TEXT DEFAULT 'active', opt_in_status TEXT DEFAULT 'unknown', custom_fields TEXT DEFAULT '{}',
              tags TEXT DEFAULT '[]', source TEXT, created_at TEXT, updated_at TEXT, UNIQUE (tenant_id, phone));
            CREATE TABLE opt_outs (tenant_id INTEGER, phone TEXT, reason TEXT, opted_out_at TEXT);
            CREATE TABLE messages (tenant_id INTEGER, message_id TEXT, message_type TEXT, recipient TEXT,
              message TEXT, status TEXT, error TEXT, created_at TEXT);
            CREATE TABLE inbound_messages (id INTEGER PRIMARY KEY, tenant_id INTEGER, message_id TEXT, sender TEXT,
              body TEXT, media_type TEXT, received_at TEXT);`);
        const contacts = new ContactStore({ db: raw, tenantId: 1 }, '91');
        const c = contacts.upsert({ phone: '+919890000002' });
        assert.equal(contacts.timeline(c.id).length, 0, 'no table, no clicks, no error');

        raw.exec(`CREATE TABLE button_clicks (id INTEGER PRIMARY KEY, tenant_id INTEGER, phone TEXT,
                  button_title TEXT, clicked_at TEXT)`);
        raw.prepare(`INSERT INTO button_clicks (tenant_id, phone, button_title, clicked_at) VALUES (1, ?, 'Yes, book', '2026-03-01T09:00:00Z')`)
            .run(c.phone);
        raw.prepare(`INSERT INTO button_clicks (tenant_id, phone, button_title, clicked_at) VALUES (2, ?, 'Other tenant', '2026-03-01T09:00:00Z')`)
            .run(c.phone);
        const timeline = contacts.timeline(c.id);
        assert.equal(timeline.length, 1);
        assert.equal(timeline[0].kind, 'button_click');
        assert.equal(timeline[0].body, 'Yes, book');
        raw.close();
    });
});
