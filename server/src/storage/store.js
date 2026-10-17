/**
 * Per-tenant library of files the tenant has uploaded before (campaign contact
 * sheets and media attachments), so a list or an image is uploaded once and
 * reused. Identity is the SHA-256 of the bytes, per tenant.
 *
 * This store never sends and never parses: the upload handlers in app.js
 * validate first and only then ask it to remember the file.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_TENANT_ID } from '../db.js';
import { MEDIA_MIME } from '../mediaStore.js';
import { utcNow } from '../protocol.js';

export const KINDS = Object.freeze(['sheet', 'media']);
export const GONE = 'That file is no longer on disk - upload it again.';

const SHEET_MIME = {
    '.csv': 'text/csv',
    '.xls': 'application/vnd.ms-excel',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroEnabled.12',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export class StorageError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** One filename rule for every upload, so a stored name is safe in a path and in a header. */
export const safeName = (name) => path.basename(String(name)).replace(/[^\w.\- ]+/g, '_');

export const sha256Of = (buffer) => crypto.hash('sha256', buffer);

/** The three fields both upload responses carry. */
export const uploadInfo = (row, duplicate) => ({
    storageId: row.id, duplicate, firstUploadedAt: row.created_at,
});

export function toFile(row) {
    return {
        id: row.id,
        kind: row.kind,
        name: row.name,
        mimetype: row.mimetype,
        size: row.size,
        sha256: row.sha256,
        rows: row.rows ?? null,
        mediaId: row.media_id ?? null,
        uses: row.uses,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
    };
}

const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');

/** sqlite connection -> tenant id -> the backfill promise: once per tenant per process. */
const backfills = new WeakMap();

