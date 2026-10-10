/**
 * Campaign records (Phase 13, extended by Bulk Campaigns v2).
 *
 * A campaign is one message to many people; a workflow is many steps for one
 * person. They are different shapes on purpose and neither is implemented in
 * terms of the other.
 *
 * This store does NOT send. `start()` resolves the audience and hands it to
 * `CampaignManager.enqueueContacts`, which already owns adaptive pacing, the
 * daily cap, opt-out checks and duplicate protection. There is no rate limiter
 * in this file and there must never be one.
 *
 * Collaborators are injected the way `WorkflowEngine` takes its own, so a test
 * can drive a campaign with a fake manager and no transport.
 */

import { toCsv, withFallbacks } from '../campaign/importer.js';
import { PACING_PRESETS } from '../campaign/safety.js';
import { ErrorCode, FRIENDLY, normalizeError } from '../messaging/errors.js';
import { InteractiveError, normalizeInteractive, personalizeInteractive } from '../messaging/interactive.js';
import { metaTemplateFor, prepareTemplateSend } from '../messaging/templateSend.js';
import { campaignRefusal } from '../policy/campaignOps.js';
import { contactContext, utcNow } from '../protocol.js';

export const CAMPAIGN_STATUSES = Object.freeze([
    'draft', 'scheduled', 'running', 'paused', 'done', 'cancelled',
]);

/**
 * One recipient's Meta template payloads from #metaTemplates' result, the way
 * manager.enqueueContacts builds them: a main template with an empty slot
 * means skip (`missing`), an incomplete fallback is simply dropped.
 */
function templateSendsFor({ metaTemplate, fallbackTemplate }, context) {
    const main = metaTemplate ? prepareTemplateSend(metaTemplate.template, context, metaTemplate.params) : null;
    const fallback = fallbackTemplate
        ? prepareTemplateSend(fallbackTemplate.template, context, fallbackTemplate.params) : null;
    return {
        missing: Boolean(main?.missing.length),
        template: main?.template ?? null,
        fallbackTemplate: fallback && !fallback.missing.length ? fallback : null,
    };
}

/** Statuses after which nothing more will be sent. */
const FINAL = Object.freeze(['done', 'cancelled']);

/** The queue depth a campaign still has in flight, by message status. */
const OPEN_STATUSES = Object.freeze(['QUEUED', 'SENDING']);

/** Funnel buckets, cumulative: a READ row was also delivered and sent. */
const SENT_STATUSES = Object.freeze(['SENT', 'DELIVERED', 'READ', 'SANDBOX']);
const DELIVERED_STATUSES = Object.freeze(['DELIVERED', 'READ']);

export const RETARGET_FILTERS = Object.freeze(['failed', 'unread', 'noreply', 'replied', 'clicked']);

export class CampaignError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class CampaignStore {
    /**
     * @param {import('../db.js').Database} database a channel-scoped handle
     * @param {object} deps
     * @param {import('../contactStore.js').ContactStore} deps.contacts
     * @param {object} [deps.templates]  TemplateStore, for `template_id`
     * @param {object} [deps.manager]    the channel's CampaignManager
     * @param {() => Date} [deps.now]
     * @param {() => boolean} [deps.canSend]  false while no transport is connected
     * @param {(id: string) => object|null} [deps.media]  uploaded media by id
     * @param {(campaignKey: string) => ({clicks, byRecipient}|null)} [deps.interactiveStats]
     * @param {() => object} [deps.policy]  the tenant's effective platform policy values
     */
    constructor(database, {
        contacts, templates = null, manager = null, now = null,
        canSend = null, media = null, interactiveStats = null, policy = null,
    } = {}) {
        this.policy = policy;
        this.db = database.db;
        ensureCampaignOptionsColumn(this.db);
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? null;
        this.counts = (campaignKey) => database.countsByStatus(campaignKey, database.channelId);
        this.contacts = contacts;
        this.templates = templates;
        this.manager = manager;
        this.canSend = canSend;
        this.mediaLookup = media;
        this.interactiveStats = interactiveStats;
        this.now = now ? () => iso(now()) : utcNow;
    }

