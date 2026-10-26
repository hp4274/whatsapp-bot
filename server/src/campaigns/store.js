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
import { shuffle } from '../campaign/humanize.js';
import { PACING_PRESETS } from '../campaign/safety.js';
import { dayKey, daysBetween, isDateKey, isEarlyContinue, nextDayAt, spreadPlan, todaysBatch } from '../campaign/spread.js';
import { linkClicksByRecipient } from '../links/store.js';
import { ErrorCode, FRIENDLY, normalizeError } from '../messaging/errors.js';
import { InteractiveError, normalizeInteractive, personalizeInteractive } from '../messaging/interactive.js';
import { campaignRefusal } from '../policy/campaignOps.js';
import { Status, contactContext, utcNow } from '../protocol.js';

export const CAMPAIGN_STATUSES = Object.freeze([
    'draft', 'scheduled', 'running', 'paused', 'done', 'cancelled',
]);

/** Statuses after which nothing more will be sent. */
const FINAL = Object.freeze(['done', 'cancelled']);

/** The queue depth a campaign still has in flight, by message status. */
const OPEN_STATUSES = Object.freeze(['QUEUED', 'SENDING']);

/** Funnel buckets, cumulative: a READ row was also delivered and sent. */
const SENT_STATUSES = Object.freeze(['SENT', 'DELIVERED', 'READ', 'SANDBOX']);
const DELIVERED_STATUSES = Object.freeze(['DELIVERED', 'READ']);

export const RETARGET_FILTERS = Object.freeze(['failed', 'unread', 'noreply', 'replied', 'clicked', 'clickedLink']);

