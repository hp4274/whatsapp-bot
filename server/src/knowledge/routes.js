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

import { KnowledgeError, KnowledgeStore } from './store.js';
import { SIMILARITY_THRESHOLD } from './matcher.js';

export function createKnowledgeRouter({ db, state }) {
    const app = express.Router();
    const knowledge = new KnowledgeStore(db);

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
        });
    });

    // ---------------------------------------------------------- categories --
    // Registered before /faq/:id, or "categories" would be read as an id.
    app.get('/faq/categories', (req, res) => {
        res.json({ categories: knowledge.categories() });
    });

    app.post('/faq/categories', (req, res) => run(res, () => {
        const category = knowledge.createCategory(req.body ?? {});
        state.broadcast({ type: 'faq_category', action: 'created', category });
        return res.status(201).json({ category });
    }));

    app.put('/faq/categories/:id', (req, res) => run(res, () => {
        const category = knowledge.updateCategory(req.params.id, req.body ?? {});
        state.broadcast({ type: 'faq_category', action: 'updated', category });
        return res.json({ category });
    }));

    app.delete('/faq/categories/:id', (req, res) => run(res, () => {
        const category = knowledge.removeCategory(req.params.id);
        state.broadcast({ type: 'faq_category', action: 'deleted', category });
        return res.json({ deleted: true, category });
    }));

    // --------------------------------------------------------- analytics --
    app.get('/faq/misses', (req, res) => {
        res.json({ misses: knowledge.misses({ limit: req.query.limit }) });
    });

    app.delete('/faq/misses/:id', (req, res) => run(res, () => {
        knowledge.clearMiss(req.params.id);
        return res.json({ deleted: true });
    }));

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
        const item = knowledge.create(req.body ?? {});
        state.broadcast({ type: 'faq_item', action: 'created', item });
        return res.status(201).json({ item });
    }));

    app.get('/faq/:id', (req, res) => run(res, () => {
        const item = knowledge.get(req.params.id);
        if (!item) return res.status(404).json({ errors: ['faq item not found'] });
        return res.json({ item, versions: knowledge.versions(item.id) });
    }));

    app.put('/faq/:id', (req, res) => run(res, () => {
        const item = knowledge.update(req.params.id, req.body ?? {});
        state.broadcast({ type: 'faq_item', action: 'updated', item });
        return res.json({ item });
    }));

    app.delete('/faq/:id', (req, res) => run(res, () => {
        const item = knowledge.remove(req.params.id);
        state.broadcast({ type: 'faq_item', action: 'deleted', item });
        return res.json({ deleted: true, item });
    }));

    app.post('/faq/:id/revert', (req, res) => run(res, () => {
        const item = knowledge.revert(req.params.id, req.body?.version);
        state.broadcast({ type: 'faq_item', action: 'reverted', item });
        return res.json({ item });
    }));

    return app;
}
