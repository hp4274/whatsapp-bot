/**
 * Analytics routes.  Mounted inside a channel runtime, so `db` is already
 * channel-scoped and every number here is for the selected WhatsApp number.
 * Gated by the `analytics` tenant service (see SERVICE_ROUTE_PREFIXES).
 *
 *   GET /analytics/overview?days=7|30|90   (default 30)
 *
 * Definitions of every figure live in ./store.js.
 */

import express from 'express';

import { AnalyticsError, AnalyticsStore, parseDays } from './store.js';

export function createAnalyticsRouter({ db }) {
    const router = express.Router();
    const store = new AnalyticsStore(db);

    router.get('/analytics/overview', (req, res) => {
        try {
            const days = parseDays(req.query.days);
            return res.json({ overview: store.overview({ days }) });
        } catch (err) {
            if (err instanceof AnalyticsError) return res.status(err.status).json({ errors: [err.message] });
            throw err;
        }
    });

    return router;
}
