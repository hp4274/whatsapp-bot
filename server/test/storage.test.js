/**
 * Storage: the per-tenant library of uploaded files and its duplicate check.
 *
 * The HTTP tests share the real server/uploads directory (as the media tests
 * do), so every name and byte string carries a per-run tag and the tests only
 * look at their own files.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { closeApp } from '../src/app.js';
import { DEFAULTS, TRANSPORT_SANDBOX } from '../src/config.js';
import { Database } from '../src/db.js';
import { MediaStore } from '../src/mediaStore.js';
import { StorageStore, sha256Of } from '../src/storage/store.js';
import { createTestApp, sessionFor } from './helpers.js';

const UPLOADS = path.resolve(import.meta.dirname, '..', 'uploads');
const tag = `st${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wsender-storage-'));

const csv = (label, rows = 2) => Buffer.from(
    `name,phone\n${Array.from({ length: rows }, (_, i) => `${label}${i},91981${String(i).padStart(7, '0')}`).join('\n')}\n`);
const pdf = (label) => Buffer.from(`%PDF-1.4 ${tag} ${label}`);
const onDisk = (needle) => fs.readdirSync(UPLOADS).filter((name) => name.includes(needle));

let app;
let server;
let base;
let db;
let tenantB;
const tokens = {};
const made = []; // mediaIds to clean out of the shared uploads directory

const call = async (token, method, url, body) => {
    const res = await fetch(base + url, {
        method,
        headers: { ...(body ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const json = res.headers.get('content-type')?.includes('json');
    return { status: res.status, body: text && json ? JSON.parse(text) : text, headers: res.headers };
};

const upload = async (token, url, buffer, name, type) => {
    const form = new FormData();
    form.set('file', new Blob([buffer], { type }), name);
    const res = await fetch(base + url, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    const body = await res.json();
    if (body.mediaId) made.push(body.mediaId);
    return { status: res.status, body };
};
const sheet = (token, buffer, name) => upload(token, '/api/campaign/import/preview', buffer, name, 'text/csv');
const media = (token, buffer, name) => upload(token, '/api/media/upload', buffer, name, 'application/pdf');
const list = async (token, query = '') => (await call(token, 'GET', `/api/storage${query}`)).body;

before(async () => {
    db = new Database(path.join(tmp, 's.db'));
    app = createTestApp({
        db,
        dataDir: tmp,
        config: { ...DEFAULTS, transport: TRANSPORT_SANDBOX, rateLimitPerSecond: 1000 },
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    tenantB = app.locals.tenancy.createTenant('Storage B', 'storage-b');
    tokens.ownerA = sessionFor(app, { tenantId: 1, role: 'owner' });
    tokens.agentA = sessionFor(app, { tenantId: 1, role: 'agent' });
    tokens.ownerB = sessionFor(app, { tenantId: tenantB.id, role: 'owner' });
});

after(async () => {
    await closeApp(app);
    server?.close();
    db?.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const name of fs.readdirSync(UPLOADS)) {
        if (name.includes(tag) || made.some((id) => name.startsWith(id))) fs.rmSync(path.join(UPLOADS, name), { force: true });
    }
});

describe('duplicate sheets', () => {
    it('stores the same bytes once: one row, one file, duplicate flagged, a fresh importId each time', async () => {
        const bytes = csv('dup');
        const first = await sheet(tokens.ownerA, bytes, `${tag}-dup.csv`);
        assert.equal(first.status, 200);
        assert.equal(first.body.duplicate, false);
        assert.equal(typeof first.body.storageId, 'number');
        assert.ok(first.body.importId.startsWith('imp_'));
        assert.equal(first.body.total, 2);

        const second = await sheet(tokens.ownerA, bytes, `${tag}-dup.csv`);
        assert.equal(second.status, 200);
        assert.equal(second.body.duplicate, true);
        assert.equal(second.body.storageId, first.body.storageId);
        assert.equal(second.body.firstUploadedAt, first.body.firstUploadedAt);
        assert.notEqual(second.body.importId, first.body.importId);
        assert.deepEqual(second.body.headers, first.body.headers);

        const { files } = await list(tokens.ownerA, `?q=${tag}-dup`);
        assert.equal(files.length, 1);
        assert.equal(files[0].uses, 2);
        assert.equal(files[0].kind, 'sheet');
        assert.equal(files[0].rows, 2);
        assert.equal(files[0].mediaId, null);
        assert.equal(files[0].sha256, sha256Of(bytes));
        assert.equal(onDisk(`${tag}-dup.csv`).length, 1);
    });

    it('stores different bytes as separate entries', async () => {
        const one = await sheet(tokens.ownerA, csv('diff-a'), `${tag}-diff.csv`);
        const two = await sheet(tokens.ownerA, csv('diff-b'), `${tag}-diff.csv`);
        assert.equal(two.body.duplicate, false);
        assert.notEqual(two.body.storageId, one.body.storageId);
        assert.equal((await list(tokens.ownerA, `?q=${tag}-diff`)).files.length, 2);
    });

    it('never stores a file the preview refuses', async () => {
        const empty = await sheet(tokens.ownerA, Buffer.from('name,phone\n'), `${tag}-empty.csv`);
        assert.equal(empty.status, 400);
        assert.deepEqual((await list(tokens.ownerA, `?q=${tag}-empty`)).files, []);
        assert.deepEqual(onDisk(`${tag}-empty.csv`), []);
    });
});

describe('duplicate media', () => {
    it('answers an identical upload with the earlier media: 200, same id, one file', async () => {
        const bytes = pdf('same');
        const first = await media(tokens.ownerA, bytes, `${tag}-same.pdf`);
        assert.equal(first.status, 201);
        assert.equal(first.body.duplicate, false);
        assert.match(first.body.mediaId, /^med_/);

        const second = await media(tokens.ownerA, bytes, `${tag}-same.pdf`);
        assert.equal(second.status, 200);
        assert.equal(second.body.duplicate, true);
        assert.equal(second.body.mediaId, first.body.mediaId);
        assert.equal(second.body.storageId, first.body.storageId);
        assert.equal(second.body.firstUploadedAt, first.body.firstUploadedAt);
        assert.equal(second.body.url, first.body.url);

        const { files } = await list(tokens.ownerA, `?kind=media&q=${tag}-same`);
        assert.equal(files.length, 1);
        assert.equal(files[0].uses, 2);
        assert.equal(files[0].mediaId, first.body.mediaId);
        assert.equal(onDisk(`${tag}-same.pdf`).length, 1);
    });

    it('keeps different bytes apart', async () => {
        const one = await media(tokens.ownerA, pdf('a'), `${tag}-apart.pdf`);
        const two = await media(tokens.ownerA, pdf('b'), `${tag}-apart.pdf`);
        assert.equal(two.status, 201);
        assert.notEqual(two.body.mediaId, one.body.mediaId);
        assert.equal((await list(tokens.ownerA, `?q=${tag}-apart`)).files.length, 2);
    });

    it('does not store a rejected upload', async () => {
        const bad = await upload(tokens.ownerA, '/api/media/upload', Buffer.from('<html>'), `${tag}-bad.png`, 'image/png');
        assert.equal(bad.status, 400);
        assert.deepEqual((await list(tokens.ownerA, `?q=${tag}-bad`)).files, []);
    });
});

describe('tenant isolation', () => {
    it('keeps identical bytes in separate rows and files per tenant, invisible across', async () => {
        const bytes = csv('iso');
        const a = await sheet(tokens.ownerA, bytes, `${tag}-iso.csv`);
        const b = await sheet(tokens.ownerB, bytes, `${tag}-iso.csv`);
        assert.equal(b.body.duplicate, false, 'another tenant is not a duplicate');
        assert.notEqual(b.body.storageId, a.body.storageId);
        assert.equal(onDisk(`${tag}-iso.csv`).length, 2);

        const pdfBytes = pdf('iso');
        const ma = await media(tokens.ownerA, pdfBytes, `${tag}-iso.pdf`);
        const mb = await media(tokens.ownerB, pdfBytes, `${tag}-iso.pdf`);
        assert.equal(mb.status, 201);
        assert.notEqual(mb.body.mediaId, ma.body.mediaId);
        assert.equal(onDisk(`${tag}-iso.pdf`).length, 2);

        const seenByB = (await list(tokens.ownerB, `?q=${tag}-iso`)).files;
        assert.deepEqual(seenByB.map((f) => f.id).sort(), [b.body.storageId, mb.body.storageId].sort());
        const seenByA = (await list(tokens.ownerA, `?q=${tag}-iso`)).files;
        assert.deepEqual(seenByA.map((f) => f.id).sort(), [a.body.storageId, ma.body.storageId].sort());

        assert.equal((await call(tokens.ownerB, 'GET', `/api/storage/${a.body.storageId}/download`)).status, 404);
        assert.equal((await call(tokens.ownerB, 'POST', `/api/storage/${a.body.storageId}/use`)).status, 404);
        assert.equal((await call(tokens.ownerB, 'DELETE', `/api/storage/${a.body.storageId}`)).status, 404);
        assert.equal((await list(tokens.ownerA, `?q=${tag}-iso`)).files.length, 2, 'still there');
    });
});

describe('listing', () => {
    it('filters by kind and case-insensitive name, orders by last use, totals the filtered set', async () => {
        const older = await sheet(tokens.ownerA, csv('list-a'), `${tag}-List-Alpha.csv`);
        const newer = await sheet(tokens.ownerA, csv('list-b', 4), `${tag}-list-beta.csv`);
        await media(tokens.ownerA, pdf('list'), `${tag}-list-gamma.pdf`);
        // Timestamps have one-second resolution: pin the uploads to known days.
        const setUsed = db.db.prepare('UPDATE stored_files SET last_used_at = ? WHERE id = ?');
        setUsed.run('2020-01-01T00:00:00+00:00', older.body.storageId);
        setUsed.run('2020-01-02T00:00:00+00:00', newer.body.storageId);
        const query = `?kind=sheet&q=${tag.toUpperCase()}-LIST`;
        assert.deepEqual((await list(tokens.ownerA, query)).files.map((f) => f.id), [newer.body.storageId, older.body.storageId]);
        // Using the older one moves it to the front.
        await call(tokens.ownerA, 'POST', `/api/storage/${older.body.storageId}/use`);

        const sheets = await list(tokens.ownerA, query);
        assert.deepEqual(sheets.files.map((f) => f.id), [older.body.storageId, newer.body.storageId]);
        assert.equal(sheets.totals.count, 2);
        assert.equal(sheets.totals.bytes, sheets.files.reduce((n, f) => n + f.size, 0));
        assert.equal((await list(tokens.ownerA, `?kind=media&q=${tag}-list`)).files.length, 1);
        assert.equal((await call(tokens.ownerA, 'GET', '/api/storage?kind=bogus')).status, 400);
    });

    it('is readable by an agent but only an admin may delete', async () => {
        const one = await sheet(tokens.ownerA, csv('role'), `${tag}-role.csv`);
        assert.equal((await call(tokens.agentA, 'GET', '/api/storage')).status, 200);
        assert.equal((await call(tokens.agentA, 'DELETE', `/api/storage/${one.body.storageId}`)).status, 403);
    });
});

describe('download and use', () => {
    it('downloads the exact bytes as an attachment with the right type', async () => {
        const bytes = csv('down');
        const up = await sheet(tokens.ownerA, bytes, `${tag}-down.csv`);
        const res = await fetch(`${base}/api/storage/${up.body.storageId}/download`, {
            headers: { authorization: `Bearer ${tokens.ownerA}` },
        });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-disposition'), `attachment; filename="${tag}-down.csv"`);
        assert.match(res.headers.get('content-type'), /^text\/csv/);
        assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);

        const m = await media(tokens.ownerA, pdf('down'), `${tag}-down.pdf`);
        const pdfRes = await fetch(`${base}/api/storage/${m.body.storageId}/download`, {
            headers: { authorization: `Bearer ${tokens.ownerA}` },
        });
        assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');

        const missing = await call(tokens.ownerA, 'GET', '/api/storage/999999/download');
        assert.equal(missing.status, 404);
        assert.ok(Array.isArray(missing.body.errors));
    });

    it('uses a stored sheet: a new import session, uses bumped, nothing re-stored', async () => {
        const up = await sheet(tokens.ownerA, csv('use', 3), `${tag}-use.csv`);
        const used = await call(tokens.ownerA, 'POST', `/api/storage/${up.body.storageId}/use`);
        assert.equal(used.status, 200);
        assert.equal(used.body.file.uses, 2);
        assert.equal(used.body.media, undefined);
        assert.notEqual(used.body.preview.importId, up.body.importId);
        assert.equal(used.body.preview.total, 3);
        assert.deepEqual(used.body.preview.headers, up.body.headers);
        assert.equal(used.body.preview.storageId, up.body.storageId);

        // The new session is real: the wizard's next step accepts it.
        const audit = await call(tokens.ownerA, 'POST', '/api/campaign/import/audit', {
            importId: used.body.preview.importId,
            mapping: used.body.preview.guess,
        });
        assert.equal(audit.status, 200);
        assert.equal(onDisk(`${tag}-use.csv`).length, 1);
    });

    it('uses stored media: the same media object an upload returns', async () => {
        const up = await media(tokens.ownerA, pdf('use'), `${tag}-use.pdf`);
        const used = await call(tokens.ownerA, 'POST', `/api/storage/${up.body.storageId}/use`);
        assert.equal(used.status, 200);
        assert.equal(used.body.preview, undefined);
        assert.equal(used.body.media.mediaId, up.body.mediaId);
        assert.equal(used.body.media.filename, `${tag}-use.pdf`);
        assert.equal(used.body.media.url, up.body.url);
        assert.equal(used.body.file.uses, 2);
    });

    it('answers 410 and drops the row when the bytes are gone', async () => {
        const up = await sheet(tokens.ownerA, csv('gone'), `${tag}-gone.csv`);
        for (const name of onDisk(`${tag}-gone.csv`)) fs.rmSync(path.join(UPLOADS, name));
        const used = await call(tokens.ownerA, 'POST', `/api/storage/${up.body.storageId}/use`);
        assert.equal(used.status, 410);
        assert.deepEqual(used.body.errors, ['That file is no longer on disk - upload it again.']);
        assert.deepEqual((await list(tokens.ownerA, `?q=${tag}-gone`)).files, []);

        // And the same bytes can be uploaded again as a new file.
        const again = await sheet(tokens.ownerA, csv('gone'), `${tag}-gone.csv`);
        assert.equal(again.body.duplicate, false);
    });
});

describe('delete', () => {
    it('removes the row, the file and the media entry', async () => {
        const up = await media(tokens.ownerA, pdf('del'), `${tag}-del.pdf`);
        assert.equal(onDisk(`${tag}-del.pdf`).length, 1);
        assert.equal((await call(tokens.ownerA, 'GET', up.body.url)).status, 200);

        const res = await call(tokens.ownerA, 'DELETE', `/api/storage/${up.body.storageId}`);
        assert.deepEqual(res.body, { ok: true });
        assert.deepEqual(onDisk(`${tag}-del.pdf`), []);
        assert.equal(fs.existsSync(path.join(UPLOADS, `${up.body.mediaId}.tenant`)), false);
        assert.deepEqual((await list(tokens.ownerA, `?q=${tag}-del`)).files, []);
        assert.equal((await call(tokens.ownerA, 'GET', up.body.url)).status, 404);
        assert.equal((await call(tokens.ownerA, 'DELETE', `/api/storage/${up.body.storageId}`)).status, 404);

        const sh = await sheet(tokens.ownerA, csv('del'), `${tag}-del.csv`);
        assert.deepEqual((await call(tokens.ownerA, 'DELETE', `/api/storage/${sh.body.storageId}`)).body, { ok: true });
        assert.deepEqual(onDisk(`${tag}-del.csv`), []);
    });

    it('refuses with 409 while a draft campaign uses the media, allows it once that is gone', async () => {
        const up = await media(tokens.ownerA, pdf('busy'), `${tag}-busy.pdf`);
        const campaign = await call(tokens.ownerA, 'POST', '/api/campaigns', {
            name: `${tag} promo`, body: 'Hi {name}', mediaId: up.body.mediaId,
            audience: [{ name: 'Sam', phone: '919855500101' }],
        });
        assert.equal(campaign.status, 201, JSON.stringify(campaign.body));

        const refused = await call(tokens.ownerA, 'DELETE', `/api/storage/${up.body.storageId}`);
        assert.equal(refused.status, 409);
        assert.match(refused.body.errors[0], new RegExp(`draft campaign "${tag} promo"`));
        assert.equal(onDisk(`${tag}-busy.pdf`).length, 1, 'the file is untouched');
        assert.equal((await list(tokens.ownerA, `?q=${tag}-busy`)).files.length, 1);

        await call(tokens.ownerA, 'DELETE', `/api/campaigns/${campaign.body.campaign.id}`);
        assert.deepEqual((await call(tokens.ownerA, 'DELETE', `/api/storage/${up.body.storageId}`)).body, { ok: true });
    });

    it('refuses with 409 while a template uses the media as its header', async () => {
        const up = await media(tokens.ownerA, pdf('header'), `${tag}-header.pdf`);
        const template = await call(tokens.ownerA, 'POST', '/api/templates', {
            name: `${tag}-tpl`, body: 'See attached', headerMediaId: up.body.mediaId,
        });
        assert.equal(template.status, 201, JSON.stringify(template.body));

        const refused = await call(tokens.ownerA, 'DELETE', `/api/storage/${up.body.storageId}`);
        assert.equal(refused.status, 409);
        assert.match(refused.body.errors[0], new RegExp(`template "${tag}-tpl"`));

        await call(tokens.ownerA, 'DELETE', `/api/templates/${template.body.template.id}`);
        assert.equal((await call(tokens.ownerA, 'DELETE', `/api/storage/${up.body.storageId}`)).status, 200);
    });
});

describe('backfill', () => {
    it('indexes this tenant\'s earlier media once, oldest first, and leaves other tenants\' alone', async () => {
        const dir = fs.mkdtempSync(path.join(tmp, 'old-'));
        const put = (name, content, owner, mtime) => {
            fs.writeFileSync(path.join(dir, name), content);
            if (owner !== null) fs.writeFileSync(path.join(dir, `${name.slice(0, 16)}.tenant`), String(owner));
            fs.utimesSync(path.join(dir, name), mtime, mtime);
        };
        put('med_aaaaaaaaaaaa_old.pdf', '%PDF-1.4 one', 1, new Date('2026-01-01T10:00:00Z'));
        put('med_bbbbbbbbbbbb_copy.pdf', '%PDF-1.4 one', 1, new Date('2026-02-01T10:00:00Z')); // same bytes, newer
        put('med_cccccccccccc_theirs.pdf', '%PDF-1.4 theirs', tenantB.id, new Date('2026-01-02T10:00:00Z'));
        put('med_dddddddddddd_legacy.png', '\x89PNG\r\n\x1a\nlegacy', null, new Date('2026-01-03T10:00:00Z'));
        fs.writeFileSync(path.join(dir, 'file_t1_0123456789abcdef_sheet.csv'), 'a,b\n1,2\n'); // not media

        // Its own database: the HTTP tests above already ran (and memoised) tenant 1's backfill on `db`.
        const fresh = new Database(path.join(tmp, 'backfill.db'));
        const make = (tenantId) => new StorageStore(fresh.forTenant(tenantId), { uploadDir: dir, media: new MediaStore(dir, tenantId) });
        const one = make(1);
        await one.backfill();
        await one.backfill(); // second call is the memoised first
        const names = one.list().files.map((f) => f.name).sort();
        assert.deepEqual(names, ['legacy.png', 'old.pdf'], 'unmarked file goes to the default tenant; the byte-duplicate keeps only the oldest');
        const old = one.list({ q: 'old.pdf' }).files[0];
        assert.equal(old.createdAt, '2026-01-01T10:00:00+00:00');
        assert.equal(old.lastUsedAt, old.createdAt);
        assert.equal(old.mimetype, 'application/pdf');
        assert.equal(old.mediaId, 'med_aaaaaaaaaaaa');
        assert.equal(old.uses, 1);
        assert.equal(old.size, '%PDF-1.4 one'.length);
        assert.equal(fs.existsSync(path.join(dir, 'med_bbbbbbbbbbbb_copy.pdf')), true, 'nothing is removed from disk');

        const two = make(tenantB.id);
        await two.backfill();
        assert.deepEqual(two.list().files.map((f) => f.name), ['theirs.pdf'], 'no legacy file for a non-default tenant');

        // A fresh registry (a restart) re-creates the media from disk for a repeat upload.
        const reused = one.reuseMedia(sha256Of(Buffer.from('%PDF-1.4 one')));
        assert.equal(reused.media.mediaId, 'med_aaaaaaaaaaaa');
        assert.equal(reused.row.uses, 2);
        fresh.close();
    });
});