export class StorageStore {
    /**
     * @param {import('../db.js').Database} database a tenant-scoped handle
     * @param {object} deps
     * @param {string} deps.uploadDir
     * @param {import('../mediaStore.js').MediaStore} deps.media  where uploaded media is registered
     */
    constructor(database, { uploadDir, media }) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.uploadDir = uploadDir;
        this.media = media;
    }

    get(id) {
        return this.db.prepare('SELECT * FROM stored_files WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId) ?? null;
    }

    list({ kind = null, q = '' } = {}) {
        const where = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (kind) {
            where.push('kind = ?');
            args.push(kind);
        }
        const text = String(q ?? '').trim();
        if (text) {
            // instr, not LIKE: the text may hold % or _ and should match literally.
            where.push('instr(lower(name), lower(?)) > 0');
            args.push(text);
        }
        // id breaks ties: timestamps have one-second resolution.
        const files = this.db.prepare(
            `SELECT * FROM stored_files WHERE ${where.join(' AND ')} ORDER BY last_used_at DESC, id DESC`)
            .all(...args).map(toFile);
        return { files, totals: { count: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) } };
    }

    /**
     * The row for these bytes if the file is still on disk. A row whose file
     * vanished is dropped here, so a stale entry never blocks a fresh upload.
     */
    find(sha256, kind) {
        const row = this.db.prepare('SELECT * FROM stored_files WHERE tenant_id = ? AND sha256 = ?')
            .get(this.tenantId, sha256);
        if (!row || row.kind !== kind) return null;
        return this.pathOf(row) ? row : null;
    }

    /** The file's path, or null (and the stale row dropped) when its bytes are gone. */
    pathOf(row) {
        const file = path.join(this.uploadDir, row.stored_name);
        if (fs.existsSync(file)) return file;
        this.forget(row.id);
        return null;
    }

    /**
     * `created: false` means this tenant already has these bytes (an identical
     * upload finished first), and `row` is that earlier entry.
     */
    add({ kind, sha256, name, mimetype, size, storedName, mediaId = null, rows = null, at = utcNow() }) {
        const info = this.db.prepare(
            `INSERT OR IGNORE INTO stored_files (tenant_id, kind, sha256, name, mimetype, size, stored_name,
                                                 media_id, rows, uses, created_at, last_used_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
            .run(this.tenantId, kind, sha256, name, mimetype, size, storedName, mediaId, rows, at, at);
        const row = this.db.prepare('SELECT * FROM stored_files WHERE tenant_id = ? AND sha256 = ?')
            .get(this.tenantId, sha256);
        return { row, created: info.changes > 0 };
    }

    touch(id) {
        this.db.prepare('UPDATE stored_files SET uses = uses + 1, last_used_at = ? WHERE id = ? AND tenant_id = ?')
            .run(utcNow(), Number(id), this.tenantId);
        return this.get(id);
    }

    forget(id) {
        this.db.prepare('DELETE FROM stored_files WHERE id = ? AND tenant_id = ?').run(Number(id), this.tenantId);
    }

    /** Remember an uploaded sheet, or find the copy already stored. */
    saveSheet({ buffer, originalname }, total) {
        const sha256 = sha256Of(buffer);
        const known = this.find(sha256, 'sheet');
        if (known) return { row: this.touch(known.id), duplicate: true };
        const name = safeName(originalname);
        // The tenant is in the name: two tenants may upload identical bytes, and
        // deleting one tenant's copy must not remove the other's.
        const storedName = `file_t${this.tenantId}_${sha256.slice(0, 16)}_${name}`;
        fs.mkdirSync(this.uploadDir, { recursive: true });
        fs.writeFileSync(path.join(this.uploadDir, storedName), buffer);
        const { row } = this.add({
            kind: 'sheet', sha256, name, size: buffer.length, storedName, rows: total,
            mimetype: SHEET_MIME[path.extname(name).toLowerCase()] ?? 'text/plain',
        });
        return { row, duplicate: false };
    }

    /**
     * An earlier upload of these bytes, ready to attach again: registered in
     * the media registry (re-created from disk after a restart) and counted as
     * a use. Null when there is none, or it can no longer be resolved.
     */
    reuseMedia(sha256) {
        const row = this.find(sha256, 'media');
        if (!row) return null;
        const media = this.media.get(row.media_id);
        if (!media) {
            this.forget(row.id);
            return null;
        }
        return { row: this.touch(row.id), media };
    }

    /** Why this file cannot be deleted right now, or null. Plain words: they reach the operator. */
    inUse(row) {
        if (!row.media_id) return null;
        // Both are exact-match columns, so no JSON scan is needed. Auto-reply
        // media lives inside JSON config and is not checked: it falls back to text-only.
        const campaign = this.db.prepare(
            `SELECT name, status FROM campaigns WHERE tenant_id = ? AND media_id = ?
             AND status IN ('draft', 'scheduled', 'running', 'paused') LIMIT 1`)
            .get(this.tenantId, row.media_id);
        if (campaign) {
            return `It is attached to the ${campaign.status} campaign "${campaign.name}". Finish or delete that campaign first.`;
        }
        const template = this.db.prepare('SELECT name FROM templates WHERE tenant_id = ? AND header_media_id = ? LIMIT 1')
            .get(this.tenantId, row.media_id);
        return template ? `It is the header of the template "${template.name}". Remove it from the template first.` : null;
    }

    remove(row) {
        fs.rmSync(path.join(this.uploadDir, row.stored_name), { force: true });
        if (row.media_id) {
            fs.rmSync(path.join(this.uploadDir, `${row.media_id}.tenant`), { force: true });
            this.media.delete(row.media_id);
        }
        this.forget(row.id);
    }

    /** Index this tenant's media uploaded before the library existed. Runs once per tenant per process. */
    backfill() {
        let byTenant = backfills.get(this.db);
        if (!byTenant) backfills.set(this.db, byTenant = new Map());
        if (!byTenant.has(this.tenantId)) {
            byTenant.set(this.tenantId, this.#indexOldMedia().catch((err) => {
                byTenant.delete(this.tenantId); // try again on the next request
                throw err;
            }));
        }
        return byTenant.get(this.tenantId);
    }

    async #indexOldMedia() {
        let names;
        try {
            names = fs.readdirSync(this.uploadDir);
        } catch {
            return; // nothing has been uploaded yet
        }
        const present = new Set(names);
        const indexed = new Set(this.db.prepare('SELECT media_id FROM stored_files WHERE tenant_id = ? AND media_id IS NOT NULL')
            .all(this.tenantId).map((r) => r.media_id));
        const old = [];
        for (const name of names) {
            const match = /^(med_[a-f0-9]{12})_(.+)$/.exec(name);
            if (!match || indexed.has(match[1])) continue;
            const marker = `${match[1]}.tenant`;
            const owner = present.has(marker) ? fs.readFileSync(path.join(this.uploadDir, marker), 'utf8').trim() : null;
            // MediaStore serves an unmarked (pre-tenancy) file to anyone. Listing it in
            // every tenant's library would show one business's old files to the rest,
            // so only the default tenant, whose they were, gets them.
            if (owner === null ? this.tenantId !== DEFAULT_TENANT_ID : owner !== String(this.tenantId)) continue;
            try {
                const stat = fs.statSync(path.join(this.uploadDir, name));
                old.push({ name, mediaId: match[1], filename: match[2], mtime: stat.mtimeMs, size: stat.size });
            } catch { /* removed since the listing */ }
        }
        // ponytail: byte-identical old files keep only the oldest one listed (the rest
        // stay on disk, unlisted, and are re-hashed on every start); clean up by hand.
        old.sort((a, b) => a.mtime - b.mtime);
        for (const file of old) {
            try {
                const buffer = await fs.promises.readFile(path.join(this.uploadDir, file.name));
                this.add({
                    kind: 'media', sha256: sha256Of(buffer), name: file.filename,
                    mimetype: MEDIA_MIME[path.extname(file.filename).toLowerCase()] ?? 'application/octet-stream',
                    size: file.size, storedName: file.name, mediaId: file.mediaId, at: iso(file.mtime),
                });
            } catch { /* unreadable or removed: skip it, the rest still index */ }
        }
    }
}
