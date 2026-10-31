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
        tellSiblings(campaign);
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
                    tellSiblings(campaign);
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

    // ------------------------------------------------- one campaign, several numbers --
    /**
     * A campaign shared over several numbers (split, below) is one campaign to the business. Every other number
     * runs a hidden copy (options.parentId) holding its own share, on its own engine and pace, so the numbers never
     * wait on each other. Reads add the copies up; actions reach every copy.
     */
    const sharesOf = (campaign) => (campaign?.options?.shares ?? []).flatMap((share) => {
        const other = state.channelState?.(share.channelId);
        const copy = other?.campaigns?.get(share.id);
        return copy ? [{ other, copy }] : [];
    });
    const addUp = (all) => all.reduce((sum, stats) => {
        for (const key of ['total', 'pending', 'failed', 'sent']) sum[key] = (sum[key] ?? 0) + (stats?.[key] ?? 0);
        for (const [key, n] of Object.entries(stats?.byStatus ?? {})) sum.byStatus[key] = (sum.byStatus[key] ?? 0) + n;
        return sum;
    }, { byStatus: {} });
    /** The campaign as the business sees it: live while any number still sends, every number's counts together. */
    const whole = (campaign, shares = sharesOf(campaign)) => {
        if (!shares.length) return campaign;
        const all = [campaign, ...shares.map(({ copy }) => copy)];
        // A number left with nobody (failover moved everyone off it) never starts: its draft does not decide the status.
        const sending = all.filter((c) => c.audienceSize !== 0);
        return {
            ...campaign,
            // Live while any number still sends; after that, cancelled on any number means the campaign was cancelled
            // (this number finishing its share first does not make the whole campaign done).
            status: ['running', 'paused', 'scheduled', 'cancelled'].find((s) => sending.some((c) => c.status === s))
                ?? (sending[0] ?? campaign).status,
            audienceSize: all.reduce((n, c) => n + (c.audienceSize ?? 0), 0),
            stats: addUp(all.map((c) => c.stats)),
            numbers: all.map((c) => ({ channelId: c.channelId, status: c.status })),
        };
    };
    /** Run `act` on every copy; one that cannot (already finished, say) does not stop the rest. */
    const eachShare = (campaign, act) => sharesOf(campaign).map(({ other, copy }) => {
        try {
            const result = act(other.campaigns, copy.id);
            other.broadcast?.({ type: 'changed', topic: 'campaigns' });
            return { channelId: other.channel.id, result };
        } catch (err) {
            if (!(err instanceof CampaignError)) throw err;
            return { channelId: other.channel.id, error: err.message };
        }
    });
    /**
     * `act` on this number's campaign and on every copy, each on its own: a number that cannot (already finished,
     * not connected) neither stops the others nor fails the request, unless none of them could.
     */
    const acrossNumbers = (campaign, act) => {
        let own = null;
        let refused = null;
        try {
            own = act(campaigns, campaign.id);
        } catch (err) {
            if (!(err instanceof CampaignError)) throw err;
            refused = err;
        }
        const shares = eachShare(campaign, act);
        if (refused && (!shares.length || shares.every((share) => share.error))) throw refused;
        return { own, refused: refused?.message ?? null, shares };
    };
    /** A copy moved: the campaign's page is open on another number, so tell every number. */
    const tellSiblings = (campaign) => {
        if (!campaign?.options?.parentId) return;
        for (const other of state.siblings?.() ?? []) other.broadcast?.({ type: 'changed', topic: 'campaigns' });
    };
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
        // A number's share of a shared campaign is listed as part of that campaign, not on its own.
        campaigns: campaigns.list({ status: req.query.status || null, limit: Number(req.query.limit) || 200 })
            .filter((c) => !c.options?.parentId).map((c) => whole(c)),
    }));

    // Spread sending: can this many go out between two dates under today's cap?
    router.post('/campaigns/spread-check', (req, res) => {
        const { count, from, to, timezone } = req.body ?? {};
        return res.json({ plan: campaigns.spreadCheck({ count, from, to, timezone }) });
    });

    /**
     * Of these people, how many each number already chats with: it sent them a message or heard from them since it
     * got its current number (db.isCold, the test the engine's new-chat budget uses). Only a hint for picking a
     * number, so the list is capped rather than resolved in full.
     */
    router.post('/campaigns/warm-check', (req, res) => {
        const phones = [...new Set((Array.isArray(req.body?.phones) ? req.body.phones : [])
            .map((p) => String(p).replace(/\D/g, '')).filter(Boolean))].slice(0, 5000);
        const warm = {};
        for (const id of new Set((Array.isArray(req.body?.channelIds) ? req.body.channelIds : []).map(Number))) {
            const number = id === state.channel.id ? state : state.channelState?.(id);
            if (number?.db) warm[id] = phones.filter((p) => !number.db.isCold(p)).length;
        }
        return res.json({ checked: phones.length, warm });
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
            return res.json({ campaign: whole(campaigns.require(req.params.id)) });
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
            // Copies first: one still sending refuses (409) before anything is gone.
            for (const { other, copy } of sharesOf(campaign)) {
                other.campaigns.remove(copy.id);
                other.broadcast?.({ type: 'changed', topic: 'campaigns' });
            }
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
            const own = campaigns.stats(req.params.id);
            // Polling settles each copy too, as it does this number's run.
            const shares = sharesOf(own.campaign).map(({ other, copy }) => ({ other, copy: other.campaigns.stats(copy.id).campaign }));
            const campaign = whole(own.campaign, shares);
            const stats = shares.length ? addUp([own.stats, ...shares.map(({ copy }) => copy.stats)]) : own.stats;
            // The live queue view only exists while this manager holds the run.
            const live = own.campaign.status === 'running' || own.campaign.status === 'paused'
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
            const { own } = acrossNumbers(campaigns.require(req.params.id), (store, id) => store.setSpeed(id, req.body?.pacing));
            const result = own ?? { campaign: campaigns.get(req.params.id) };
            announce('campaignUpdated', result.campaign);
            return res.json({ ...result, campaign: whole(result.campaign) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.post('/campaigns/:id/retry-failed', (req, res) => {
        try {
            const { own, shares } = acrossNumbers(campaigns.require(req.params.id), (store, id) => store.retryFailed(id));
            const result = own ?? { campaign: campaigns.get(req.params.id), queued: 0 };
            const queued = (result.queued ?? 0) + shares.reduce((n, share) => n + (share.result?.queued ?? 0), 0);
            userAudit(req, 'campaign.retry', result.campaign, { queued });
            announce('campaignStarted', result.campaign);
            return res.json({ ...result, queued, campaign: whole(result.campaign) });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/campaigns/:id/analytics', (req, res) => {
        try {
            const own = campaigns.analytics(req.params.id);
            const shares = sharesOf(own.campaign);
            if (!shares.length) return res.json(own);
            // One report: every number's people in one list, each tagged with the number that sends to them.
            const parts = [
                { channelId: state.channel.id, report: own },
                ...shares.map(({ other, copy }) => ({ channelId: other.channel.id, report: other.campaigns.analytics(copy.id) })),
            ];
            const funnel = {};
            for (const { report } of parts) {
                for (const [key, n] of Object.entries(report.funnel)) funnel[key] = (funnel[key] ?? 0) + n;
            }
            const failures = new Map();
            for (const entry of parts.flatMap(({ report }) => report.failures)) {
                const key = `${entry.code}:${entry.label}`;
                failures.set(key, { ...entry, count: (failures.get(key)?.count ?? 0) + entry.count });
            }
            return res.json({
                ...own,
                campaign: whole(own.campaign, shares.map(({ other }, i) => ({ other, copy: parts[i + 1].report.campaign }))),
                funnel,
                failures: [...failures.values()].sort((a, b) => b.count - a.count),
                // shortcut: buttons and A/B figures are this number's only; add them up if shared runs use them a lot.
                recipients: parts.flatMap(({ channelId, report }) => report.recipients.map((r) => ({ ...r, channelId }))),
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    router.get('/campaigns/:id/export.csv', (req, res) => {
        try {
            const campaign = campaigns.require(req.params.id);
            // A shared campaign's file holds every number's people: each copy's rows without its header line.
            const csv = [campaigns.exportCsv(campaign.id), ...sharesOf(campaign)
                .map(({ other, copy }) => other.campaigns.exportCsv(copy.id).replace(/^.*\r?\n/, ''))]
                .filter(Boolean).join('');
            res.type('text/csv');
            res.set('Content-Disposition', `attachment; filename="campaign-${campaign.id}.csv"`);
            return res.send(csv);
        } catch (err) {
            return fail(res, err);
        }
    });

    // Kept last: `speed`, `retry-failed` and friends above match first.
    /**
     * Share one saved campaign over several numbers: its people are dealt out in turn, this number keeps the
     * first share and every other picked number gets a copy holding its own, so each sends under its own limits.
     * One transaction: a copy that fails leaves nothing half-split to send twice.
     */
    router.post('/campaigns/:id/split', (req, res) => {
        try {
            const campaign = campaigns.require(req.params.id);
            if (!['draft', 'scheduled'].includes(campaign.status)) {
                throw new CampaignError(`a ${campaign.status} campaign cannot be shared out`, 409);
            }
            const ids = [...new Set((Array.isArray(req.body?.channelIds) ? req.body.channelIds : []).map(Number))]
                .filter((id) => id !== state.channel.id);
            const others = ids.map((id) => {
                const other = state.channelState?.(id);
                if (!other?.campaigns) throw new CampaignError(`number #${id} cannot send campaigns`, 409);
                return other;
            });
            const list = Array.isArray(campaign.audience) ? campaign.audience : campaigns.resolveAudience(campaign);
            // Evenly over every number switched on: one with no room yet keeps its share until it can send.
            const shares = [state, ...others].map((_, i, all) => list.filter((__, n) => n % all.length === i));
            const options = { ...campaign.options, extraNumbers: [] }; // already dealt into the shares
            const rules = state.interactions?.rules(campaignKey(campaign.id)) ?? [];
            db.db.exec('BEGIN');
            let result;
            try {
                // Fewer people than numbers: a number with no share gets no copy.
                // Shared before (a send that was retried): its unstarted copies make way for the new deal.
                for (const { other, copy } of sharesOf(campaign)) other.campaigns.remove(copy.id);
                const copies = others.flatMap((other, i) => {
                    if (!shares[i + 1].length) return [];
                    const copy = other.campaigns.create({
                        name: campaign.name, status: campaign.status, templateId: campaign.templateId, body: campaign.body,
                        audience: shares[i + 1], mediaId: campaign.mediaId,
                        scheduledAt: campaign.scheduledAt, channelId: other.channel.id, options,
                    });
                    if (rules.length) other.interactions?.setRules(campaignKey(copy.id), rules);
                    return [{ other, copy: other.campaigns.link(copy.id, { parentId: campaign.id }) }];
                });
                campaigns.update(campaign.id, { audience: shares[0], segmentId: null, options });
                const own = campaigns.link(campaign.id, {
                    shares: copies.map(({ other, copy }) => ({ channelId: other.channel.id, id: copy.id })),
                });
                result = { own, copies };
                db.db.exec('COMMIT');
            } catch (err) {
                db.db.exec('ROLLBACK');
                throw err;
            }
            for (const { other, copy } of result.copies) other.broadcast?.({ type: 'campaignCreated', campaign: copy });
            announce('campaignUpdated', result.own);
            userAudit(req, 'campaign.split', result.own, { numbers: 1 + result.copies.length, people: list.length });
            return res.json({ campaigns: [result.own, ...result.copies.map(({ copy }) => copy)] });
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
                const before = campaigns.require(req.params.id);
                const campaign = acrossNumbers(before, (store, id) => store[action](id)).own ?? campaigns.get(before.id);
                // A cancel of an already finished run changes nothing: no event, no audit row.
                if (campaign.status !== before.status) {
                    userAudit(req, `campaign.${action}`, campaign, { from: before.status });
                    announce({ pause: 'campaignPaused', resume: 'campaignResumed', cancel: 'campaignCancelled' }[action], campaign);
                    if (action === 'cancel') state.broadcast?.({ type: 'historyDirty' });
                }
                return res.json({ campaign: whole(campaign), stats: state.manager?.statsSnapshot() ?? null });
            }
            // The store refuses (409) without a transport and (404) when the
            // campaign's media is gone; it resolves the media itself.
            // A shared campaign starts on every number at once; each sends its share at its own pace.
            const onePerNumber = req.body?.onePerNumber !== false;
            const across = acrossNumbers(campaigns.require(req.params.id), (store, id) => {
                // Left with nobody (failover moved everyone to a sibling): nothing to start here, and nothing wrong.
                const one = store.get(id);
                if (one.audienceSize === 0 && one.options?.shares?.length) return { campaign: one, queued: 0, skipped: 0, audience: 0 };
                return store.start(id, { onePerNumber });
            });
            const own = across.own ?? { campaign: campaigns.get(req.params.id), queued: 0, skipped: 0, audience: 0 };
            const sum = (key) => (own[key] ?? 0) + across.shares.reduce((n, share) => n + (share.result?.[key] ?? 0), 0);
            const result = {
                ...own,
                campaign: whole(own.campaign),
                audience: sum('audience'), queued: sum('queued'), skipped: sum('skipped'),
                // Per number, so the page can say which one is held or did not start.
                numbers: [
                    { channelId: state.channel.id, queued: own.queued ?? 0, safety: own.safety ?? null, error: across.refused },
                    ...across.shares.map((share) => ({
                        channelId: share.channelId, queued: share.result?.queued ?? 0,
                        safety: share.result?.safety ?? null, error: share.error ?? null,
                    })),
                ],
            };
            userAudit(req, 'campaign.start', result.campaign, {
                audience: result.audience, queued: result.queued, skipped: result.skipped,
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