/** A/B version keys, in order. */
export const VARIANT_KEYS = Object.freeze(['A', 'B', 'C']);
export const RECURRENCE_EVERY = Object.freeze(['day', 'week', 'month']);

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
     * @param {() => object} [deps.replies]  InteractiveStore (reply rules), copied onto a repeat run
     */
    constructor(database, {
        contacts, templates = null, manager = null, now = null,
        canSend = null, media = null, interactiveStats = null, policy = null, replies = null,
    } = {}) {
        this.policy = policy;
        this.replies = replies;
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
        if (cleanOptions.spread) cleanOptions.spread.cursor = 0;
        audience = this.#planSpread(cleanOptions, audience).audience;
        this.#checkPolicy({ status: wanted, audience, options: cleanOptions });
        const now = this.now();
        const info = this.db.prepare(
            `INSERT INTO campaigns (tenant_id, channel_id, name, status, template_id, body, segment_id,
                                    audience, media_id, scheduled_at, stats, options, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`)
            .run(this.tenantId, channelId === undefined ? this.channelId : nullableInt(channelId),
                clean, wanted, nullableInt(templateId), String(body ?? ''), nullableInt(segmentId),
                JSON.stringify(audience ?? null), mediaId == null ? null : String(mediaId),
                scheduledIso(scheduledAt), JSON.stringify(cleanOptions), now, now);
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
            scheduledAt: patch.scheduledAt === undefined ? campaign.scheduledAt : scheduledIso(patch.scheduledAt),
            status: patch.status === undefined ? campaign.status : pickStatus(patch.status, campaign.status),
            options: patch.options === undefined ? campaign.options : normalizeOptions(patch.options),
        };
        if (!next.name) throw new CampaignError('a campaign needs a name');
        // Mid-run the cursor indexes the stored order: the list cannot change under it.
        const cursor = campaign.options?.spread?.cursor ?? 0;
        if (cursor > 0 && patch.audience !== undefined) {
            throw new CampaignError('the list of a spread campaign cannot change once it has started sending', 409);
        }
        if (next.options.spread) next.options.spread.cursor = cursor;
        next.audience = this.#planSpread(next.options, next.audience, { reshuffle: patch.audience !== undefined }).audience;
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
    resolveAudience(campaign, options = {}) {
        const list = this.#baseAudience(campaign, options);
        const extras = campaign.options?.extraNumbers;
        // A file's typed numbers are already in its explicit list (which spread pages through).
        if (Array.isArray(campaign.audience) || !extras?.length) return list;
        const seen = new Set(list.map((r) => this.#normalized(r.phone)));
        for (const entry of extras) {
            const phone = this.#normalized(entry.phone);
            if (!phone || seen.has(phone)) continue;
            seen.add(phone);
            const known = this.contacts.getByPhone(phone);
            if (known && !known.messageable) continue;
            list.push({ name: entry.name || known?.name || '', phone: known?.phone ?? phone, extra: {} });
        }
        return list;
    }

    /** A phone in the contact book's form, or '' when it isn't a number. */
    #normalized(phone) {
        try {
            return this.contacts.normalize(String(phone ?? '').trim());
        } catch {
            return '';
        }
    }

    #baseAudience(campaign, { limit = 5000, offset = 0 } = {}) {
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
            return audience.slice(offset, offset + limit).map((entry) => {
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

    /**
     * The text the manager personalises per contact: the campaign's own `body`
     * when it has one (the composer's edits and opt-out line), else the
     * template's stored body.
     */
    messageText(campaign) {
        if (campaign.body?.trim()) return campaign.body;
        // A/B: each version carries its own body; A stands for the campaign.
        if (campaign.options?.variants?.[0]?.body) return campaign.options.variants[0].body;
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
        // Its own number sends it: another number's manager would send from the wrong phone.
        if (campaign.channelId != null && this.channelId != null && campaign.channelId !== this.channelId) {
            throw new CampaignError('that campaign sends from another number; switch to it to start', 409);
        }
        if (campaign.status === 'running') throw new CampaignError('that campaign is already running', 409);
        if (campaign.status === 'paused') throw new CampaignError('that campaign is paused; resume it', 409);
        if (FINAL.includes(campaign.status)) throw new CampaignError(`that campaign is ${campaign.status}`, 409);
        // No transport, no send - for the scheduler too: a scheduled campaign
        // simply stays `scheduled` and the next sweep tries again.
        if (this.canSend && !this.canSend()) throw new CampaignError('Connect a transport first.', 409);
        this.#checkPolicy(campaign, { starting: true, except: campaign.id });
        const text = this.messageText(campaign);
        // Platform template review (templates/policy.js reviewBlock).
        // A template deleted since it was picked does not block a campaign that
        // sends its own body (messageText already refused one that needs it).
        const linked = campaign.templateId != null ? this.templates?.get?.(campaign.templateId) : null;
        const blocked = linked ? this.templates?.sendBlock?.(linked) : null;
        if (blocked) throw new CampaignError(blocked, 409);
        const options = campaign.options ?? {};
        const spread = options.spread && Array.isArray(campaign.audience) ? options.spread : null;
        const cursor = spread?.cursor ?? 0;
        const now = new Date();
        const zone = this.#zone(options);
        const early = Boolean(spread) && campaign.status === 'scheduled'
            && isEarlyContinue({ cursor, scheduledAt: campaign.scheduledAt, now, zone });
        let batch = spread ? todaysBatch({
            total: campaign.audience.length,
            cursor,
            // Early: tomorrow's share, so the rest is divided over the days after today.
            today: dayKey(early ? new Date(campaign.scheduledAt) : now, zone),
            to: spread.to,
        }) : 0;
        let carried = 0;
        if (early) {
            // Only what today's budget covers goes now: the manager would pause on the
            // rest, and the next regular start re-divides whatever is left anyway.
            const take = Math.min(batch, this.#budgetLeft());
            if (take <= 0) {
                throw new CampaignError(`Today's sending limit is already used. The next batch goes out tomorrow at ${spread.startTime}.`, 409);
            }
            carried = batch - take;
            batch = take;
        }
        const recipients = spread
            ? this.resolveAudience(campaign, { offset: cursor, limit: batch })
            : this.resolveAudience(campaign);
        if (spread && !recipients.length) {
            // Everyone left in today's slice opted out: move on instead of retrying forever.
            this.#spreadAdvance(campaign, cursor + batch);
            return { campaign: this.get(campaign.id), audience: 0, queued: 0, carried };
        }
        if (!recipients.length) throw new CampaignError('that audience is empty');
        if (!this.manager) throw new CampaignError('no campaign manager is configured', 500);
        const attachment = media ?? this.#media(campaign);
        let result;
        try {
            result = this.manager.enqueueContacts(recipients, text, {
                reset: { keepOneOff: true }, // after its refusals: a refused start leaves the live queue alone
                campaignId: campaignKey(campaign.id),
                // The "skip duplicate numbers" box: off sends every row, even a repeated number.
                onePerNumber: onePerNumber && options.skipDuplicates !== false,
                media: attachment,
                interactive: this.#withCardMedia(options.interactive),
                fallbacks: options.fallbacks ?? {},
                pacing: options.pacing ?? 'balanced',
                variants: options.variants ?? null,
                trackLinks: options.trackLinks === true,
            });
        } catch (err) {
            if (err instanceof InteractiveError) throw new CampaignError(err.message, 400);
            throw err;
        }
        this.manager.start();
        this.#set(campaign.id, { status: 'running', started_at: campaign.startedAt ?? this.now(), finished_at: null });
        if (spread) this.#saveSpread(campaign, cursor + batch);
        this.#reason(campaign.id, null);
        return { campaign: this.get(campaign.id), audience: recipients.length, ...result, carried };
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
        const notSent = (byStatus.CANCELLED ?? 0) + (byStatus.NOT_ON_WHATSAPP ?? 0);
        const snapshot = { total, pending, failed, sent: total - pending - failed - notSent, byStatus };

        if (campaign.status === 'running' && total > 0 && pending === 0) {
            const spread = campaign.options?.spread;
            if (spread && spread.cursor < spread.total) {
                // Today's batch is out; the rest waits for tomorrow's start.
                this.#set(campaign.id, { status: 'scheduled', ...snapshot });
                this.#bookNextDay(campaign);
                return { campaign: this.get(campaign.id), stats: snapshot };
            }
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
        this.manager.resetStats();
        this.manager.queue.reset({ keepOneOff: true });
        this.manager.pausedByQuota = false;
        this.manager.campaignId = key;
        let queued = 0;
        for (const row of failed) {
            const contact = this.#contactFor(campaign, row.recipient, row.name);
            const interactive = options.interactive
                ? personalizeInteractive(this.#withCardMedia(options.interactive),
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
                variant: row.variant ?? null,
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
        const linkClicks = linkClicksByRecipient(this.db, this.tenantId, campaignKey(campaign.id));
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
                clickedLink: linkClicks.has(digits(row.recipient)),
                variant: row.variant ?? null,
            };
        });

        // One line per A/B version, the same cumulative buckets as the funnel.
        const versions = campaign.options?.variants;
        const variants = Array.isArray(versions) && versions.length ? versions.map(({ key }) => {
            const mine = rows.filter((r) => r.variant === key);
            const people = recipients.filter((r) => r.variant === key);
            const of = (statuses) => mine.filter((r) => statuses.includes(r.status)).length;
            return {
                key,
                sent: of(SENT_STATUSES),
                delivered: of(DELIVERED_STATUSES),
                read: of(['READ']),
                replied: people.filter((r) => r.replied).length,
                failed: of(['FAILED']),
                clickedLink: people.filter((r) => r.clickedLink).length,
            };
        }) : null;

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
                // Checked before sending and skipped: not a failure, and never retried.
                notOnWhatsapp: count(['NOT_ON_WHATSAPP']),
                clickedLink: recipients.filter((r) => r.clickedLink).length,
            },
            failures: [...failures.values()].sort((a, b) => b.count - a.count),
            clicks: clickData && (hasButtons || clickData.clicks.length) ? clickData.clicks : null,
            variants,
            recipients,
        };
    }

    /** Per-recipient report as CSV text. */
    exportCsv(id) {
        const { recipients } = this.analytics(id);
        return toCsv([
            ['timestamp', 'phone', 'name', 'status', 'error', 'button_clicked', 'link_clicked', 'variant'],
            ...recipients.map((r) => [r.updatedAt, r.phone, r.name, r.status, r.error ?? '', r.clicked ?? '',
                r.clickedLink ? 'yes' : '', r.variant ?? '']),
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

    // --------------------------------------------------------- recurrence --
    /**
     * Repeating campaigns: once a run with `options.recurrence` is done, book
     * the next one as a fresh scheduled campaign - same message, media, options
     * and audience definition (a segment, filter or retarget re-resolves when
     * it starts, so it is today's list). The parent's `nextId`, or its
     * `recurrenceNote` when the chain stops, makes this happen once.
     * Called from the app sweep; returns the campaigns it booked.
     */
    spawnRecurrences(now = new Date()) {
        const rows = this.db.prepare(`SELECT id, status FROM campaigns WHERE tenant_id = ? AND ${RECURRING_OPEN}`)
            .all(this.tenantId);
        const booked = [];
        for (const row of rows) {
            // `done` is written lazily by stats(): a run that just emptied its queue is noticed here.
            const campaign = row.status === 'running' ? this.stats(row.id).campaign : this.get(row.id);
            if (campaign.status !== 'done') continue;
            const { recurrence } = campaign.options;
            const at = nextRun(campaign.scheduledAt || campaign.startedAt, recurrence.every, now);
            if (!at || (recurrence.until && iso(at).slice(0, 10) > recurrence.until)) {
                this.#mergeOptions(campaign.id, { recurrenceNote: 'The repeat schedule has ended.' });
                continue;
            }
            const {
                statusReason, nextId, recurrenceNote, previousId, spread, ...options
            } = campaign.options;
            try {
                const next = this.create({
                    name: campaign.name, status: 'scheduled', templateId: campaign.templateId, body: campaign.body,
                    segmentId: campaign.segmentId, audience: campaign.audience, mediaId: campaign.mediaId,
                    scheduledAt: at, channelId: campaign.channelId, options: { ...options, previousId: campaign.id },
                });
                const replies = this.replies?.();
                const rules = replies?.rules(campaignKey(campaign.id)) ?? [];
                if (rules.length) replies.setRules(campaignKey(next.id), rules);
                this.#mergeOptions(campaign.id, { nextId: next.id });
                booked.push(next);
            } catch (err) {
                // A plan limit (say, too many scheduled): say so on the parent and stop, not retry every tick.
                if (!(err instanceof CampaignError)) throw err;
                this.#mergeOptions(campaign.id, { recurrenceNote: `The next run could not be booked: ${err.message}` });
            }
        }
        return booked;
    }

    #mergeOptions(id, patch) {
        const campaign = this.get(id);
        this.db.prepare('UPDATE campaigns SET options = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
            .run(JSON.stringify({ ...(campaign.options ?? {}), ...patch }), this.now(), campaign.id, this.tenantId);
    }

    // ------------------------------------------------------------- spread --
    /** Can this many go out between `from` and `to` under today's cap? */
    spreadCheck({ count, from, to, timezone = null } = {}) {
        const quota = this.manager?.quota;
        const safe = this.manager?.config?.safetyEnabled !== false;
        // ponytail: today's level cap and the plan's daily cap only; a monthly cap is enforced at send time.
        // planLimit: a resting QR number plans at level 1's day, not at its 0 ("no cap").
        const limit = Math.min(...[safe ? quota?.planLimit?.() : 0, this.manager?.bulkPolicy?.()?.dailyCap]
            .map(Number).filter((n) => n > 0), Infinity);
        const row = quota?.tier?.() ?? null;
        const levels = safe && quota?.qr;
        return spreadPlan({
            count, from, to, limit: Number.isFinite(limit) ? limit : 0,
            today: dayKey(new Date(), timezone || this.manager?.timezone?.() || null),
            level: levels ? { level: row.level, name: row.name } : null,
            newChats: levels ? quota.allowance().newChatsPerDay : 0,
        });
    }

    /**
     * Validate `options.spread` against the list, shuffle the list (once, so
     * the order is the campaign's, not the sheet's) and fill in the counters.
     * No-op without `options.spread`.
     */
    #planSpread(options, audience, { reshuffle = true } = {}) {
        const spread = options.spread;
        if (!spread) return { audience };
        if (!Array.isArray(audience) || !audience.length) {
            throw new CampaignError('spread sending needs an uploaded list of contacts');
        }
        const list = reshuffle ? shuffle([...audience]) : audience;
        const cursor = spread.cursor ?? 0;
        const plan = this.spreadCheck({ count: list.length - cursor, from: spread.from, to: spread.to, timezone: options.timezone });
        if (!plan.feasible) throw new CampaignError(plan.reason);
        options.spread = { ...spread, cursor, total: list.length, days: plan.days };
        return { audience: list };
    }

    #zone(options) {
        return options?.timezone || this.manager?.timezone?.() || null;
    }

    /**
     * What may still go out today: the level / plan quota and the platform's business cap,
     * whichever is tighter (Infinity when neither applies, like `spreadCheck`).
     */
    #budgetLeft() {
        const left = [this.manager?.quota?.remaining?.(), this.manager?.bulkPolicy?.()?.capRemaining?.()?.left]
            .map(Number).filter(Number.isFinite);
        return Math.min(...left, Infinity);
    }

    #saveSpread(campaign, cursor) {
        const options = { ...campaign.options, spread: { ...campaign.options.spread, cursor } };
        this.db.prepare('UPDATE campaigns SET options = ? WHERE id = ? AND tenant_id = ?')
            .run(JSON.stringify(options), campaign.id, this.tenantId);
    }

    /** Back to `scheduled`, due at tomorrow's start time. */
    #bookNextDay(campaign) {
        const at = nextDayAt(new Date(), this.#zone(campaign.options), campaign.options.spread.startTime);
        this.db.prepare('UPDATE campaigns SET scheduled_at = ? WHERE id = ? AND tenant_id = ?')
            .run(iso(at), campaign.id, this.tenantId);
    }

    /** A slice produced nothing to send: skip it, then finish or book the next day. */
    #spreadAdvance(campaign, cursor) {
        this.#saveSpread(campaign, cursor);
        if (cursor < campaign.options.spread.total) this.#bookNextDay(campaign);
        else this.#set(campaign.id, { status: 'done', finished_at: this.now() });
    }

    /**
     * Sweeper hook for a running spread campaign: finish today's batch (the next
     * day gets booked). A daily-cap pause lifts itself in the manager.
     */
    tick(id) {
        const campaign = this.get(id);
        if (!campaign?.options?.spread || campaign.status !== 'running') return;
        this.stats(id);
    }

    /**
     * A restart empties the manager's in-memory queue while the campaign still
     * reads `running` and its rows are still QUEUED: nothing would ever send
     * them. Rebuild the queue from those rows (same ids, same order) and carry on.
     * Waits for a connected transport, like `start`. True when it re-queued.
     *
     * ponytail: a row caught mid-send (SENDING) goes out again; the window
     * between the transport accepting a message and the db write is milliseconds.
     */
    recover(id) {
        const campaign = this.get(id);
        const manager = this.manager;
        if (!campaign || !manager || !['running', 'paused'].includes(campaign.status)) return false;
        // This run is already in the manager, or the manager is busy with another one.
        if (this.#isLive(campaign) || manager.queue.pending || manager.inFlight) return false;
        if (this.canSend && !this.canSend()) return false;
        const key = campaignKey(campaign.id);
        const rows = this.db.prepare(
            `SELECT * FROM messages WHERE tenant_id = ? AND campaign_id = ? AND status IN ('QUEUED', 'SENDING')
             ORDER BY rowid`).all(this.tenantId, key);
        if (!rows.length) return false;

        const options = campaign.options ?? {};
        const media = this.#media(campaign);
        const jobs = [];
        const mark = this.db.prepare('UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE message_id = ? AND tenant_id = ?');
        for (const row of rows) {
            const contact = this.#contactFor(campaign, row.recipient, row.name);
            const context = withFallbacks(contactContext(contact), options.fallbacks ?? {});
            if (row.status === Status.SENDING) mark.run(Status.QUEUED, null, this.now(), row.message_id, this.tenantId);
            jobs.push({
                messageId: row.message_id, attempt: row.attempt, recipient: row.recipient, text: row.message,
                name: row.name ?? '', media,
                interactive: options.interactive ? personalizeInteractive(this.#withCardMedia(options.interactive), context) : null,
                variant: row.variant ?? null,
            });
        }
        const byStatus = this.counts(key);
        const open = OPEN_STATUSES.reduce((n, s) => n + (byStatus[s] ?? 0), 0);
        const failed = byStatus.FAILED ?? 0;
        const notOnWhatsapp = byStatus.NOT_ON_WHATSAPP ?? 0;
        manager.restoreRun({
            campaignId: key, jobs, failed, notOnWhatsapp,
            sent: Object.values(byStatus).reduce((n, v) => n + v, 0) - open - failed - notOnWhatsapp,
            paused: campaign.status === 'paused', pacing: options.pacing ?? 'balanced',
        });
        return true;
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

    /** The interactive block ready to send: a carousel's cards get their image file resolved (kept in memory, rebuilt from options after a restart). */
    #withCardMedia(interactive) {
        if (interactive?.type !== 'carousel') return interactive ?? null;
        const cards = interactive.carousel.cards.map((card) => {
            const media = this.mediaLookup?.(card.mediaId) ?? null;
            if (!media) throw new CampaignError('media not found', 404);
            return { ...card, media };
        });
        return { ...interactive, carousel: { ...interactive.carousel, cards } };
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
        else if (filter === 'clickedLink') {
            const tapped = linkClicksByRecipient(this.db, this.tenantId, campaignKey(source.id));
            keep = (r) => tapped.has(digits(r.recipient));
        } else {
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

/** For the scheduler: running or paused campaigns that still own QUEUED rows (see `recover`). */
export function openCampaigns(database) {
    return database.db.prepare(
        `SELECT c.id, c.tenant_id, c.channel_id FROM campaigns c WHERE c.status IN ('running', 'paused')
           AND EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id
                       AND m.campaign_id = 'camp-' || c.id AND m.status IN ('QUEUED', 'SENDING'))`)
        .all().map((row) => ({ id: row.id, tenantId: row.tenant_id, channelId: row.channel_id }));
}

/** For the scheduler: running spread campaigns that need their daily nudge (see `tick`). */
export function runningSpreadCampaigns(database) {
    return database.db.prepare(
        `SELECT id, tenant_id, channel_id FROM campaigns WHERE status = 'running' AND options LIKE '%"spread"%'`)
        .all().map((row) => ({ id: row.id, tenantId: row.tenant_id, channelId: row.channel_id }));
}

/** Repeating campaigns whose next run is not booked yet (and whose chain has not stopped). */
const RECURRING_OPEN = `status IN ('running', 'done') AND options LIKE '%"recurrence"%' AND json_valid(options)
    AND json_extract(options, '$.recurrence.every') IS NOT NULL
    AND json_extract(options, '$.nextId') IS NULL AND json_extract(options, '$.recurrenceNote') IS NULL`;

/** For the scheduler: tenants with a repeating campaign that may need its next run booked. */
export function recurringTenants(database) {
    return database.db.prepare(`SELECT DISTINCT tenant_id FROM campaigns WHERE ${RECURRING_OPEN}`)
        .all().map((row) => row.tenant_id);
}

/**
 * The first `every` step after `base` that is still ahead of `now`. A missed
 * run (the server was off) is skipped, not sent late. A month step keeps the
 * day where it can: the 31st repeats on the 30th, or the 28th in February.
 *
 * ponytail: UTC arithmetic, so a daily send moves by an hour of local time
 * across a DST change.
 */
export function nextRun(base, every, now = new Date()) {
    const start = new Date(base ?? NaN);
    if (Number.isNaN(start.getTime()) || !RECURRENCE_EVERY.includes(every)) return null;
    for (let k = 1; k <= 10_000; k += 1) {
        const at = new Date(start);
        if (every === 'month') {
            at.setUTCDate(1);
            at.setUTCMonth(start.getUTCMonth() + k);
            const last = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)).getUTCDate();
            at.setUTCDate(Math.min(start.getUTCDate(), last));
        } else {
            at.setTime(start.getTime() + k * (every === 'week' ? 7 : 1) * 86_400_000);
        }
        if (at > now) return at;
    }
    return null;
}

/** Same shape as `utcNow()`, so timestamps compare as strings across tables. */
export const iso = (value) => (typeof value === 'string' ? value
    : new Date(value).toISOString().replace(/\.\d{3}Z$/, '+00:00'));

/** A client's scheduled_at in any offset, stored as UTC so `due` can compare it as text. */
function scheduledIso(value) {
    if (!value) return null;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) throw new CampaignError('scheduled_at must be a date and time, like 2026-11-01T09:30:00+05:30');
    return iso(at);
}

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
 * dedupeDays, variables, mediaMeta, trackLinks, recurrence, variants }. The
 * server writes statusReason, nextId / previousId and recurrenceNote itself.
 * Unknown keys pass through untouched
 * (other features may keep their own there); known ones are validated.
 */