    // --------------------------------------------------------------- CRUD --
    create({
        name, status = 'draft', templateId = null, body = '', segmentId = null,
        audience = null, mediaId = null, scheduledAt = null, channelId, options = {},
    } = {}) {
        const clean = String(name ?? '').trim();
        if (!clean) throw new CampaignError('a campaign needs a name');
        const wanted = pickStatus(status, 'draft');
        if (!['draft', 'scheduled'].includes(wanted)) {
            throw new CampaignError('a new campaign is draft or scheduled; start it to run it');
        }
        if (wanted === 'scheduled' && !scheduledAt) throw new CampaignError('a scheduled campaign needs scheduled_at');
        const cleanOptions = normalizeOptions(options);
        this.#checkPolicy({ status: wanted, audience, options: cleanOptions });
        const now = this.now();
        const info = this.db.prepare(
            `INSERT INTO campaigns (tenant_id, channel_id, name, status, template_id, body, segment_id,
                                    audience, media_id, scheduled_at, stats, options, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`)
            .run(this.tenantId, channelId === undefined ? this.channelId : nullableInt(channelId),
                clean, wanted, nullableInt(templateId), String(body ?? ''), nullableInt(segmentId),
                JSON.stringify(audience ?? null), mediaId == null ? null : String(mediaId),
                scheduledAt ? iso(scheduledAt) : null, JSON.stringify(cleanOptions), now, now);
        return this.get(Number(info.lastInsertRowid));
    }

