/**
 * Storage: the files this tenant uploaded before, so they can be reused,
 * downloaded or deleted. Mounted per channel like the other feature routers;
 * `db` is already tenant-scoped, so every query underneath is too.
 *
 * Role gating is the shared /api middleware's: reads are open to any signed-in
 * member, writes (use, delete) need an admin.
 */

import fs from 'node:fs';

import express from 'express';

import { parseSheet } from '../campaign/importer.js';
import { mediaMetadata } from '../mediaStore.js';
import { GONE, KINDS, StorageError, StorageStore, toFile, uploadInfo } from './store.js';

export function createStorageRouter({ db, state }) {
    const router = express.Router();
    const storage = new StorageStore(db, {
        uploadDir: state.media.uploadDir,
        media: state.media,
        // The plan's storage_mb quota, metered as a stock in whole MB.
        limitMb: () => state.billing?.limitFor('storage_mb') ?? null,
        onUsage: (bytes) => state.billing?.set('storage_mb', Math.ceil(bytes / (1024 * 1024))),
    });
    state.storage = storage;

    const fail = (res, err) => {
        if (!(err instanceof StorageError)) throw err;
        return res.status(err.status).json({ errors: [err.message] });
    };
    const need = (id) => {
        const row = /^\d+$/.test(id) ? storage.get(id) : null;
        if (!row) throw new StorageError('file not found', 404);
        return row;
    };

    router.get('/storage', async (req, res) => {
        const kind = req.query.kind ? String(req.query.kind) : null;
        if (kind && !KINDS.includes(kind)) return res.status(400).json({ errors: ['kind must be sheet or media'] });
        await storage.backfill();
        return res.json(storage.list({ kind, q: req.query.q }));
    });

    router.get('/storage/:id/download', (req, res) => {
        try {
            const row = need(req.params.id);
            const file = storage.pathOf(row);
            if (!file) throw new StorageError(GONE, 410);
            return res.type(row.mimetype).download(file, row.name);
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/storage/:id/use', async (req, res) => {
        try {
            const row = need(req.params.id);
            const file = storage.pathOf(row);
            if (!file) throw new StorageError(GONE, 410);
            if (row.kind === 'media') {
                const media = state.media.get(row.media_id);
                if (!media) {
                    storage.forget(row.id);
                    throw new StorageError(GONE, 410);
                }
                const used = storage.touch(row.id);
                return res.json({ file: toFile(used), media: { ...mediaMetadata(media), ...uploadInfo(used, true) } });
            }
            let sheet;
            try {
                sheet = await parseSheet(row.name, await fs.promises.readFile(file));
            } catch (err) {
                throw new StorageError(`Import failed: ${err.message}`);
            }
            if (!sheet.headers.length || !sheet.rows.length) {
                throw new StorageError('the file has no header row or no data rows');
            }
            const used = storage.touch(row.id);
            return res.json({
                file: toFile(used),
                preview: { ...state.sheetPreview(sheet, row.name), ...uploadInfo(used, true) },
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.delete('/storage/:id', (req, res) => {
        try {
            const row = need(req.params.id);
            const reason = storage.inUse(row);
            if (reason) throw new StorageError(reason, 409);
            storage.remove(row);
            return res.json({ ok: true });
        } catch (err) {
            return fail(res, err);
        }
    });

    return router;
}
