/**
 * Phase 13 (campaigns) and Phase 12 (recipe install) routes.
 *
 * One router, because the recipe endpoints are two handlers and a second mount
 * point buys nothing. Mounted per channel, so `db` is already channel-scoped
 * and every query underneath is tenant-filtered.
 *
 * Nothing here paces, caps or dedupes a send: `/campaigns/:id/start` resolves
 * the audience and hands it to `state.manager`, which has done all of that
 * since Phase 1.
 */

import express from 'express';

import { contactContext, personalize } from '../protocol.js';
import { RECIPES, getRecipe, installRecipe } from '../recipes/index.js';
import { CampaignError, CampaignStore, campaignKey } from './store.js';

export function createCampaignRouter({ db, state }) {
    const router = express.Router();
    const campaigns = new CampaignStore(db, {
        contacts: state.contacts,
        templates: state.templates,
        manager: state.manager,
    });
    state.campaigns = campaigns;

    const fail = (res, err) => {
        if (!(err instanceof CampaignError)) throw err;
        return res.status(err.status).json({ errors: [err.message] });
    };
    const announce = (type, campaign) => state.broadcast?.({ type, campaign });

    // --------------------------------------------------------- campaigns --
    router.get('/campaigns', (req, res) => res.json({
        campaigns: campaigns.list({ status: req.query.status || null, limit: Number(req.query.limit) || 200 }),
    }));

    router.post('/campaigns', (req, res) => {
        try {
            const campaign = campaigns.create({ ...(req.body ?? {}), channelId: state.channel.id });
            announce('campaignCreated', campaign);
            return res.status(201).json({ campaign });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/campaigns/:id', (req, res) => {
        try {
            return res.json({ campaign: campaigns.require(req.params.id) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.put('/campaigns/:id', (req, res) => {
        try {
            const campaign = campaigns.update(req.params.id, req.body ?? {});
            announce('campaignUpdated', campaign);
            return res.json({ campaign });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.delete('/campaigns/:id', (req, res) => {
        try {
            campaigns.remove(req.params.id);
            return res.json({ deleted: true });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/campaigns/:id/stats', (req, res) => {
        try {
            const { campaign, stats } = campaigns.stats(req.params.id);
            // The live queue view only exists while this manager holds the run.
            const live = campaign.status === 'running' || campaign.status === 'paused'
                ? state.manager?.statsSnapshot() ?? null : null;
            return res.json({ campaign, stats, live, campaignId: campaignKey(campaign.id) });
        } catch (err) {
            return fail(res, err);
        }
    });

    /**
     * Render the message against the first few of the audience. The point is
     * to catch a variable nobody fills before 5,000 people read `{order_id}`,
     * so `missing` is reported per recipient and not hidden.
     */
    router.post('/campaigns/:id/preview', (req, res) => {
        try {
            const campaign = campaigns.require(req.params.id);
            const limit = Math.min(Number(req.body?.limit) || 3, 25);
            const recipients = campaigns.resolveAudience(campaign, { limit });
            const text = campaigns.messageText(campaign);
            const previews = recipients.map((contact) => {
                const context = contactContext(contact);
                const rendered = campaign.templateId != null
                    ? state.templates.render(campaign.templateId, context)
                    : { body: personalize(text, context), missing: missingIn(text, context) };
                return { phone: contact.phone, name: contact.name, preview: rendered.body, missing: rendered.missing };
            });
            return res.json({
                previews,
                audience: campaigns.resolveAudience(campaign).length,
                // One list the operator can act on, rather than a per-row hunt.
                missing: [...new Set(previews.flatMap((p) => p.missing))],
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/campaigns/:id/:action', (req, res) => {
        const { action } = req.params;
        if (!['start', 'pause', 'resume', 'cancel'].includes(action)) {
            return res.status(404).json({ errors: [`unknown action: ${action}`] });
        }
        try {
            if (action !== 'start') {
                const campaign = campaigns[action](req.params.id);
                announce(`campaign${action[0].toUpperCase()}${action.slice(1)}d`, campaign);
                return res.json({ campaign, stats: state.manager?.statsSnapshot() ?? null });
            }
            // Same gate the legacy /campaign/start has: no transport, no send.
            if (!state.transport?.isConnected?.()) {
                return res.status(409).json({ errors: ['Connect a transport first.'] });
            }
            const campaign = campaigns.require(req.params.id);
            const media = campaign.mediaId ? state.media.get(campaign.mediaId) : null;
            if (campaign.mediaId && !media) return res.status(404).json({ errors: ['media not found'] });
            const result = campaigns.start(campaign.id, {
                media,
                onePerNumber: req.body?.onePerNumber !== false,
            });
            announce('campaignStarted', result.campaign);
            return res.json(result);
        } catch (err) {
            return fail(res, err);
        }
    });

    // ----------------------------------------------------------- recipes --
    router.get('/recipes', (req, res) => res.json({
        recipes: RECIPES.map((recipe) => ({
            key: recipe.key,
            name: recipe.name,
            description: recipe.description,
            industry: recipe.industry,
            trigger: recipe.build().trigger.type,
            requires: {
                objectType: recipe.requires.objectType ?? null,
                templates: (recipe.requires.templates ?? []).map((t) => t.name),
            },
        })),
    }));

    router.post('/recipes/:key/install', (req, res) => {
        const recipe = getRecipe(req.params.key);
        if (!recipe) return res.status(404).json({ errors: [`unknown recipe: ${req.params.key}`] });
        const body = req.body ?? {};
        try {
            const result = installRecipe(recipe, {
                workflows: state.workflows,
                templates: state.templates,
                channelId: body.channelId === undefined ? state.channel.id : body.channelId,
                name: body.name ?? null,
                status: body.status ?? 'draft',
                options: body.options ?? {},
            });
            return res.status(201).json({ ...result, recipe: recipe.key });
        } catch (err) {
            // Both stores throw `{ status, message }` errors of their own.
            if (typeof err?.status !== 'number') throw err;
            return res.status(err.status).json({ errors: [err.message] });
        }
    });

    return router;
}

/** Which `{placeholders}` the context does not fill - `personalize` leaves these literal. */
function missingIn(text, context) {
    return [...new Set([...String(text).matchAll(/\{(\w+)(?:\|[^{}]*)?\}/g)].map((m) => m[1]))]
        .filter((key) => context[key] === undefined || context[key] === null || context[key] === '');
}
