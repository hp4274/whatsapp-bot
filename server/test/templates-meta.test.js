/**
 * Template metadata: Meta category, sample values, header media and the
 * interactive block - stored, validated, filtered, and migrated onto
 * databases that predate the columns.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { TemplateError, TemplateStore } from '../src/templates/store.js';
import { createTestApp } from './helpers.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-tplmeta-'));
let db;
let n = 0;
const name = (p) => `${p}-${(n += 1)}`;

before(() => { db = new Database(path.join(tmp, 'm.db')); });
after(() => {
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
});

const store = () => new TemplateStore(db.forTenant(1));
const BUTTONS = { type: 'buttons', footer: 'Reply below', buttons: [{ title: 'Yes' }, { id: 'NO', title: 'No' }] };

describe('template metadata in the store', () => {
    it('defaults to marketing with empty extras', () => {
        const t = store().create({ name: name('plain'), body: 'Hi' });
        assert.equal(t.category, 'marketing');
        assert.deepEqual(t.sampleValues, {});
        assert.equal(t.headerMediaId, null);
        assert.equal(t.interactive, null);
    });

    it('stores category, samples, header media and a normalized interactive block', () => {
        const t = store().create({
            name: name('rich'), body: 'Hi {name}', category: 'utility',
            sampleValues: { name: 'Asha', 'bad key': 'x', empty: '' },
            headerMediaId: ' med_0123456789ab ', interactive: BUTTONS,
        });
        assert.equal(t.category, 'utility');
        assert.deepEqual(t.sampleValues, { name: 'Asha' }, 'junk keys and blanks are dropped');
        assert.equal(t.headerMediaId, 'med_0123456789ab');
        assert.equal(t.interactive.type, 'buttons');
        assert.equal(t.interactive.buttons[0].id, 'YES', 'missing ids are derived from the title');
        assert.equal(t.interactive.buttons[1].id, 'NO');
    });

    it('updates the extras without writing a version, and clears them', () => {
        const templates = store();
        const t = templates.create({ name: name('upd'), body: 'Hi', interactive: BUTTONS, headerMediaId: 'med_0123456789ab' });
        const u = templates.update(t.id, { category: 'authentication', sampleValues: { code: '1234' } });
        assert.equal(u.category, 'authentication');
        assert.deepEqual(u.sampleValues, { code: '1234' });
        assert.equal(u.interactive.type, 'buttons', 'untouched fields survive a patch');
        assert.equal(u.currentVersion, 1, 'metadata is not wording');
        const cleared = templates.update(t.id, { interactive: { type: 'none' }, headerMediaId: null });
        assert.equal(cleared.interactive, null);
        assert.equal(cleared.headerMediaId, null);
    });

    it('refuses an unknown category, bad samples and an invalid interactive block', () => {
        const templates = store();
        assert.throws(() => templates.create({ name: name('c'), category: 'promo' }), TemplateError);
        assert.throws(() => templates.create({ name: name('s'), sampleValues: ['x'] }), TemplateError);
        assert.throws(() => templates.create({ name: name('i'), interactive: { type: 'buttons', buttons: [] } }), TemplateError);
        const t = templates.create({ name: name('ok') });
        assert.throws(() => templates.update(t.id, { category: 'nope' }), TemplateError);
        assert.throws(() => templates.update(t.id, { interactive: { type: 'carousel' } }), TemplateError);
    });

    it('filters the list by category', () => {
        const templates = store();
        const a = templates.create({ name: name('auth'), category: 'authentication' });
        const ids = templates.list({ category: 'authentication' }).map((t) => t.id);
        assert.ok(ids.includes(a.id));
        assert.ok(templates.list({ category: 'authentication' }).every((t) => t.category === 'authentication'));
    });
});

describe('migration', () => {
    it('adds the columns to a templates table that predates them, keeping rows', () => {
        const file = path.join(tmp, 'old.db');
        const raw = new DatabaseSync(file);
        raw.exec(`CREATE TABLE templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, name TEXT NOT NULL,
            template_type TEXT NOT NULL DEFAULT 'text', body TEXT NOT NULL DEFAULT '',
            variables TEXT NOT NULL DEFAULT '[]', channel_id INTEGER,
            provider_template_name TEXT NOT NULL DEFAULT '', approval_status TEXT NOT NULL DEFAULT 'draft',
            current_version INTEGER NOT NULL DEFAULT 1, use_count INTEGER NOT NULL DEFAULT 0,
            last_used_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            UNIQUE (tenant_id, name))`);
        raw.prepare("INSERT INTO templates (tenant_id, name, body, created_at, updated_at) VALUES (1, 'legacy', 'Old {x}', 'a', 'a')").run();
        raw.close();

        const migrated = new Database(file);
        try {
            const legacy = new TemplateStore(migrated).getByName('legacy');
            assert.equal(legacy.body, 'Old {x}');
            assert.equal(legacy.category, 'marketing');
            assert.deepEqual(legacy.sampleValues, {});
            assert.equal(legacy.interactive, null);
            const updated = new TemplateStore(migrated).update(legacy.id, { category: 'utility' });
            assert.equal(updated.category, 'utility');
        } finally {
            migrated.close();
        }
        // Opening again is a no-op, not a duplicate-column error.
        new Database(file).close();
    });
});

describe('template metadata over HTTP', () => {
    let app;
    let server;
    let base;
    let dataDb;

    before(async () => {
        dataDb = new Database(path.join(tmp, 'http.db'));
        const config = { ...DEFAULTS, transport: TRANSPORT_SANDBOX };
        delete config.misc;
        app = createTestApp({ db: dataDb, config });
        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        await closeApp(app);
        server?.close();
        dataDb?.close();
    });

    const api = async (method, url, body) => {
        const res = await fetch(base + url, {
            method,
            headers: body ? { 'content-type': 'application/json' } : undefined,
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        return { status: res.status, body: text ? JSON.parse(text) : null };
    };

    it('creates, updates and filters by category', async () => {
        const created = await api('POST', '/api/templates', {
            name: 'otp', body: 'Your code is {code}', category: 'authentication',
            sampleValues: { code: '482913' }, interactive: { type: 'cta', cta: [{ kind: 'copy', title: 'Copy code', value: '{code}' }] },
        });
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.template.category, 'authentication');
        assert.equal(created.body.template.interactive.cta[0].kind, 'copy');

        await api('POST', '/api/templates', { name: 'promo', body: 'Sale!' });
        const filtered = await api('GET', '/api/templates?category=authentication');
        assert.deepEqual(filtered.body.templates.map((t) => t.name), ['otp']);

        const updated = await api('PUT', `/api/templates/${created.body.template.id}`, { category: 'utility' });
        assert.equal(updated.status, 200);
        assert.equal(updated.body.template.category, 'utility');
    });

    it('rejects an invalid category or interactive block with 400', async () => {
        assert.equal((await api('POST', '/api/templates', { name: 'bad-cat', body: 'x', category: 'spam' })).status, 400);
        const bad = await api('POST', '/api/templates', { name: 'bad-int', body: 'x', interactive: { type: 'list', list: { sections: [] } } });
        assert.equal(bad.status, 400);
        assert.match(bad.body.errors[0], /list menu/);
    });

    it('accepts an uploaded header media id and refuses an unknown one', async () => {
        assert.equal((await api('POST', '/api/templates', { name: 'ghost-media', body: 'x', headerMediaId: 'med_ffffffffffff' })).status, 400);

        const form = new FormData();
        form.set('file', new Blob(['%PDF-1.4 test'], { type: 'application/pdf' }), 'Menu.pdf');
        const upload = await (await fetch(`${base}/api/media/upload`, { method: 'POST', body: form })).json();
        const ok = await api('POST', '/api/templates', { name: 'with-media', body: 'See attached', headerMediaId: upload.mediaId });
        assert.equal(ok.status, 201, JSON.stringify(ok.body));
        assert.equal(ok.body.template.headerMediaId, upload.mediaId);
    });
});