export function normalizeOptions(input) {
    const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const out = { ...src };
    try {
        out.interactive = normalizeInteractive(src.interactive, { carousel: true });
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
    if (src.spread !== undefined) out.spread = normalizeSpread(src.spread);
    if (src.variables !== undefined) {
        out.variables = (Array.isArray(src.variables) ? src.variables : []).map(String).slice(0, 100);
    }
    // Only spawnRecurrences writes these: a duplicated campaign must still repeat.
    delete out.nextId;
    delete out.recurrenceNote;
    if (src.trackLinks !== undefined) out.trackLinks = src.trackLinks === true;
    if (src.recurrence !== undefined) out.recurrence = normalizeRecurrence(src.recurrence);
    if (out.recurrence && out.spread) {
        throw new CampaignError('a repeating campaign cannot also be spread over several days');
    }
    if (src.extraNumbers !== undefined) out.extraNumbers = normalizeExtraNumbers(src.extraNumbers);
    if (src.variants !== undefined) out.variants = normalizeVariants(src.variants);
    return out;
}

/** `{every: 'day'|'week'|'month', until?: 'YYYY-MM-DD'}`, or null for a one-off. */
function normalizeRecurrence(input) {
    if (!input) return null;
    if (!RECURRENCE_EVERY.includes(input.every)) {
        throw new CampaignError(`recurrence.every must be one of ${RECURRENCE_EVERY.join(', ')}`);
    }
    const until = input.until ? String(input.until) : null;
    if (until && !isDateKey(until)) throw new CampaignError('recurrence.until must be a date (YYYY-MM-DD)');
    return until ? { every: input.every, until } : { every: input.every };
}

/** Typed numbers added to a contacts / past-campaign audience: `[{phone, name}]`, at most 500. */
function normalizeExtraNumbers(input) {
    if (input == null || (Array.isArray(input) && !input.length)) return null;
    if (!Array.isArray(input)) throw new CampaignError('extraNumbers must be a list of numbers');
    if (input.length > 500) throw new CampaignError('add at most 500 numbers by hand - upload a file for more');
    return input
        .map((e) => ({ phone: String(e?.phone ?? '').trim().slice(0, 20), name: String(e?.name ?? '').trim().slice(0, 100) }))
        .filter((e) => e.phone);
}

/** 2 or 3 versions `[{key: 'A', body}, {key: 'B', body}]`, or null without A/B testing. */
function normalizeVariants(input) {
    if (input == null || (Array.isArray(input) && !input.length)) return null;
    if (!Array.isArray(input) || input.length < 2 || input.length > VARIANT_KEYS.length) {
        throw new CampaignError(`an A/B test needs 2 to ${VARIANT_KEYS.length} versions`);
    }
    return input.map((entry, i) => {
        const key = entry?.key ?? VARIANT_KEYS[i];
        if (key !== VARIANT_KEYS[i]) throw new CampaignError(`A/B versions must be keyed ${VARIANT_KEYS.slice(0, input.length).join(', ')} in order`);
        const body = String(entry?.body ?? '');
        if (!body.trim()) throw new CampaignError(`version ${key} needs a message`);
        if (body.length > 4096) throw new CampaignError(`version ${key} is longer than 4096 characters`);
        return { key, body };
    });
}

/** `{from, to, startTime}` for spread sending; the counters are the server's, not the client's. */
function normalizeSpread(input) {
    if (!input) return null;
    const { from, to } = input;
    if (!isDateKey(from) || !isDateKey(to)) throw new CampaignError('spread needs a start and an end date (YYYY-MM-DD)');
    if (daysBetween(from, to) < 0) throw new CampaignError('the end date must not be before the start date');
    const startTime = input.startTime ?? '09:00';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)) throw new CampaignError('spread start time must be HH:MM');
    return { from, to, startTime, cursor: Math.max(0, Math.floor(Number(input.cursor) || 0)) };
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
        // A segment campaign is saved with `audience: []`, so its size is the
        // queued count once it has started (null before: counted at start).
        audienceSize: row.segment_id == null && Array.isArray(audience) ? audience.length
            : (Array.isArray(audience?.ids) ? audience.ids.length : (parse(row.stats, {}).total || null)),
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
