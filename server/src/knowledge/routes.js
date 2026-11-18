/**
 * HTTP for the knowledge base.
 *
 * Mounted into every channel runtime, so `db` is already tenant-scoped and
 * `state.channel` is the number these answers belong to - which is what the
 * business-hours check needs. Paths carry no /api prefix; the tenant
 * dispatcher adds it.
 *
 * `POST /faq/match` is the point of the whole router from an operator's seat:
 * type the question a customer typed, see which item fires and at which level,
 * without sending anything and without moving the hit counters.
 *
 * Nothing here sends a message. An answer leaves as JSON; whoever sends it
 * goes through the message pipeline, which is where opt-out is enforced.
 */

import express from 'express';
import multer from 'multer';

import { parseTable } from '../contacts.js';
import { ruleCap } from '../policy/modules.js';
import { checkImport } from '../security/filetype.js';
import { KnowledgeError, KnowledgeStore } from './store.js';
import { SIMILARITY_THRESHOLD } from './matcher.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
/** Rows one import may carry: a pasted list or a sheet, not a database dump. */
const MAX_IMPORT = 2000;
const NO_REGEX = 'Your plan does not allow pattern (regex) answers. Use "contains" or "similar" instead.';

export function createKnowledgeRouter({ db, state }) {
    const app = express.Router();
    const knowledge = new KnowledgeStore(db);
    const policy = () => state.platformPolicy?.() ?? {};
    const regexRefused = (body) => policy()['faq.allowRegex'] === false
        && String(body?.matchType ?? '').toUpperCase() === 'REGEX';
    // Every write also says "faq changed", which is what open FAQ pages reload on.
    const broadcast = (event) => {
        state.broadcast(event);
        state.broadcast({ type: 'changed', topic: 'faq' });
    };

    const fail = (res, err) => {
        if (err instanceof KnowledgeError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };
    const run = (res, work) => {
        try {
            return work();
        } catch (err) {
            return fail(res, err);
        }
    };

    // ---------------------------------------------------------- knowledge --
    /** One read for a dashboard: what exists, how it is doing, what is missing. */
    app.get('/knowledge', (req, res) => {
        res.json({
            categories: knowledge.categories(),
            items: knowledge.list(),
            stats: knowledge.stats(),
            misses: knowledge.misses({ limit: 20 }),
            similarityThreshold: SIMILARITY_THRESHOLD,
            settings: knowledge.settings(),
        });
    });

    // ---------------------------------------------------------- categories --
    // Registered before /faq/:id, or "categories" would be read as an id.
    app.get('/faq/categories', (req, res) => {
        res.json({ categories: knowledge.categories() });
    });

    app.post('/faq/categories', (req, res) => run(res, () => {
        const category = knowledge.createCategory(req.body ?? {});
        broadcast({ type: 'faq_category', action: 'created', category });
        return res.status(201).json({ category });
    }));

    app.put('/faq/categories/:id', (req, res) => run(res, () => {
        const category = knowledge.updateCategory(req.params.id, req.body ?? {});
        broadcast({ type: 'faq_category', action: 'updated', category });
        return res.json({ category });
    }));

    app.delete('/faq/categories/:id', (req, res) => run(res, () => {
        const category = knowledge.removeCategory(req.params.id);
        broadcast({ type: 'faq_category', action: 'deleted', category });
        return res.json({ deleted: true, category });
    }));

    // --------------------------------------------------------- analytics --
    app.get('/faq/misses', (req, res) => {
        res.json({ misses: knowledge.misses({ limit: req.query.limit }) });
    });

    app.delete('/faq/misses/:id', (req, res) => run(res, () => {
        knowledge.clearMiss(req.params.id);
        state.broadcast({ type: 'changed', topic: 'faq' });
        return res.json({ deleted: true });
    }));

    // What happens when nothing answers a customer (FAQ_SETTINGS in store.js).
    app.get('/faq/settings', (req, res) => {
        res.json({ settings: knowledge.settings() });
    });

    app.put('/faq/settings', (req, res) => run(res, () => {
        const settings = knowledge.saveSettings(req.body ?? {});
        state.broadcast({ type: 'changed', topic: 'faq' });
        return res.json({ settings });
    }));

    /**
     * Many answers at once: a starter pack, pasted lines or a sheet read by /faq/import/file. Fills up to the plan's
     * faq.maxItems and reports what it left out rather than refusing the lot.
     */
    app.post('/faq/import', (req, res) => run(res, () => {
        const rows = req.body?.items;
        if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ errors: ['Nothing to import.'] });
        if (rows.length > MAX_IMPORT) {
            return res.status(400).json({ errors: [`One import can hold at most ${MAX_IMPORT} questions.`] });
        }
        if (rows.some(regexRefused)) return res.status(403).json({ errors: [NO_REGEX] });
        const cap = ruleCap(policy(), 'faq.maxItems');
        const room = cap === null ? null : Math.max(0, cap - knowledge.stats().items);
        if (room === 0) {
            return res.status(403).json({ errors: [`Your plan allows ${cap} FAQ answers, and you have reached it.`] });
        }
        const result = knowledge.importItems(rows, { room });
        if (result.created) broadcast({ type: 'faq_item', action: 'imported', count: result.created });
        return res.status(result.created ? 201 : 200).json({ ...result, limit: cap });
    }));

    /** Read a CSV/XLSX with question, answer[, category] columns into rows for the import preview. Saves nothing. */
    app.post('/faq/import/file', upload.single('file'), checkImport, async (req, res) => {
        if (!req.file) return res.status(400).json({ errors: ['No file uploaded.'] });
        let table;
        try {
            table = await parseTable(req.file.originalname, req.file.buffer);
        } catch (err) {
            return res.status(400).json({ errors: [`Could not read the file: ${err.message}`] });
        }
        return res.json({ items: faqRows(table).slice(0, MAX_IMPORT) });
    });

    app.get('/faq/stats', (req, res) => {
        res.json({ stats: knowledge.stats() });
    });

    /**
     * Dry-run a question. Never records, never sends.
     *
     * A null match is the honest answer: it means escalate to a human, and the
     * response says so rather than handing back a low-confidence guess.
     */
    app.post('/faq/match', (req, res) => {
        const { text = '', locale = '', threshold, ignoreBusinessHours = false } = req.body ?? {};
        const match = knowledge.answer(text, {
            channel: ignoreBusinessHours ? null : state.channel,
            synonyms: policy()['faq.allowSynonyms'] !== false,
            locale,
            threshold: threshold === undefined ? undefined : Number(threshold),
            record: false,
        });
        res.json({
            match,
            level: match?.level ?? null,
            score: match?.score ?? 0,
            escalate: !match,
            threshold: threshold === undefined ? SIMILARITY_THRESHOLD : Number(threshold),
        });
    });

    // -------------------------------------------------------------- items --
    app.get('/faq', (req, res) => {
        const { categoryId, locale, q } = req.query;
        res.json({
            items: q
                ? knowledge.search(q)
                : knowledge.list({
                    categoryId: categoryId === undefined ? undefined : (categoryId === '' ? null : categoryId),
                    locale,
                    activeOnly: req.query.activeOnly === 'true',
                }),
            categories: knowledge.categories(),
        });
    });

    app.post('/faq', (req, res) => run(res, () => {
        const cap = ruleCap(state.platformPolicy?.(), 'faq.maxItems');
        if (cap !== null && knowledge.stats().items >= cap) {
            return res.status(403).json({ errors: [`Your plan allows ${cap} FAQ answers, and you have reached it.`] });
        }
        if (regexRefused(req.body)) return res.status(403).json({ errors: [NO_REGEX] });
        const item = knowledge.create(req.body ?? {});
        broadcast({ type: 'faq_item', action: 'created', item });
        return res.status(201).json({ item });
    }));

    app.get('/faq/:id', (req, res) => run(res, () => {
        const item = knowledge.get(req.params.id);
        if (!item) return res.status(404).json({ errors: ['faq item not found'] });
        return res.json({ item, versions: knowledge.versions(item.id) });
    }));

    app.put('/faq/:id', (req, res) => run(res, () => {
        if (regexRefused(req.body)) return res.status(403).json({ errors: [NO_REGEX] });
        const item = knowledge.update(req.params.id, req.body ?? {});
        broadcast({ type: 'faq_item', action: 'updated', item });
        return res.json({ item });
    }));

    app.delete('/faq/:id', (req, res) => run(res, () => {
        const item = knowledge.remove(req.params.id);
        broadcast({ type: 'faq_item', action: 'deleted', item });
        return res.json({ deleted: true, item });
    }));

    app.post('/faq/:id/revert', (req, res) => run(res, () => {
        const item = knowledge.revert(req.params.id, req.body?.version);
        broadcast({ type: 'faq_item', action: 'reverted', item });
        return res.json({ item });
    }));

    return app;
}

/**
 * A parsed sheet as import rows. Columns are found by header (question / answer / category, plus common Hindi-English
 * names); a sheet whose first row is already a question has no header, so its columns are taken in order.
 */
function faqRows({ headers, rows }) {
    const find = (re) => headers.findIndex((h) => re.test(String(h).trim().toLowerCase()));
    let q = find(/^(q|question|questions|sawal|prashn)/);
    let a = find(/^(a|answer|answers|reply|jawab|uttar)/);
    let c = find(/^(category|categories|topic|group)/);
    let body = rows;
    if (q < 0 || a < 0) {
        [q, a, c] = [0, 1, headers.length > 2 ? 2 : -1];
        body = [headers, ...rows];
    }
    return body
        .map((row) => ({ question: row[q] ?? '', answer: row[a] ?? '', category: c < 0 ? '' : row[c] ?? '' }))
        .filter((row) => row.question.trim() || row.answer.trim());
}
