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

import { buildContacts, cleanCountryCode, withFallbacks } from '../campaign/importer.js';
import { SafetyError } from '../campaign/safety.js';
import { InteractiveError } from '../messaging/interactive.js';
import { contactContext, personalize } from '../protocol.js';
import { RECIPES, getRecipe, installRecipe } from '../recipes/index.js';
import { CampaignError, CampaignStore, campaignKey } from './store.js';

export function createCampaignRouter({ db, state }) {
    const router = express.Router();
    const campaigns = new CampaignStore(db, {
        contacts: state.contacts,
        templates: state.templates,
        manager: state.manager,
        // Read lazily: the transport and the hooks change over the runtime's life.
        canSend: () => Boolean(state.transport?.isConnected?.()),
        media: (id) => state.media?.get(id) ?? null,
        interactiveStats: (key) => state.interactiveStats?.(key) ?? null,
        policy: () => state.platformPolicy?.() ?? {},
        replies: () => state.interactions ?? null,
    });
    state.campaigns = campaigns;
    // The store finished a run (or booked a spread campaign's next day) on its own: open pages and the audit log
    // hear it now, not when someone next opens the campaign.
    campaigns.onSettled = (campaign, stats) => {
        announce('campaignUpdated', campaign);
        state.broadcast?.({ type: 'changed', topic: 'campaigns' });
        state.tenancy?.audit({
            // The engine closed it, not whichever request happened to read the stats: no request id.
            tenantId: db.tenantId ?? null, userId: null, requestId: null,
            action: campaign.status === 'done' ? 'campaign.done' : 'campaign.day_done', target: campaign.id,
            detail: { name: campaign.name, sent: stats.sent ?? 0, failed: stats.failed ?? 0, total: stats.total ?? 0 },
        });
    };
    // The last message of a run left the queue: close the record at once. The sweeper (`finishedCampaigns`) is
    // the fallback for runs that ended while the process was down.
    let settleTimer = null;
    const settleSoon = () => {
        const key = state.manager?.campaignId;
        const id = /^camp-(\d+)$/.exec(key ?? '')?.[1];
        // Not gated on inFlight: the last `status` event fires inside that very send. stats() reads the rows, so it
        // only closes the run once none is QUEUED or SENDING.
        if (!id || state.manager.queue.pending || settleTimer) return;
        settleTimer = setTimeout(() => {
            settleTimer = null;
            try {
                if (campaigns.get(id)?.status === 'running') campaigns.stats(id);
            } catch (err) {
                console.error(`[campaigns] ${id} could not be closed:`, err.message);
            }
        }, 250);
        settleTimer.unref?.();
    };
    // The list shows each campaign's stored snapshot, so a running one must keep it current: at most once a second,
    // and the open pages hear about it only when a number actually moved.
    let refreshTimer = null;
    const refreshSoon = () => {
        const id = /^camp-(\d+)$/.exec(state.manager?.campaignId ?? '')?.[1];
        if (!id || refreshTimer) return;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            try {
                const before = campaigns.get(id);
                if (!before || before.status === 'draft') return;
                const { campaign } = campaigns.stats(id);
                if (JSON.stringify(campaign.stats) !== JSON.stringify(before.stats)) {
                    state.broadcast?.({ type: 'changed', topic: 'campaigns' });
                }
            } catch (err) {
                console.error(`[campaigns] ${id} progress refresh failed:`, err.message);
            }
        }, 1000);
        refreshTimer.unref?.();
    };
    const engineAudit = (action, campaign, detail) => state.tenancy?.audit({
        tenantId: db.tenantId ?? null, userId: null, requestId: null, action, target: campaign.id, detail: { name: campaign.name, ...detail },
    });
    // The manager halted a run on a platform rule: the record says so, and why.
    state.manager?.on?.('event', (event) => {
        if (event.type === 'status' || event.type === 'stats') {
            settleSoon();
            refreshSoon();
        }
        // The block-rate and STOP-rate pauses name no campaign: they pause whichever run the number holds.
        const key = event.campaignId ?? state.manager.campaignId;
        if (['quotaReached', 'policyHold', 'holdLifted'].includes(event.type)) {
            // A daily or monthly limit holds the run and the manager lifts it itself: the record stays running.
            const reason = event.type === 'holdLifted' ? null : (event.message ?? event.reason ?? null);
            const campaign = campaigns.hold(key, reason);
            if (!campaign) return;
            announce('campaignUpdated', campaign);
            if (reason) engineAudit('campaign.auto_paused', campaign, { reason, resumesByItself: true });
            return;
        }
        const halt = { failureStop: 'paused', policyStop: 'cancelled' }[event.type];
        if (!halt) return;
        const reason = event.type === 'failureStop' ? `Auto-paused: ${event.message.replace(/^Paused: /, '')}` : event.reason;
        const campaign = campaigns.policyHalt(key, halt, reason);
        if (!campaign) return;
        announce('campaignUpdated', campaign);
        engineAudit(halt === 'paused' ? 'campaign.auto_paused' : 'campaign.auto_cancelled', campaign, { reason });
    });

    const fail = (res, err) => {
        const known = err instanceof CampaignError || err instanceof InteractiveError || err instanceof SafetyError;
        if (!known) throw err;
        return res.status(err.status).json({ errors: [err.message] });
    };

    /**
     * An `{importId, mapping, ...}` audience becomes the explicit contact list
     * now - the import session is short-lived, the campaign is not. Explicit
     * lists are held to the plan's per-campaign cap, like /campaign/start.
     */
    const resolveBody = (body) => {
        const out = { ...body };
        const audience = body.audience;
        if (audience && typeof audience === 'object' && !Array.isArray(audience) && audience.importId) {
            const session = state.imports?.get(audience.importId);
            if (!session) throw new CampaignError('import not found - upload the file again', 404);
            const cc = audience.countryCode;
            if (cc !== undefined && cc !== null && String(cc).trim() !== '' && !cleanCountryCode(cc)) {
                throw new CampaignError('default country code must be 1-4 digits');
            }
            const dedupeDays = Math.max(0, Number(audience.dedupeDays) || 0);
            const since = new Date(Date.now() - dedupeDays * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
            try {
                out.audience = buildContacts(session.sheet, {
                    mapping: audience.mapping,
                    countryCode: cc ?? '',
                    autoClean: Boolean(audience.autoClean),
                    skipDuplicates: audience.skipDuplicates !== false,
                    optOuts: new Set(db.getAllOptOuts?.() ?? []),
                    recent: dedupeDays > 0 ? new Set(db.bulkCountsSince(since).keys()) : new Set(),
                }).contacts;
            } catch (err) {
                if (err instanceof RangeError) throw new CampaignError(err.message);
                throw err;
            }
        }
        // Hand-picked contacts ({ids: [...]}) count the same; other filters are held to it at send time.
        const picked = Array.isArray(out.audience) ? out.audience : (Array.isArray(out.audience?.ids) ? out.audience.ids : null);
        if (picked) {
            const cap = state.limits?.()?.maxContactsPerCampaign;
            if (cap && picked.length > cap) {
                throw new CampaignError(`A campaign can reach ${cap} contacts on your plan; this one has ${picked.length}.`, 403);
            }
        }
        return out;
    };
    const announce = (type, campaign) => state.broadcast?.({ type, campaign });
    /** A named entry for the owner's own action; `req.audited` lets the generic per-request row step aside. */
    const userAudit = (req, action, campaign, detail = {}) => {
        state.tenancy?.audit({
            tenantId: db.tenantId ?? null, userId: req.user?.id ?? null, action, target: campaign.id,
            detail: { name: campaign.name, ...detail }, ip: req.ip ?? null,
        });
        req.audited = true;
    };

    // --------------------------------------------------------- campaigns --
    router.get('/campaigns', (req, res) => res.json({
        campaigns: campaigns.list({ status: req.query.status || null, limit: Number(req.query.limit) || 200 }),
    }));

    // Spread sending: can this many go out between two dates under today's cap?
    router.post('/campaigns/spread-check', (req, res) => {
        const { count, from, to, timezone } = req.body ?? {};
        return res.json({ plan: campaigns.spreadCheck({ count, from, to, timezone }) });
    });

    router.post('/campaigns', (req, res) => {
        try {
            const campaign = campaigns.create({ ...resolveBody(req.body ?? {}), channelId: state.channel.id });
            announce('campaignCreated', campaign);
            userAudit(req, 'campaign.create', campaign, { status: campaign.status });
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
            const campaign = campaigns.update(req.params.id, resolveBody(req.body ?? {}));
            announce('campaignUpdated', campaign);
            return res.json({ campaign });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.delete('/campaigns/:id', (req, res) => {
        try {
            const campaign = campaigns.require(req.params.id);
            campaigns.remove(campaign.id);
            userAudit(req, 'campaign.delete', campaign, { status: campaign.status });
            announce('campaignDeleted', { ...campaign, audience: null });
            // A paused run's waiting rows were cancelled on the way out.
            if (campaign.status === 'paused') state.broadcast?.({ type: 'historyDirty' });
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
                // The send fills blanks from the campaign's fallbacks, so the preview does too.
                const context = withFallbacks(contactContext(contact), campaign.options?.fallbacks ?? {});
                // Same source as the send: the campaign's own body (or A/B version A).
                const rendered = { body: personalize(text, context), missing: missingIn(text, context) };
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

    // ------------------------------------------------- v2: speed, retry --
    router.post('/campaigns/:id/speed', (req, res) => {
        try {
            const result = campaigns.setSpeed(req.params.id, req.body?.pacing);
            announce('campaignUpdated', result.campaign);
            return res.json(result);
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/campaigns/:id/retry-failed', (req, res) => {
        try {
            const result = campaigns.retryFailed(req.params.id);
            userAudit(req, 'campaign.retry', result.campaign, { queued: result.queued });
            announce('campaignStarted', result.campaign);
            return res.json(result);
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/campaigns/:id/analytics', (req, res) => {
        try {
            return res.json(campaigns.analytics(req.params.id));
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/campaigns/:id/export.csv', (req, res) => {
        try {
            const campaign = campaigns.require(req.params.id);
            const csv = campaigns.exportCsv(campaign.id);
            res.type('text/csv');
            res.set('Content-Disposition', `attachment; filename="campaign-${campaign.id}.csv"`);
            return res.send(csv);
        } catch (err) {
            return fail(res, err);
        }
    });

    // Kept last: `speed`, `retry-failed` and friends above match first.
    router.post('/campaigns/:id/:action', (req, res) => {
        const { action } = req.params;
        if (!['start', 'pause', 'resume', 'cancel'].includes(action)) {
            return res.status(404).json({ errors: [`unknown action: ${action}`] });
        }
        try {
            if (action !== 'start') {
                const before = campaigns.require(req.params.id);
                const campaign = campaigns[action](before.id);
                // A cancel of an already finished run changes nothing: no event, no audit row.
                if (campaign.status !== before.status) {
                    userAudit(req, `campaign.${action}`, campaign, { from: before.status });
                    announce({ pause: 'campaignPaused', resume: 'campaignResumed', cancel: 'campaignCancelled' }[action], campaign);
                    if (action === 'cancel') state.broadcast?.({ type: 'historyDirty' });
                }
                return res.json({ campaign, stats: state.manager?.statsSnapshot() ?? null });
            }
            // The store refuses (409) without a transport and (404) when the
            // campaign's media is gone; it resolves the media itself.
            const result = campaigns.start(req.params.id, {
                onePerNumber: req.body?.onePerNumber !== false,
            });
            userAudit(req, 'campaign.start', result.campaign, {
                audience: result.audience, queued: result.queued ?? 0, skipped: result.skipped ?? 0,
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

/**
 * Which `{placeholders}` the context leaves blank. Only plain `{key}`: a piped one is either a variable with its own
 * fallback (`{name|there}`) or a word choice (`{Hi|Hello}`), and neither goes out blank.
 */
function missingIn(text, context) {
    return [...new Set([...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]))]
        .filter((key) => context[key] === undefined || context[key] === null || context[key] === '');
}