    /** Content and audience are editable until the campaign has started. */
    update(id, patch = {}) {
        const campaign = this.require(id);
        if (!['draft', 'scheduled'].includes(campaign.status)) {
            throw new CampaignError(`a ${campaign.status} campaign cannot be edited`, 409);
        }
        const next = {
            name: patch.name === undefined ? campaign.name : String(patch.name).trim(),
            templateId: patch.templateId === undefined ? campaign.templateId : nullableInt(patch.templateId),
            body: patch.body === undefined ? campaign.body : String(patch.body),
            segmentId: patch.segmentId === undefined ? campaign.segmentId : nullableInt(patch.segmentId),
            audience: patch.audience === undefined ? campaign.audience : (patch.audience ?? null),
            mediaId: patch.mediaId === undefined ? campaign.mediaId : (patch.mediaId == null ? null : String(patch.mediaId)),
            scheduledAt: patch.scheduledAt === undefined ? campaign.scheduledAt
                : (patch.scheduledAt ? iso(patch.scheduledAt) : null),
            status: patch.status === undefined ? campaign.status : pickStatus(patch.status, campaign.status),
            options: patch.options === undefined ? campaign.options : normalizeOptions(patch.options),
        };
        if (!next.name) throw new CampaignError('a campaign needs a name');
        if (!['draft', 'scheduled'].includes(next.status)) {
            throw new CampaignError('use start/pause/resume/cancel to change a running campaign', 409);
        }
        if (next.status === 'scheduled' && !next.scheduledAt) {
            throw new CampaignError('a scheduled campaign needs scheduled_at');
        }
        // Already scheduled stays allowed: only a new booking counts against the limit.
        this.#checkPolicy({ ...next, status: campaign.status === 'scheduled' ? 'draft' : next.status }, { except: campaign.id });
        this.db.prepare(
            `UPDATE campaigns SET name = ?, status = ?, template_id = ?, body = ?, segment_id = ?,
                                  audience = ?, media_id = ?, scheduled_at = ?, options = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(next.name, next.status, next.templateId, next.body, next.segmentId,
                JSON.stringify(next.audience ?? null), next.mediaId, next.scheduledAt,
                JSON.stringify(next.options ?? {}), this.now(),
                campaign.id, this.tenantId);
        return this.get(campaign.id);
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM campaigns WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toCampaign(row) : null;
    }

    list({ status = null, limit = 200 } = {}) {
        const rows = status
            ? this.db.prepare('SELECT * FROM campaigns WHERE tenant_id = ? AND status = ? ORDER BY id DESC LIMIT ?')
                .all(this.tenantId, status, Number(limit) || 200)
            : this.db.prepare('SELECT * FROM campaigns WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
                .all(this.tenantId, Number(limit) || 200);
        // The list view never needs 50,000 contacts per row; the detail does.
        return rows.map((row) => ({ ...toCampaign(row), audience: null }));
    }

    remove(id) {
        const campaign = this.require(id);
        if (campaign.status === 'running') throw new CampaignError('cancel the campaign before deleting it', 409);
        this.db.prepare('DELETE FROM campaigns WHERE id = ? AND tenant_id = ?').run(campaign.id, this.tenantId);
        return true;
    }

    require(id) {
        const campaign = this.get(id);
        if (!campaign) throw new CampaignError('campaign not found', 404);
        return campaign;
    }

    // ----------------------------------------------------------- audience --
    /**
     * Who this campaign goes to, resolved now rather than when it was saved -
     * a segment is a stored filter, so the audience is whoever matches today.
     *
     * Anyone not `messageable` (opted out, or not an active contact) is
     * dropped here; the manager checks opt-out again at enqueue time, and two
     * checks on a one-way door is the right number.
     */
    resolveAudience(campaign, { limit = 5000 } = {}) {
        const { segmentId, audience } = campaign;
        const isObject = audience && typeof audience === 'object' && !Array.isArray(audience);
        if (isObject && audience.retarget) {
            return this.#retargetAudience(audience.retarget).slice(0, limit);
        }
        if (isObject && audience.importId) {
            // Imports are resolved into an explicit list when the campaign is
            // saved; a raw importId here means it never was.
            throw new CampaignError('that import was never resolved into a contact list; save the campaign again');
        }
        if (segmentId != null) {
            return this.contacts.segmentContacts(segmentId, { limit }).filter((c) => c.messageable).map(toRecipient);
        }
        if (Array.isArray(audience)) {
            // An explicit list. A number we already know and have been asked
            // to stop messaging is dropped; one we have never seen is kept,
            // because there is nothing yet that says not to send.
            return audience.slice(0, limit).map((entry) => {
                const phone = String(entry?.phone ?? '').trim();
                if (!phone) return null;
                const known = this.contacts.getByPhone(this.contacts.normalize(phone));
                if (known && !known.messageable) return null;
                return { name: entry.name ?? known?.name ?? '', phone: known?.phone ?? phone, extra: entry.extra ?? {} };
            }).filter(Boolean);
        }
        if (isObject) {
            return this.contacts.find(audience, { limit }).filter((c) => c.messageable).map(toRecipient);
        }
        return [];
    }

    /** The text the manager personalises per contact: the template body, or `body`. */
    messageText(campaign) {
        if (campaign.templateId != null) {
            const template = this.templates?.get(campaign.templateId);
            if (!template) throw new CampaignError(`template ${campaign.templateId} not found`, 404);
            return template.body;
        }
        if (!campaign.body.trim()) throw new CampaignError('a campaign needs a template or a body');
        return campaign.body;
    }

    // ----------------------------------------------------------- controls --
    /**
     * Resolve the audience and hand it to the manager. Everything about *how*
     * fast it goes out stays over there.
     */
    start(id, { media = null, onePerNumber = true } = {}) {
        const campaign = this.require(id);
        if (campaign.status === 'running') throw new CampaignError('that campaign is already running', 409);
        if (campaign.status === 'paused') throw new CampaignError('that campaign is paused; resume it', 409);
        if (FINAL.includes(campaign.status)) throw new CampaignError(`that campaign is ${campaign.status}`, 409);
        // No transport, no send - for the scheduler too: a scheduled campaign
        // simply stays `scheduled` and the next sweep tries again.
        if (this.canSend && !this.canSend()) throw new CampaignError('Connect a transport first.', 409);
        this.#checkPolicy(campaign, { starting: true, except: campaign.id });
        const text = this.messageText(campaign);
        // Platform template review (templates/policy.js reviewBlock).
        const blocked = campaign.templateId != null ? this.templates?.sendBlock?.(campaign.templateId) : null;
        if (blocked) throw new CampaignError(blocked, 409);
        const recipients = this.resolveAudience(campaign);
        if (!recipients.length) throw new CampaignError('that audience is empty');
        if (!this.manager) throw new CampaignError('no campaign manager is configured', 500);
        const attachment = media ?? this.#media(campaign);
        const options = campaign.options ?? {};
        const meta = this.#metaTemplates(campaign, options);

        this.manager.resetStats();
        this.manager.queue.reset();
        this.manager.pausedByQuota = false;
        let result;
        try {
            result = this.manager.enqueueContacts(recipients, text, {
                campaignId: campaignKey(campaign.id),
                onePerNumber,
                media: attachment,
                interactive: options.interactive ?? null,
                fallbacks: options.fallbacks ?? {},
                pacing: options.pacing ?? 'balanced',
                ...meta,
            });
        } catch (err) {
            if (err instanceof InteractiveError) throw new CampaignError(err.message, 400);
            throw err;
        }
        this.manager.start();
        this.#set(campaign.id, { status: 'running', started_at: this.now(), finished_at: null });
        this.#reason(campaign.id, null);
        return { campaign: this.get(campaign.id), audience: recipients.length, ...result };
    }

    /**
     * Meta approved-template mode (Cloud API only, messaging/templateSend.js):
     * options.templateMode === 'meta' sends `templateId` as the approved
     * template with options.templateParams (else its stored mapping);
     * options.fallbackTemplateId is swapped in when a free-form send hits 131047.
     * `this.channel` is set by the router: () => the live channel row.
     */
    #metaTemplates(campaign, options) {
        if (options.templateMode === 'meta' && campaign.templateId == null) {
            throw new CampaignError('pick an approved Meta template for this campaign');
        }
        const channel = this.channel?.() ?? null;
        try {
            return {
                metaTemplate: options.templateMode === 'meta'
                    ? metaTemplateFor(this.templates, channel, campaign.templateId, options.templateParams) : null,
                fallbackTemplate: metaTemplateFor(this.templates, channel,
                    options.fallbackTemplateId, options.fallbackTemplateParams),
            };
        } catch (err) {
            throw new CampaignError(err.message, err.status ?? 400);
        }
    }

    pause(id) {
        const campaign = this.require(id);
        if (campaign.status !== 'running') throw new CampaignError(`a ${campaign.status} campaign cannot be paused`, 409);
        this.manager?.pause();
        this.#set(campaign.id, { status: 'paused' });
        return this.#reason(campaign.id, null);
    }

    resume(id) {
        const campaign = this.require(id);
        if (campaign.status !== 'paused') throw new CampaignError(`a ${campaign.status} campaign cannot be resumed`, 409);
        // The manager refuses when today's budget is spent; that is its call.
        if (this.manager && this.manager.resume() === false) {
            throw new CampaignError(this.manager.resumeRefusal
                ?? `daily limit of ${this.manager.quota.limit} reached - resume after midnight`, 409);
        }
        this.#set(campaign.id, { status: 'running' });
        return this.#reason(campaign.id, null);
    }

    /** `reason` (an admin or platform stop) is kept on the campaign so its owner sees why. */
    cancel(id, reason = null) {
        const campaign = this.require(id);
        if (FINAL.includes(campaign.status)) return campaign;
        const dropped = this.manager?.stop(reason ?? undefined) ?? 0;
        this.#set(campaign.id, { status: 'cancelled', finished_at: this.now(), dropped });
        return this.#reason(campaign.id, reason);
    }

    /**
     * The manager paused (auto-pause, business cap) or stopped (kill switch)
     * the run for `key`: mirror that on the record, with the reason.
     */
    policyHalt(key, status, reason) {
        const id = Number(String(key ?? '').replace(/^camp-/, ''));
        const campaign = Number.isInteger(id) ? this.get(id) : null;
        if (!campaign || !['running', 'paused'].includes(campaign.status)) return null;
        this.#set(id, status === 'cancelled' ? { status, finished_at: this.now() } : { status });
        return this.#reason(id, reason);
    }

    #reason(id, reason) {
        const campaign = this.get(id);
        if ((campaign.options?.statusReason ?? null) === reason) return campaign;
        const options = { ...(campaign.options ?? {}), statusReason: reason };
        this.db.prepare('UPDATE campaigns SET options = ? WHERE id = ? AND tenant_id = ?')
            .run(JSON.stringify(options), campaign.id, this.tenantId);
        return this.get(id);
    }

    /** campaigns.* plan rules (policy/campaignOps.js campaignRefusal). */
    #checkPolicy(campaign, { starting = false, except = null } = {}) {
        if (!this.policy) return;
        const counts = (status) => this.db.prepare(
            'SELECT COUNT(*) AS n FROM campaigns WHERE tenant_id = ? AND status = ? AND id IS NOT ?')
            .get(this.tenantId, status, except).n;
        const refusal = campaignRefusal(this.policy(), campaign, counts, { starting });
        if (refusal) throw new CampaignError(refusal.message, refusal.status);
    }

    /**
     * Delivery counts straight out of `messages`, grouped by status. Nothing
     * is double-counted anywhere: the message rows are the only tally.
     *
     * A running campaign with nothing left QUEUED or SENDING is finished, so
     * this is also where `done` gets written - no timer, no callback.
     */
    stats(id) {
        const campaign = this.require(id);
        const byStatus = this.counts(campaignKey(campaign.id));
        const total = Object.values(byStatus).reduce((n, v) => n + v, 0);
        const pending = OPEN_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
        const failed = byStatus.FAILED ?? 0;
        const snapshot = { total, pending, failed, sent: total - pending - failed, byStatus };

        if (campaign.status === 'running' && total > 0 && pending === 0) {
            this.#set(campaign.id, { status: 'done', finished_at: this.now(), ...snapshot });
            return { campaign: this.get(campaign.id), stats: snapshot };
        }
        this.#set(campaign.id, snapshot);
        return { campaign: this.get(campaign.id), stats: snapshot };
    }

    // ------------------------------------------------------------- v2 ops --
    /**
     * Change the speed preset. Stored on the campaign (a retry reuses it) and,
     * when this campaign is the run the manager is holding, applied live.
     */
    setSpeed(id, preset) {
        const campaign = this.require(id);
        if (!PACING_PRESETS.includes(preset)) {
            throw new CampaignError(`pacing must be one of ${PACING_PRESETS.join(', ')}`);
        }
        const options = { ...(campaign.options ?? {}), pacing: preset };
        this.db.prepare('UPDATE campaigns SET options = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
            .run(JSON.stringify(options), this.now(), campaign.id, this.tenantId);
        const live = this.#isLive(campaign);
        if (live) this.manager?.setPace?.(preset);
        const batch = live ? undefined : (campaign.audienceSize ?? 0);
        const safety = this.manager?.safetyStatus ? this.manager.safetyStatus(batch, preset) : null;
        return { campaign: this.get(campaign.id), safety };
    }

    /**
     * Send again to everyone whose latest message in this campaign FAILED -
     * the stored, already personalised text, the same media (no re-upload) and
     * the campaign's buttons re-personalised for that person. Nobody who got
     * the message gets it twice.
     */
    retryFailed(id) {
        const { campaign, stats } = this.stats(id);
        if (['draft', 'scheduled', 'running'].includes(campaign.status)) {
            throw new CampaignError(`a ${campaign.status} campaign has nothing to retry yet`, 409);
        }
        if (campaign.status === 'paused' && stats.pending > 0) {
            throw new CampaignError('that campaign still has messages waiting; resume or cancel it first', 409);
        }
        if (this.canSend && !this.canSend()) throw new CampaignError('Connect a transport first.', 409);
        if (!this.manager) throw new CampaignError('no campaign manager is configured', 500);
        const optOuts = this.#optOuts();
        const failed = this.latestRows(campaign.id)
            .filter((row) => row.status === 'FAILED' && !optOuts.has(digits(row.recipient)));
        if (!failed.length) throw new CampaignError('nothing failed in that campaign', 409);

        const media = this.#media(campaign);
        const options = campaign.options ?? {};
        const key = campaignKey(campaign.id);
        const meta = this.#metaTemplates(campaign, options);
        this.manager.resetStats();
        this.manager.queue.reset();
        this.manager.pausedByQuota = false;
        this.manager.campaignId = key;
        let queued = 0;
        for (const row of failed) {
            const contact = this.#contactFor(campaign, row.recipient, row.name);
            const context = withFallbacks(contactContext(contact), options.fallbacks ?? {});
            // Same per-recipient resolution as manager.enqueueContacts; the
            // stored text stays the message (history + free-form fallback).
            const sends = templateSendsFor(meta, context);
            if (sends.missing) continue;
            const interactive = options.interactive
                ? personalizeInteractive(options.interactive,
                    withFallbacks(contactContext(contact), options.fallbacks ?? {}))
                : null;
            const messageId = this.manager.enqueueJob({
                recipient: row.recipient,
                text: row.message,
                name: row.name ?? '',
                campaignId: key,
                media,
                messageType: 'campaign',
                interactive,
                template: sends.template,
                fallbackTemplate: sends.fallbackTemplate,
            });
            if (messageId !== null) queued += 1;
        }
        this.manager.setPace?.(options.pacing ?? 'balanced', queued);
        this.manager.start();
        this.db.prepare(`UPDATE campaigns SET status = 'running', finished_at = NULL, updated_at = ?
                         WHERE id = ? AND tenant_id = ?`).run(this.now(), campaign.id, this.tenantId);
        return { campaign: this.get(campaign.id), queued };
    }

    /**
     * The latest message row per recipient for this campaign - a retry adds a
     * new row, and the newest one is the truth about that person.
     */
    latestRows(id) {
        return this.db.prepare(
            `SELECT m.* FROM messages m
             WHERE m.tenant_id = ? AND m.campaign_id = ?
               AND m.rowid = (SELECT MAX(rowid) FROM messages x
                              WHERE x.tenant_id = m.tenant_id AND x.campaign_id = m.campaign_id
                                AND x.recipient = m.recipient)
             ORDER BY m.rowid`).all(this.tenantId, campaignKey(id));
    }

    /** Funnel, failure reasons, button clicks and one row per recipient. */
    analytics(id) {
        const { campaign } = this.stats(id);
        const rows = this.latestRows(campaign.id);
        const replied = this.#repliedSet(campaign.startedAt);
        const clickData = this.#clickData(campaignKey(campaign.id));
        const count = (statuses) => rows.filter((r) => statuses.includes(r.status)).length;

        const failures = new Map();
        const recipients = rows.map((row) => {
            let errorCode = null;
            if (row.status === 'FAILED') {
                const text = String(row.error ?? '').trim();
                errorCode = normalizeError(new Error(text)).code;
                const label = FRIENDLY[errorCode] ?? (text || 'Unknown error');
                const bucket = errorCode === ErrorCode.UNKNOWN ? `${errorCode}:${label}` : errorCode;
                const entry = failures.get(bucket) ?? { code: errorCode, label, count: 0 };
                entry.count += 1;
                failures.set(bucket, entry);
            }
            const picks = clickData?.byRecipient.get(digits(row.recipient)) ?? [];
            return {
                phone: row.recipient,
                name: row.name ?? '',
                status: row.status,
                updatedAt: row.updated_at,
                error: row.error ?? null,
                errorCode,
                clicked: picks.length ? picks.map((p) => p.title || p.id).join(', ') : null,
                replied: replied.has(digits(row.recipient)),
            };
        });

        const hasButtons = Boolean(campaign.options?.interactive);
        return {
            campaign,
            funnel: {
                audience: campaign.audienceSize ?? rows.length,
                queued: rows.length,
                sent: count(SENT_STATUSES),
                delivered: count(DELIVERED_STATUSES),
                read: count(['READ']),
                replied: recipients.filter((r) => r.replied).length,
                failed: count(['FAILED']),
            },
            failures: [...failures.values()].sort((a, b) => b.count - a.count),
            clicks: clickData && (hasButtons || clickData.clicks.length) ? clickData.clicks : null,
            recipients,
        };
    }

    /** Per-recipient report as CSV text. */
    exportCsv(id) {
        const { recipients } = this.analytics(id);
        return toCsv([
            ['timestamp', 'phone', 'name', 'status', 'error', 'button_clicked'],
            ...recipients.map((r) => [r.updatedAt, r.phone, r.name, r.status, r.error ?? '', r.clicked ?? '']),
        ]);
    }

    /**
     * Scheduled campaigns whose time has come. Nothing here sets a timer: a
     * scheduler job calls this and then `start`, exactly as workflow runs do.
     */
    due(now = this.now()) {
        return this.db.prepare(
            `SELECT * FROM campaigns WHERE tenant_id = ? AND status = 'scheduled' AND scheduled_at <= ?
             ORDER BY scheduled_at`).all(this.tenantId, iso(now)).map(toCampaign);
    }

    // ------------------------------------------------------------ helpers --
    #isLive(campaign) {
        return ['running', 'paused'].includes(campaign.status)
            && this.manager?.campaignId === campaignKey(campaign.id);
    }

    #media(campaign) {
        if (!campaign.mediaId) return null;
        const media = this.mediaLookup?.(campaign.mediaId) ?? null;
        if (!media) throw new CampaignError('media not found', 404);
        return media;
    }

    #optOuts() {
        return new Set(this.db.prepare('SELECT phone FROM opt_outs WHERE tenant_id = ?')
            .all(this.tenantId).map((r) => digits(r.phone)));
    }

    /** Senders (digits only) with an inbound message at or after `since`. */
    #repliedSet(since) {
        if (!since) return new Set();
        return new Set(this.db.prepare(
            'SELECT DISTINCT sender FROM inbound_messages WHERE tenant_id = ? AND received_at >= ?')
            .all(this.tenantId, since).map((r) => digits(r.sender)));
    }

    /**
     * Who tapped what: the channel's interactive-stats hook when there is one,
     * else the `button_clicks` table, else null (the feature is not there).
     * @returns {{ clicks: {id,title,count}[], byRecipient: Map<string, {id,title}[]> } | null}
     */
    #clickData(key) {
        let hooked = null;
        try {
            hooked = this.interactiveStats?.(key) ?? null;
        } catch {
            hooked = null;
        }
        if (hooked && Array.isArray(hooked.clicks)) {
            const byRecipient = new Map();
            const entries = hooked.byRecipient instanceof Map ? [...hooked.byRecipient]
                : Object.entries(hooked.byRecipient ?? {});
            for (const [phone, value] of entries) {
                const list = (Array.isArray(value) ? value : [value]).filter(Boolean).map((v) => (typeof v === 'object'
                    ? { id: String(v.id ?? v.optionId ?? ''), title: String(v.title ?? v.optionTitle ?? '') }
                    : { id: String(v), title: '' }));
                byRecipient.set(digits(phone), list);
            }
            return {
                clicks: hooked.clicks.map((c) => ({ id: c.id, title: c.title ?? '', count: Number(c.count) || 0 })),
                byRecipient,
            };
        }
        let rows;
        try {
            rows = this.db.prepare(
                'SELECT option_id, option_title, recipient FROM button_clicks WHERE tenant_id = ? AND campaign_id = ? ORDER BY rowid')
                .all(this.tenantId, key);
        } catch {
            return null; // the button feature is not installed on this database
        }
        const byOption = new Map();
        const byRecipient = new Map();
        for (const row of rows) {
            const id = row.option_id ?? '';
            const option = byOption.get(id) ?? { id, title: row.option_title ?? '', count: 0 };
            option.count += 1;
            byOption.set(id, option);
            const list = byRecipient.get(digits(row.recipient)) ?? [];
            list.push({ id, title: row.option_title ?? '' });
            byRecipient.set(digits(row.recipient), list);
        }
        return { clicks: [...byOption.values()], byRecipient };
    }

    #known(phone) {
        try {
            return this.contacts?.getByPhone(this.contacts.normalize(phone)) ?? null;
        } catch {
            return null;
        }
    }

    /** The recipient as the campaign knew them: the list entry's extras, or the contact's fields. */
    #contactFor(campaign, phone, name = '') {
        if (Array.isArray(campaign.audience)) {
            const entry = campaign.audience.find((e) => digits(e?.phone) === digits(phone));
            if (entry) return { name: entry.name || name || '', phone, extra: entry.extra ?? {} };
        }
        const known = this.#known(phone);
        return { name: name || known?.name || '', phone, extra: known?.customFields ?? {} };
    }

    /** `{retarget:{campaignId, filter, optionId?}}`, resolved against the source's latest rows. */
    #retargetAudience(spec = {}) {
        const filter = String(spec?.filter ?? '');
        if (!RETARGET_FILTERS.includes(filter)) {
            throw new CampaignError(`retarget filter must be one of ${RETARGET_FILTERS.join(', ')}`);
        }
        const source = this.get(spec.campaignId);
        if (!source) throw new CampaignError('the campaign to retarget was not found', 404);
        const rows = this.latestRows(source.id);
        const replied = this.#repliedSet(source.startedAt);
        let keep;
        if (filter === 'failed') keep = (r) => r.status === 'FAILED';
        else if (filter === 'unread') keep = (r) => r.status === 'SENT' || r.status === 'DELIVERED';
        else if (filter === 'noreply') {
            keep = (r) => ['SENT', 'DELIVERED', 'READ'].includes(r.status) && !replied.has(digits(r.recipient));
        } else if (filter === 'replied') keep = (r) => replied.has(digits(r.recipient));
        else {
            const clicks = this.#clickData(campaignKey(source.id));
            const wanted = spec.optionId == null || spec.optionId === '' ? null : String(spec.optionId);
            keep = (r) => (clicks?.byRecipient.get(digits(r.recipient)) ?? [])
                .some((p) => wanted === null || p.id === wanted);
        }
        const optOuts = this.#optOuts();
        return rows.filter(keep).map((row) => {
            if (optOuts.has(digits(row.recipient))) return null;
            const known = this.#known(row.recipient);
            if (known && !known.messageable) return null;
            const contact = this.#contactFor(source, row.recipient, row.name ?? '');
            return { name: row.name || contact.name || '', phone: row.recipient, extra: contact.extra ?? {} };
        }).filter(Boolean);
    }

    /** Write status/timestamps and merge a stats snapshot in one statement. */
    #set(id, { status = null, started_at = null, finished_at = null, ...stats } = {}) {
        const sets = ['updated_at = ?'];
        const args = [this.now()];
        if (status) { sets.push('status = ?'); args.push(status); }
        if (started_at) { sets.push('started_at = ?'); args.push(started_at); }
        if (finished_at !== null) { sets.push('finished_at = ?'); args.push(finished_at); }
        if (Object.keys(stats).length) { sets.push('stats = ?'); args.push(JSON.stringify(stats)); }
        this.db.prepare(`UPDATE campaigns SET ${sets.join(', ')} WHERE id = ? AND tenant_id = ?`)
            .run(...args, Number(id), this.tenantId);
        return this.get(id);
    }
}

/**
 * The bridge to `messages.campaign_id`. Deterministic, so stats need no extra
 * column and a restart cannot lose the link between a row and its campaign.
 */
export const campaignKey = (id) => `camp-${Number(id)}`;

/**
 * For the scheduler, which is not a tenant: which campaigns are due anywhere,
 * and whose they are, so it can start each through that tenant's store.
 */
export function dueCampaigns(database, now = new Date()) {
    return database.db.prepare(
        `SELECT id, tenant_id, channel_id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ?
         ORDER BY scheduled_at`).all(iso(now))
        .map((row) => ({ id: row.id, tenantId: row.tenant_id, channelId: row.channel_id }));
}

/** Same shape as `utcNow()`, so timestamps compare as strings across tables. */
export const iso = (value) => (typeof value === 'string' ? value
    : new Date(value).toISOString().replace(/\.\d{3}Z$/, '+00:00'));

/**
 * Add `campaigns.options` to a database created before it existed. Checked
 * once per database handle; idempotent either way.
 */
const migrated = new WeakSet();
export function ensureCampaignOptionsColumn(db) {
    if (migrated.has(db)) return;
    const columns = db.prepare('PRAGMA table_info(campaigns)').all();
    if (!columns.length) return; // table not created yet: check again next time
    if (!columns.some((c) => c.name === 'options')) {
        db.exec("ALTER TABLE campaigns ADD COLUMN options TEXT NOT NULL DEFAULT '{}'");
    }
    migrated.add(db);
}

/**
 * Clean a campaign's v2 options: { interactive, fallbacks, pacing, timezone,
 * dedupeDays, variables, mediaMeta }. Unknown keys pass through untouched
 * (other features may keep their own there); known ones are validated.
 */
export function normalizeOptions(input) {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = { ...src };
    try {
        out.interactive = normalizeInteractive(src.interactive);
    } catch (err) {
        if (err instanceof InteractiveError) throw new CampaignError(err.message, 400);
        throw err;
    }
    const fallbacks = {};
    const given = src.fallbacks && typeof src.fallbacks === 'object' ? src.fallbacks : {};
    for (const [key, value] of Object.entries(given)) {
        if (/^\w+$/.test(key) && value != null && String(value).trim()) fallbacks[key] = String(value).slice(0, 500);
    }
    out.fallbacks = fallbacks;
    if (src.pacing !== undefined && src.pacing !== null && !PACING_PRESETS.includes(src.pacing)) {
        throw new CampaignError(`pacing must be one of ${PACING_PRESETS.join(', ')}`);
    }
    out.pacing = src.pacing ?? 'balanced';
    if (src.dedupeDays !== undefined) out.dedupeDays = Math.max(0, Math.floor(Number(src.dedupeDays) || 0));
    if (src.timezone !== undefined) out.timezone = src.timezone ? String(src.timezone).slice(0, 64) : null;
    if (src.variables !== undefined) {
        out.variables = (Array.isArray(src.variables) ? src.variables : []).map(String).slice(0, 100);
    }
    return out;
}

const digits = (phone) => String(phone ?? '').replace(/\D/g, '');
const pickStatus = (value, fallback) => (CAMPAIGN_STATUSES.includes(value) ? value : fallback);
const nullableInt = (value) => (value == null || value === '' ? null : Number(value));
const toRecipient = (contact) => ({ name: contact.name, phone: contact.phone, extra: contact.customFields ?? {} });

function toCampaign(row) {
    const audience = parse(row.audience, null);
    return {
        id: row.id,
        tenantId: row.tenant_id,
        channelId: row.channel_id,
        name: row.name,
        status: row.status,
        templateId: row.template_id,
        body: row.body ?? '',
        segmentId: row.segment_id,
        audience,
        audienceSize: Array.isArray(audience) ? audience.length : null,
        mediaId: row.media_id,
        scheduledAt: row.scheduled_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        stats: parse(row.stats, {}),
        options: parse(row.options, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}
