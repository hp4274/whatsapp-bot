/**
 * Phase 4: the contact book.
 *
 * The interesting claims are that the number is the identity (so importing the
 * same sheet twice updates rather than duplicates), that a business can store
 * whatever it actually tracks without a schema change, and that a segment is a
 * filter rather than a list - so it cannot go stale.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { ContactStore } from '../src/contactStore.js';
import { Database } from '../src/db.js';
import { createTestApp, sessionFor } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-contacts-'));
let app;
let server;
let base;
let db;
let token;
let tokenB;
let tenantB;

const call = async (token2, method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
        method,
        headers: {
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(token2 ? { authorization: `Bearer ${token2}` } : { authorization: '' }),
            ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text && json ? JSON.parse(text) : (text || null) };
};

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
    tenantB = app.locals.tenancy.createTenant('Contacts B', 'contacts-b');
    token = sessionFor(app, { tenantId: 1, role: 'owner' });
    tokenB = sessionFor(app, { tenantId: tenantB.id, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const store = () => new ContactStore(db.forTenant(1), '91');

describe('the contact book', () => {
    it('treats the number as the identity, so a second import updates', () => {
        const contacts = store();
        const first = contacts.upsert({ phone: '+91 98123 45001', name: 'Asha', source: 'import' });
        // The national form, with and without the trunk zero, is the same person.
        const second = contacts.upsert({ phone: '09812345001', name: 'Asha Patel', source: 'import' });
        const third = contacts.upsert({ phone: '9812345001', name: 'Asha P', source: 'import' });
        assert.equal(first.id, second.id, 'the same number is the same contact');
        assert.equal(third.id, first.id);
        assert.equal(contacts.get(first.id).name, 'Asha P');
        assert.equal(contacts.count({ search: '9812345001' }), 1);
    });

    it('does not re-prefix a number that is already normalised', () => {
        const contacts = store();
        // normalizePhone takes what a human typed, so a bare 91... under country
        // code 91 is a national number: callers that already normalised say so.
        const typed = contacts.normalize('919812345099');
        assert.equal(typed, '91919812345099', 'unflagged, it is treated as national');
        assert.equal(contacts.normalize('919812345099', true), '919812345099');

        const saved = contacts.importMany([{ phone: '919812345099', name: 'Pre' }], { normalized: true });
        assert.equal(saved.created, 1);
        assert.equal(contacts.getByPhone('919812345099').name, 'Pre');
    });

    it('rejects a number it cannot make sense of', () => {
        assert.throws(() => store().upsert({ phone: 'not-a-number' }), /phone|number|digit/i);
    });

    it('stores whatever the business tracks, without a schema change', () => {
        const contacts = store();
        const clinic = contacts.upsert({
            phone: '+919812345002', name: 'Ravi',
            customFields: { patient_id: 'P-104', doctor: 'Mehta', appointment_date: '2026-03-04' },
            tags: ['Patient', 'patient', ' VIP '],
        });
        assert.deepEqual(clinic.customFields,
            { patient_id: 'P-104', doctor: 'Mehta', appointment_date: '2026-03-04' });
        assert.deepEqual(clinic.tags, ['patient', 'vip'], 'tags are normalised and deduped');

        const school = contacts.upsert({
            phone: '+919812345003', name: 'Priya',
            customFields: { student_id: 'S-22', class: '8B', parent_name: 'Neha' },
            tags: ['parent'],
        });
        assert.equal(school.customFields.class, '8B');
        assert.ok(contacts.fieldKeys().includes('patient_id'));
        assert.ok(contacts.fieldKeys().includes('student_id'));
    });

    it('merges on import but replaces on an explicit edit', () => {
        const contacts = store();
        contacts.upsert({ phone: '+919812345004', tags: ['lead'], customFields: { city: 'Pune' } });
        const merged = contacts.upsert({ phone: '+919812345004', tags: ['warm'], customFields: { source_ad: 'fb' } });
        assert.deepEqual(merged.tags.sort(), ['lead', 'warm']);
        assert.deepEqual(merged.customFields, { city: 'Pune', source_ad: 'fb' });

        const replaced = contacts.upsert({ phone: '+919812345004', tags: ['customer'], customFields: { city: 'Mumbai' } },
            { merge: false });
        assert.deepEqual(replaced.tags, ['customer']);
        assert.deepEqual(replaced.customFields, { city: 'Mumbai' });
    });

    it('counts the tags in use', () => {
        const tags = store().tags();
        const names = tags.map((t) => t.tag);
        assert.ok(names.includes('patient'));
        assert.ok(tags.every((t) => t.count >= 1));
    });

    it('reports a bulk import row by row instead of failing the batch', () => {
        const result = store().importMany([
            { phone: '+919812345010', name: 'One' },
            { phone: 'rubbish', name: 'Bad' },
            { phone: '+919812345011', name: 'Two', extra: { ref: 'A1' } },
            { phone: '+919812345010', name: 'One Again' },
        ], { tags: ['batch'] });
        assert.equal(result.created, 2);
        assert.equal(result.updated, 1, 'the repeat of 010 updated it');
        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0].phone, 'rubbish');
        assert.equal(store().getByPhone('919812345011').customFields.ref, 'A1',
            'the importer\'s leftover columns become custom fields');
    });
});

describe('filters and segments', () => {
    before(() => {
        const contacts = store();
        contacts.upsert({ phone: '+919820000001', name: 'Seg A', tags: ['seg-vip', 'seg-pune'], customFields: { plan: 'gold' } });
        contacts.upsert({ phone: '+919820000002', name: 'Seg B', tags: ['seg-vip'], customFields: { plan: 'silver' } });
        contacts.upsert({ phone: '+919820000003', name: 'Seg C', tags: ['seg-pune'], customFields: { plan: 'gold' } });
        contacts.upsert({ phone: '+919820000004', name: 'Seg D', tags: [], status: 'archived' });
    });

    it('narrows by all tags, any tag and excluded tags', () => {
        const contacts = store();
        const all = contacts.find({ tags: ['seg-vip', 'seg-pune'] }).map((c) => c.name);
        assert.deepEqual(all, ['Seg A'], 'tags means every one of them');

        const any = contacts.find({ anyTags: ['seg-vip', 'seg-pune'] }).map((c) => c.name).sort();
        assert.deepEqual(any, ['Seg A', 'Seg B', 'Seg C']);

        const without = contacts.find({ tags: ['seg-pune'], notTags: ['seg-vip'] }).map((c) => c.name);
        assert.deepEqual(without, ['Seg C']);
    });

    it('narrows by a custom field, a status and a search', () => {
        const contacts = store();
        assert.deepEqual(contacts.find({ custom: { plan: 'gold' } }).map((c) => c.name).sort(),
            ['Seg A', 'Seg C']);
        assert.deepEqual(contacts.find({ status: 'archived' }).map((c) => c.name), ['Seg D']);
        assert.deepEqual(contacts.find({ search: 'Seg B' }).map((c) => c.name), ['Seg B']);
    });

    it('knows who may actually be messaged', () => {
        const contacts = store();
        db.forTenant(1).addOptOut('919820000002', 'test');
        assert.equal(contacts.getByPhone('919820000002').optedOut, true);
        assert.equal(contacts.getByPhone('919820000002').messageable, false);
        assert.equal(contacts.getByPhone('919820000001').messageable, true);
        assert.equal(contacts.getByPhone('919820000004').messageable, false, 'archived is not messageable');

        assert.deepEqual(contacts.find({ tags: ['seg-vip'], optedOut: false }).map((c) => c.name), ['Seg A']);
        assert.deepEqual(contacts.find({ optedOut: true }).map((c) => c.name), ['Seg B']);
        db.forTenant(1).removeOptOut('919820000002');
    });

    it('re-evaluates a segment on every use, so it cannot go stale', () => {
        const contacts = store();
        const segment = contacts.saveSegment({ name: 'Gold plan', filter: { custom: { plan: 'gold' } } });
        assert.equal(contacts.segmentContacts(segment.id).length, 2);

        contacts.upsert({ phone: '+919820000005', name: 'Seg E', customFields: { plan: 'gold' } });
        assert.equal(contacts.segmentContacts(segment.id).length, 3,
            'a contact that matches later is in the segment later');

        assert.equal(contacts.listSegments().find((s) => s.id === segment.id).count, 3);
        contacts.deleteSegment(segment.id);
        assert.equal(contacts.getSegment(segment.id), null);
    });

    it('builds a timeline from what was actually sent and received', () => {
        const scoped = db.forTenant(1);
        const contacts = store();
        const contact = contacts.upsert({ phone: '+919830000001', name: 'Timeline' });
        scoped.insert({
            messageId: 'tl-out-1', recipient: '919830000001', message: 'we sent this',
            status: 'SENT', messageType: 'campaign',
        });
        scoped.insertInbound({ messageId: 'tl-in-1', sender: '919830000001', body: 'they replied' });

        const timeline = contacts.timeline(contact.id);
        assert.equal(timeline.length, 2);
        assert.ok(timeline.some((e) => e.direction === 'outbound' && e.body === 'we sent this'));
        assert.ok(timeline.some((e) => e.direction === 'inbound' && e.body === 'they replied'));
    });
});

describe('the contacts API', () => {
    it('creates, reads, edits and deletes', async () => {
        const made = await call(token, 'POST', '/api/contacts', {
            phone: '+919840000001', name: 'Api One', email: 'one@example.com',
            tags: ['api'], customFields: { ref: 'R1' },
        });
        assert.equal(made.status, 201);
        const id = made.body.contact.id;

        const again = await call(token, 'POST', '/api/contacts', { phone: '+919840000001', name: 'Api One Again' });
        assert.equal(again.status, 200, 'the same number is an update, not a second contact');
        assert.equal(again.body.contact.id, id);

        const read = await call(token, 'GET', `/api/contacts/${id}`);
        assert.equal(read.body.contact.customFields.ref, 'R1');

        const tagged = await call(token, 'POST', `/api/contacts/${id}/tags`, { add: ['vip'], remove: ['api'] });
        assert.deepEqual(tagged.body.contact.tags, ['vip']);

        const listed = await call(token, 'GET', '/api/contacts?tags=vip');
        assert.ok(listed.body.contacts.some((c) => c.id === id));
        assert.ok(listed.body.total >= 1);

        assert.equal((await call(token, 'DELETE', `/api/contacts/${id}`)).status, 200);
        assert.equal((await call(token, 'GET', `/api/contacts/${id}`)).status, 404);
    });

    it('keeps one tenant\'s book out of another\'s', async () => {
        const mine = (await call(token, 'POST', '/api/contacts', { phone: '+919850000001', name: 'Mine' })).body.contact;
        await call(tokenB, 'POST', '/api/contacts', { phone: '+919850000002', name: 'Theirs' });

        const theirList = (await call(tokenB, 'GET', '/api/contacts')).body.contacts.map((c) => c.name);
        assert.ok(!theirList.includes('Mine'));

        assert.equal((await call(tokenB, 'GET', `/api/contacts/${mine.id}`)).status, 404,
            'guessing an id reaches nothing');
        assert.equal((await call(tokenB, 'DELETE', `/api/contacts/${mine.id}`)).status, 404);
        assert.equal((await call(tokenB, 'POST', `/api/contacts/${mine.id}/tags`, { add: ['x'] })).status, 404);

        // The same number can exist in both books, independently.
        const shared = '+919850000009';
        await call(token, 'POST', '/api/contacts', { phone: shared, name: 'A side', tags: ['a'] });
        await call(tokenB, 'POST', '/api/contacts', { phone: shared, name: 'B side', tags: ['b'] });
        assert.equal((await call(token, 'GET', '/api/contacts?search=9850000009')).body.contacts[0].name, 'A side');
        assert.equal((await call(tokenB, 'GET', '/api/contacts?search=9850000009')).body.contacts[0].name, 'B side');
    });

    it('saves a segment and uses it as a campaign audience', async () => {
        await call(token, 'POST', '/api/contacts', { phone: '+919860000001', name: 'Aud One', tags: ['launch'] });
        await call(token, 'POST', '/api/contacts', { phone: '+919860000002', name: 'Aud Two', tags: ['launch'] });
        await call(token, 'POST', '/api/contacts', { phone: '+919860000003', name: 'Aud Out', tags: ['launch'] });
        await call(token, 'POST', '/api/optouts', { phone: '+919860000003', reason: 'test' });

        const segment = (await call(token, 'POST', '/api/segments',
            { name: 'Launch list', filter: { tags: ['launch'] } })).body.segment;
        assert.equal((await call(token, 'GET', `/api/segments/${segment.id}/contacts`)).body.contacts.length, 3);

        await call(token, 'POST', '/api/connection/connect');
        const started = await call(token, 'POST', '/api/campaign/start',
            { segmentId: segment.id, template: 'Hi {name}', onePerNumber: true });
        assert.equal(started.status, 200);
        assert.equal(started.body.audience, 2, 'the opted-out contact is not in the audience');

        assert.equal((await call(tokenB, 'GET', `/api/segments/${segment.id}/contacts`)).status, 404,
            'a segment belongs to its tenant');
        await call(token, 'DELETE', `/api/optouts/919860000003`);
    });

    it('only saves imported rows when asked to', async () => {
        const csv = 'name,phone,city\nIsha,+919870000001,Pune\nRohan,+919870000002,Mumbai\n';
        const form = () => {
            const data = new FormData();
            data.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv');
            return data;
        };

        const parsed = await fetch(`${base}/api/contacts/import`, {
            method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form(),
        }).then((r) => r.json());
        assert.equal(parsed.contacts.length, 2);
        assert.equal(parsed.saved, undefined, 'preview does not write to the book');
        assert.equal(store().getByPhone('919870000001'), null);

        const saved = await fetch(`${base}/api/contacts/import?save=true&tags=imported`, {
            method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form(),
        }).then((r) => r.json());
        assert.equal(saved.saved.created, 2);
        const isha = store().getByPhone('919870000001');
        assert.equal(isha.name, 'Isha');
        assert.equal(isha.customFields.city, 'Pune');
        assert.deepEqual(isha.tags, ['imported']);
    });

    it('lets an agent read the book but not rewrite it', async () => {
        const agent = sessionFor(app, { tenantId: 1, role: 'agent' });
        assert.equal((await call(agent, 'GET', '/api/contacts')).status, 200);
        assert.equal((await call(agent, 'POST', '/api/contacts', { phone: '+919880000001' })).status, 403);
        assert.equal((await call(agent, 'POST', '/api/segments', { name: 'nope' })).status, 403);
    });
});
