/**
 * Campaign records (Phase 13).
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

import { utcNow } from '../protocol.js';

export const CAMPAIGN_STATUSES = Object.freeze([
    'draft', 'scheduled', 'running', 'paused', 'done', 'cancelled',
]);

/** Statuses after which nothing more will be sent. */
const FINAL = Object.freeze(['done', 'cancelled']);

/** The queue depth a campaign still has in flight, by message status. */
const OPEN_STATUSES = Object.freeze(['QUEUED', 'SENDING']);

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
     */
    constructor(database, { contacts, templates = null, manager = null, now = null } = {}) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? null;
        this.counts = (campaignKey) => database.countsByStatus(campaignKey, database.channelId);
        this.contacts = contacts;
        this.templates = templates;
        this.manager = manager;
        this.now = now ? () => iso(now()) : utcNow;
    }

    // --------------------------------------------------------------- CRUD --
    create({
        name, status = 'draft', templateId = null, body = '', segmentId = null,
        audience = null, mediaId = null, scheduledAt = null, channelId,
    } = {}) {
        const clean = String(name ?? '').trim();
        if (!clean) throw new CampaignError('a campaign needs a name');
        const wanted = pickStatus(status, 'draft');
        if (!['draft', 'scheduled'].includes(wanted)) {
            throw new CampaignError('a new campaign is draft or scheduled; start it to run it');
        }
        if (wanted === 'scheduled' && !scheduledAt) throw new CampaignError('a scheduled campaign needs scheduled_at');
        const now = this.now();
        const info = this.db.prepare(
            `INSERT INTO campaigns (tenant_id, channel_id, name, status, template_id, body, segment_id,
                                    audience, media_id, scheduled_at, stats, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`)
            .run(this.tenantId, channelId === undefined ? this.channelId : nullableInt(channelId),
                clean, wanted, nullableInt(templateId), String(body ?? ''), nullableInt(segmentId),
                JSON.stringify(audience ?? null), mediaId == null ? null : String(mediaId),
                scheduledAt ? iso(scheduledAt) : null, now, now);
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
        };
        if (!next.name) throw new CampaignError('a campaign needs a name');
        if (!['draft', 'scheduled'].includes(next.status)) {
            throw new CampaignError('use start/pause/resume/cancel to change a running campaign', 409);
        }
        if (next.status === 'scheduled' && !next.scheduledAt) {
            throw new CampaignError('a scheduled campaign needs scheduled_at');
        }
        this.db.prepare(
            `UPDATE campaigns SET name = ?, status = ?, template_id = ?, body = ?, segment_id = ?,
                                  audience = ?, media_id = ?, scheduled_at = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(next.name, next.status, next.templateId, next.body, next.segmentId,
                JSON.stringify(next.audience ?? null), next.mediaId, next.scheduledAt, this.now(),
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
        return rows.map(toCampaign);
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
        if (audience && typeof audience === 'object') {
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
        const text = this.messageText(campaign);
        const recipients = this.resolveAudience(campaign);
        if (!recipients.length) throw new CampaignError('that audience is empty');
        if (!this.manager) throw new CampaignError('no campaign manager is configured', 500);

        this.manager.resetStats();
        this.manager.queue.reset();
        this.manager.pausedByQuota = false;
        const result = this.manager.enqueueContacts(recipients, text, {
            campaignId: campaignKey(campaign.id), onePerNumber, media,
        });
        this.manager.start();
        this.#set(campaign.id, { status: 'running', started_at: this.now(), finished_at: null });
        return { campaign: this.get(campaign.id), audience: recipients.length, ...result };
    }

    pause(id) {
        const campaign = this.require(id);
        if (campaign.status !== 'running') throw new CampaignError(`a ${campaign.status} campaign cannot be paused`, 409);
        this.manager?.pause();
        return this.#set(campaign.id, { status: 'paused' });
    }

    resume(id) {
        const campaign = this.require(id);
        if (campaign.status !== 'paused') throw new CampaignError(`a ${campaign.status} campaign cannot be resumed`, 409);
        // The manager refuses when today's budget is spent; that is its call.
        if (this.manager && this.manager.resume() === false) {
            throw new CampaignError(`daily limit of ${this.manager.quota.limit} reached - resume after midnight`, 409);
        }
        return this.#set(campaign.id, { status: 'running' });
    }

    cancel(id) {
        const campaign = this.require(id);
        if (FINAL.includes(campaign.status)) return campaign;
        const dropped = this.manager?.stop() ?? 0;
        return this.#set(campaign.id, { status: 'cancelled', finished_at: this.now(), dropped });
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

    /**
     * Scheduled campaigns whose time has come. Nothing here sets a timer: a
     * scheduler job calls this and then `start`, exactly as workflow runs do.
     */
    due(now = this.now()) {
        return this.db.prepare(
            `SELECT * FROM campaigns WHERE tenant_id = ? AND status = 'scheduled' AND scheduled_at <= ?
             ORDER BY scheduled_at`).all(this.tenantId, iso(now)).map(toCampaign);
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

const pickStatus = (value, fallback) => (CAMPAIGN_STATUSES.includes(value) ? value : fallback);
const nullableInt = (value) => (value == null || value === '' ? null : Number(value));
const toRecipient = (contact) => ({ name: contact.name, phone: contact.phone, extra: contact.customFields ?? {} });

function toCampaign(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        channelId: row.channel_id,
        name: row.name,
        status: row.status,
        templateId: row.template_id,
        body: row.body ?? '',
        segmentId: row.segment_id,
        audience: parse(row.audience, null),
        mediaId: row.media_id,
        scheduledAt: row.scheduled_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        stats: parse(row.stats, {}),
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
