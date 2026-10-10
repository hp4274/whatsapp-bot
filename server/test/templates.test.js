/**
 * Phase 5: the template library.
 *
 * The claims worth testing are that history is append-only (an edit to the
 * wording writes a version, a rename does not, and a revert adds rather than
 * deletes), that a render tells the caller which variables it could not fill
 * instead of shipping a brace to a customer, that the provider rules for
 * templates are enforced per transport, and that a template id is useless to
 * another tenant.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { TRANSPORT_CLOUD_API, TRANSPORT_SANDBOX, TRANSPORT_BAILEYS } from '../src/config.js';
import { Database } from '../src/db.js';
import { TEMPLATES_SCHEMA } from '../src/templates/schema.js';
import { TemplateStore, TemplateError, compatibility, validate } from '../src/templates/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-templates-'));
let db;
let tenantB;

before(() => {
    db = new Database(path.join(tmp, 't.db'));
    // The main thread wires this into MODULE_SCHEMAS; standalone we apply it.
    db.db.exec(TEMPLATES_SCHEMA);
    db.db.prepare("INSERT INTO tenants (name, slug, status, created_at) VALUES ('B', 'tpl-b', 'active', '2026-01-01T00:00:00+00:00')").run();
    tenantB = db.db.prepare("SELECT id FROM tenants WHERE slug = 'tpl-b'").get().id;
});

after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const store = (tenantId = 1) => new TemplateStore(db.forTenant(tenantId));
let n = 0;
const uniqueName = (prefix) => `${prefix}-${(n += 1)}`;

describe('template CRUD', () => {
    it('derives the declared variables from the body when none are given', () => {
        const templates = store();
        const created = templates.create({
            name: uniqueName('order-shipped'),
            body: 'Hi {name}, order {order_id} is on its way.',
        });
        assert.deepEqual(created.variables, ['name', 'order_id']);
        assert.equal(created.currentVersion, 1);
        assert.equal(created.approvalStatus, 'draft');
        assert.equal(created.channelId, null, 'unpinned means any channel');
        assert.deepEqual(templates.get(created.id), created);
        assert.deepEqual(templates.getByName(created.name), created);
    });

    it('refuses a nameless template, an unknown type and a duplicate name', () => {
        const templates = store();
        assert.throws(() => templates.create({ name: '   ' }), TemplateError);
        assert.throws(() => templates.create({ name: uniqueName('x'), templateType: 'carrier_pigeon' }), TemplateError);
        const name = uniqueName('dup');
        templates.create({ name });
        assert.throws(() => templates.create({ name }), (err) => err.status === 409);
    });

    it('lists by type, and a channel filter keeps the unpinned templates', () => {
        const templates = store();
        const any = templates.create({ name: uniqueName('any'), templateType: 'notification' });
        const pinned = templates.create({ name: uniqueName('pinned'), templateType: 'notification', channelId: 7 });
        templates.create({ name: uniqueName('elsewhere'), templateType: 'notification', channelId: 9 });

        const ids = templates.list({ type: 'notification', channelId: 7 }).map((t) => t.id);
        assert.deepEqual(ids, [any.id, pinned.id],
            'an unpinned template is usable on any channel; another channel\'s is not');
        assert.equal(templates.list({ type: 'media', channelId: 7 }).length, 0);
    });

    it('deletes a template and its history', () => {
        const templates = store();
        const created = templates.create({ name: uniqueName('temporary'), body: 'bye' });
        templates.remove(created.id);
        assert.equal(templates.get(created.id), null);
        assert.throws(() => templates.versions(created.id), (err) => err.status === 404);
    });
});

describe('versioning', () => {
    it('bumps the version for a reworded body but not for a rename', () => {
        const templates = store();
        const created = templates.create({ name: uniqueName('reminder'), body: 'Hi {name}.' });

        const renamed = templates.update(created.id, { name: uniqueName('reminder-renamed') });
        assert.equal(renamed.currentVersion, 1, 'a rename does not change what a recipient reads');

        const approved = templates.update(created.id, { approvalStatus: 'pending' });
        assert.equal(approved.currentVersion, 1, 'an approval flip is not a new wording');

        const edited = templates.update(created.id, { body: 'Hello {name}, see you soon.' });
        assert.equal(edited.currentVersion, 2);
        assert.deepEqual(edited.variables, ['name']);
        assert.equal(templates.versions(created.id).length, 2);
    });

    it('treats a change to the declared variables as a new version', () => {
        const templates = store();
        const created = templates.create({
            name: uniqueName('declared'),
            body: 'Hi {name}.',
            variables: ['name'],
        });
        const edited = templates.update(created.id, { variables: ['name', 'order_id'] });
        assert.equal(edited.currentVersion, 2);
    });

    it('keeps old versions readable verbatim', () => {
        const templates = store();
        const created = templates.create({ name: uniqueName('history'), body: 'first {name}' });
        templates.update(created.id, { body: 'second {name}' });
        templates.update(created.id, { body: 'third {name}' });

        assert.equal(templates.getVersion(created.id, 1).body, 'first {name}');
        assert.equal(templates.getVersion(created.id, 2).body, 'second {name}');
        assert.equal(templates.getVersion(created.id, 3).body, 'third {name}');
        assert.deepEqual(templates.versions(created.id).map((v) => v.version), [3, 2, 1]);
        assert.equal(templates.getVersion(created.id, 9), null);
    });

    it('reverts by writing the old body forward, never by deleting history', () => {
        const templates = store();
        const created = templates.create({ name: uniqueName('revert'), body: 'original {name}' });
        templates.update(created.id, { body: 'regrettable {name}' });

        const reverted = templates.revert(created.id, 1);
        assert.equal(reverted.body, 'original {name}');
        assert.equal(reverted.currentVersion, 3, 'a revert is a new version');
        assert.equal(templates.versions(created.id).length, 3);
        assert.equal(templates.getVersion(created.id, 2).body, 'regrettable {name}',
            'the mistake stays on the record, because a message went out with it');
        assert.throws(() => templates.revert(created.id, 9), (err) => err.status === 404);
    });
});

describe('rendering', () => {
    it('reports the variables the context did not supply', () => {
        const templates = store();
        const created = templates.create({
            name: uniqueName('render'),
            body: 'Hi {name}, order {order_id} arrives {due_date}.',
        });
        const result = templates.render(created.id, { name: 'Asha' });
        assert.deepEqual(result.missing, ['order_id', 'due_date']);
        assert.ok(result.body.includes('Hi Asha'));
        assert.ok(result.body.includes('{order_id}'), 'personalize leaves an unknown placeholder alone');

        const full = templates.render(created.id, { name: 'Asha', order_id: 'A-1', due_date: 'Friday' });
        assert.deepEqual(full.missing, []);
        assert.equal(full.body, 'Hi Asha, order A-1 arrives Friday.');
    });

    it('renders a named version rather than the current one', () => {
        const templates = store();
        const created = templates.create({ name: uniqueName('pinned-render'), body: 'v1 {name}' });
        templates.update(created.id, { body: 'v2 {name}' });
        assert.equal(templates.render(created.id, { name: 'Asha' }).body, 'v2 Asha');
        assert.equal(templates.render(created.id, { name: 'Asha' }, { version: 1 }).body, 'v1 Asha');
        assert.throws(() => templates.render(created.id, {}, { version: 9 }), (err) => err.status === 404);
    });

    it('previews with readable stand-ins for whatever the sample omits', () => {
        const templates = store();
        const created = templates.create({
            name: uniqueName('preview'),
            body: 'Hi {name}, your ticket {ticket_id} is open.',
        });
        const preview = templates.preview(created.id, { name: 'Asha' });
        assert.equal(preview.body, 'Hi Asha, your ticket [ticket_id] is open.');
    });
});

describe('variable validation', () => {
    it('catches a variable used but not declared', () => {
        const problems = validate({ body: 'Hi {name}, order {order_id}.', variables: ['name'] });
        assert.ok(problems.some((p) => p.includes('{order_id} is used in the body but not declared')), problems.join('; '));
    });

    it('catches a variable declared but never used', () => {
        const problems = validate({ body: 'Hi {name}.', variables: ['name', 'tracking_id'] });
        assert.ok(problems.some((p) => p.includes('tracking_id is declared but never used')), problems.join('; '));
    });

    it('catches malformed braces', () => {
        assert.ok(validate({ body: 'Hi {name' }).some((p) => p.includes('unbalanced braces')));
        assert.ok(validate({ body: 'Hi {first name}!', variables: [] }).some((p) => p.includes('malformed placeholder')));
        assert.ok(validate({ body: 'Hi {}!', variables: [] }).some((p) => p.includes('malformed placeholder')));
    });

    it('says nothing about a body whose declarations match', () => {
        assert.deepEqual(validate({ body: 'Hi {name}, order {order_id}.', variables: ['name', 'order_id'] }), []);
        assert.deepEqual(validate({ body: 'No variables here.' }), []);
    });

    it('is reachable from a store, for callers that already hold one', () => {
        assert.deepEqual(store().validate({ body: 'Hi {name}.' }), []);
    });
});

describe('channel compatibility', () => {
    const cloud = { id: 1, provider: TRANSPORT_CLOUD_API };
    const web = { id: 2, provider: TRANSPORT_BAILEYS };
    const sandbox = { id: 3, provider: TRANSPORT_SANDBOX };

    const providerTemplate = (overrides = {}) => ({
        templateType: 'provider_template',
        approvalStatus: 'approved',
        providerTemplateName: 'order_shipped',
        channelId: null,
        ...overrides,
    });

    it('allows an approved provider template only on Cloud API', () => {
        assert.deepEqual(compatibility(providerTemplate(), cloud), []);
        assert.ok(compatibility(providerTemplate(), web)
            .some((p) => p.includes('WhatsApp Web channel cannot send provider templates')));
        assert.ok(compatibility(providerTemplate(), sandbox)
            .some((p) => p.includes('need a Cloud API channel')));
    });

    it('refuses a provider template that Meta has not approved', () => {
        for (const status of ['draft', 'pending', 'rejected']) {
            const problems = compatibility(providerTemplate({ approvalStatus: status }), cloud);
            assert.ok(problems.some((p) => p.includes(`is ${status}, not approved`)), status);
        }
    });

    it('refuses a provider template with no provider-side name', () => {
        assert.ok(compatibility(providerTemplate({ providerTemplateName: '' }), cloud)
            .some((p) => p.includes('no provider template name')));
    });

    it('allows interactive messages only on Cloud API', () => {
        const interactive = { templateType: 'interactive', approvalStatus: 'draft', channelId: null };
        assert.deepEqual(compatibility(interactive, cloud), []);
        assert.ok(compatibility(interactive, web).some((p) => p.includes('interactive messages need a Cloud API channel')));
    });

    it('lets a plain text template go out on any transport', () => {
        const text = { templateType: 'text', approvalStatus: 'draft', channelId: null };
        for (const channel of [cloud, web, sandbox]) assert.deepEqual(compatibility(text, channel), []);
    });

    it('honours a channel pin', () => {
        const pinned = { templateType: 'text', approvalStatus: 'draft', channelId: 2 };
        assert.ok(compatibility(pinned, cloud).some((p) => p.includes('pinned to channel 2')));
        assert.deepEqual(compatibility(pinned, web), []);
    });

    it('reads the transport from a channel row that only carries settings', () => {
        assert.deepEqual(compatibility(providerTemplate(), { id: 4, settings: { transport: TRANSPORT_CLOUD_API } }), []);
    });
});

describe('usage statistics', () => {
    it('counts sends on the template row', () => {
        const templates = store();
        const created = templates.create({ name: uniqueName('used'), body: 'hi' });
        assert.equal(created.useCount, 0);
        assert.equal(created.lastUsedAt, null);

        templates.recordUse(created.id);
        const after2 = templates.recordUse(created.id);
        assert.equal(after2.useCount, 2);
        assert.ok(after2.lastUsedAt, 'a last-used timestamp is recorded');
    });
});

describe('tenant isolation', () => {
    it('makes another tenant\'s template id useless', () => {
        const a = store(1);
        const b = store(tenantB);
        const mine = a.create({ name: uniqueName('private'), body: 'secret {name}' });

        assert.equal(b.get(mine.id), null, 'a guessed id reads as not-found, not as data');
        assert.equal(b.getByName(mine.name), null);
        assert.ok(!b.list().some((t) => t.id === mine.id));
        assert.throws(() => b.update(mine.id, { body: 'tampered' }), (err) => err.status === 404);
        assert.throws(() => b.remove(mine.id), (err) => err.status === 404);
        assert.throws(() => b.versions(mine.id), (err) => err.status === 404);
        assert.throws(() => b.render(mine.id, {}), (err) => err.status === 404);
        assert.throws(() => b.recordUse(mine.id), (err) => err.status === 404);
        assert.throws(() => b.revert(mine.id, 1), (err) => err.status === 404);

        // Nothing above touched tenant A's row.
        const after2 = a.get(mine.id);
        assert.equal(after2.body, 'secret {name}');
        assert.equal(after2.currentVersion, 1);
        assert.equal(after2.useCount, 0);
    });

    it('lets two tenants hold the same template name independently', () => {
        const a = store(1);
        const b = store(tenantB);
        a.create({ name: 'shared-name', body: 'tenant A {name}' });
        b.create({ name: 'shared-name', body: 'tenant B {name}' });
        assert.equal(a.getByName('shared-name').body, 'tenant A {name}');
        assert.equal(b.getByName('shared-name').body, 'tenant B {name}');
    });
});
