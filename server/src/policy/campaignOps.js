/**
 * Enforcement of the `bulk.*` and `campaigns.*` platform rules.
 *
 * The rules themselves are fields (bulk.js, campaigns.js); this file turns a
 * tenant's effective values into the hooks `CampaignManager` and
 * `CampaignStore` call, plus the super-admin campaign endpoints and the
 * retention sweep. Nothing here sends: every check lands in the one queue the
 * manager already owns.
 *
 * Time zones: no phone -> country -> zone helper exists in this code base, so
 * the sending window is read in the channel's time zone (the business's), not
 * the recipient's. ponytail: per-recipient zones need a dialling-code table.
 */

import express from 'express';

import { withinSendingWindow } from '../channels.js';
import { PACING_PRESETS, dayEnd, dayStart } from '../campaign/safety.js';
/** Same as campaigns/store.js campaignKey; local so the two modules do not import each other. */
const campaignKey = (id) => `camp-${Number(id)}`;
import { SUCCESS_STATUSES } from '../protocol.js';
import { applySendingPolicy } from './levels.js';

/** Real sends by one business since `sinceIso`, across all its numbers. */
export function tenantSentSince(db, tenantId, sinceIso) {
    const marks = SUCCESS_STATUSES.map(() => '?').join(',');
    return db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND status IN (${marks}) AND COALESCE(sent_at, created_at) >= ?`,
    ).get(tenantId, ...SUCCESS_STATUSES, sinceIso).n;
}

/** The UTC month, so the monthly cap resets with the billing period (billing/store.js periodOf). */
const monthStart = (at) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));

/** The tightest daily / monthly allowance left, or null when neither cap is set. */
export function capRemaining(db, tenantId, rules, now = new Date(), zone = null) {
    // An ended subscription (billing/store.js limitFor) has no allowance at all, whatever was sent.
    if (rules.expired) return { cap: 0, period: 'monthly', left: 0, expired: true };
    const left = [];
    if (rules.dailyCap) {
        left.push({ cap: rules.dailyCap, period: 'daily',
            left: rules.dailyCap - tenantSentSince(db, tenantId, dayStart(now, zone).toISOString()) });
    }
    if (rules.monthlyCap || rules.quotaBlocked) {
        left.push({ cap: rules.monthlyCap, period: 'monthly',
            left: rules.monthlyCap - tenantSentSince(db, tenantId, monthStart(now).toISOString()) });
    }
    if (!left.length) return null;
    const tightest = left.sort((a, b) => a.left - b.left)[0];
    return { ...tightest, left: Math.max(0, tightest.left) };
}

/** Why a campaign is held at the cap. It resumes by itself (manager #pastQuotaPause) once there is room again. */
export const capReachedText = ({ period, cap, expired }) => (expired
    ? 'Your subscription has ended, so sending is paused. It resumes once the subscription is renewed.'
    : `Your business has reached its ${period} message cap of ${cap}. Sending resumes when the cap resets.`);

/** Why a single message is refused or dropped at the cap: unlike a held campaign, it never goes. */
export const capRefusedText = ({ period, cap, expired }) => (expired
    ? 'Not sent: your subscription has ended. Contact your provider to renew.'
    : `Not sent: your business has reached its ${period} message cap of ${cap}. Send it again after the cap resets.`);

/** Phones (digits) the contact book holds as not opted in. */
export function notOptedIn(db, tenantId) {
    return new Set(db.prepare("SELECT phone FROM contacts WHERE tenant_id = ? AND opt_in_status != 'opted_in'")
        .all(tenantId).map((r) => String(r.phone).replace(/\D/g, '')));
}

/**
 * One tenant's bulk/campaign rules, normalised. Where a legacy per-tenant
 * limit overlaps (maxContactsPerCampaign), the stricter of the two wins; so
 * does the plan's message quota (`billingCap`, null = none) over bulk.monthlyCap.
 * bulk.monthlyCap 0 means no cap; a plan quota of 0 means none allowed (`quotaBlocked`).
 */
export function bulkRules(values = {}, limits = {}, billingCap = null) {
    const int = (v) => Math.max(0, Number(v) || 0);
    const caps = [int(values['bulk.maxRecipients']), int(limits.maxContactsPerCampaign)].filter(Boolean);
    const quota = billingCap == null ? null : int(billingCap);
    const monthly = [int(values['bulk.monthlyCap']), quota ?? 0].filter(Boolean);
    return {
        dailyCap: int(values['bulk.dailyCap']),
        monthlyCap: quota !== 0 && monthly.length ? Math.min(...monthly) : 0,
        quotaBlocked: quota === 0,
        maxRecipients: caps.length ? Math.min(...caps) : 0,
        requireOptIn: values['bulk.requireOptIn'] !== false,
        maxSpeed: PACING_PRESETS.includes(values['bulk.maxSpeed']) ? values['bulk.maxSpeed'] : 'fast',
        windowEnabled: values['bulk.windowEnabled'] === true,
        windowStart: values['bulk.windowStart'] || '09:00',
        windowEnd: values['bulk.windowEnd'] || '21:00',
        autoPauseFailurePct: int(values['campaigns.autoPauseFailurePct']),
        allowInteractive: values['campaigns.allowInteractive'] !== false,
    };
}

/**
 * Kill switch: on at the platform default beats any override; else the tenant's own value.
 * The admin's tenant controls (sendingEnabled, campaignsEnabled) stop bulk the same way.
 */
export function bulkKillReason(policyStore, tenantId, controls = {}) {
    if (policyStore.values('global')['bulk.killSwitch'] === true) {
        return 'Stopped: the platform has paused all bulk sending.';
    }
    if (policyStore.get(tenantId, 'bulk.killSwitch') === true) {
        return 'Stopped: bulk sending is switched off for your business.';
    }
    const off = sendBlockReason(controls, 'campaign');
    return off ? `Stopped: ${off.charAt(0).toLowerCase()}${off.slice(1)}` : null;
}

/** Traffic the automations control covers. */
const AUTOMATED_TYPES = new Set(['auto_reply', 'workflow']);

/** Why a tenant control (tenants.controls) refuses a send of `messageType` now, or null. */
export function sendBlockReason(controls = {}, messageType) {
    if (controls?.sendingEnabled === false) return 'Sending is switched off for your business.';
    if (messageType === 'campaign' && controls.campaignsEnabled === false) {
        return 'Campaign sending is switched off for your business.';
    }
    if (AUTOMATED_TYPES.has(messageType) && controls.automationsEnabled === false) {
        return 'Automations are switched off for your business.';
    }
    return null;
}

/** Re-read at most once a second: the worker polls this while it sleeps. */
function cached(fn, ms = 1000) {
    let at = 0;
    let value;
    return () => {
        if (Date.now() - at > ms) {
            value = fn();
            at = Date.now();
        }
        return value;
    };
}

/** Wire one channel's manager to its tenant's rules. Called once per channel runtime. */
export function attachCampaignPolicy(state, deps) {
    const { manager, db } = state;
    // Past grace nothing goes: limitFor is 0 then, and `expired` makes capRemaining say why instead of "a cap of 0".
    const expired = () => state.billing?.subscription()?.state === 'expired';
    const rules = () => ({
        ...bulkRules(deps.platformPolicy?.() ?? {}, state.limits?.() ?? {}, state.billing?.limitFor('messages') ?? null),
        expired: expired(),
    });
    manager.bulkPolicy = () => {
        const r = rules();
        return {
            ...r,
            capRemaining: () => capRemaining(db.db, db.tenantId, r, new Date(), state.channel?.timezone || null),
            notOptedIn: r.requireOptIn ? () => notOptedIn(db.db, db.tenantId) : null,
        };
    };
    manager.killSwitch = cached(() => deps.bulkKill?.() ?? null);
    // The plan's message quota refuses every new send; bulk.monthlyCap stays campaign-only (#capBlocked).
    const quotaLeft = () => {
        const limit = state.billing?.limitFor('messages');
        return limit == null ? null
            : capRemaining(db.db, db.tenantId, { monthlyCap: limit, quotaBlocked: limit === 0, expired: expired() });
    };
    const monthly = cached(quotaLeft);
    // `fresh`: the worker re-checks each row as it goes out, so a fan-out accepted under a stale count stops at the quota.
    // A refused or dropped message is never sent later, so the text says so (capRefusedText), unlike a held campaign's.
    manager.capBlock = (fresh = false) => {
        const cap = fresh ? quotaLeft() : monthly();
        return cap && cap.left <= 0 ? capRefusedText(cap) : null;
    };
    // Queued replies, workflow steps and reminders wait while their control is off (campaigns stop above).
    const controls = cached(() => deps.controls?.() ?? {});
    manager.sendBlock = (messageType) => sendBlockReason(controls(), messageType);
    // The anti-ban tables (sending levels, brakes), this number's admin level pin and its answered questions.
    applySendingPolicy(manager.quota, () => deps.platformPolicy?.(), () => deps.channelPin?.(state.channel?.id),
        deps.channelStart && (() => deps.channelStart(state.channel?.id)));
    manager.policyWindowOpen = (at = new Date()) => {
        const r = rules();
        if (!r.windowEnabled) return true;
        return withinSendingWindow({
            timezone: state.channel?.timezone || 'UTC',
            businessHours: { start: r.windowStart, end: r.windowEnd },
        }, at);
    };
}

// ------------------------------------------------------------ campaigns --

/**
 * campaigns.* checks for a create/update/start, or null. `campaign` is the
 * record as it will be saved; `counts` gives the tenant's campaigns by status.
 */
export function campaignRefusal(values, campaign, counts, { starting = false } = {}) {
    const v = values ?? {};
    const audience = campaign.audience;
    if (v['campaigns.allowFollowUps'] === false && audience && typeof audience === 'object' && audience.retarget) {
        return { status: 403, message: 'Follow-up campaigns are not on your plan.' };
    }
    if (v['campaigns.allowInteractive'] === false && campaign.options?.interactive) {
        return { status: 403, message: 'Interactive buttons are not on your plan.' };
    }
    if (!starting && campaign.status === 'scheduled') {
        if (v['campaigns.allowScheduling'] === false) {
            return { status: 403, message: 'Scheduling campaigns is not on your plan.' };
        }
        const max = Number(v['campaigns.maxScheduled']) || 0;
        if (max && counts('scheduled') >= max) {
            return { status: 409, message: `Your plan allows ${max} scheduled campaigns at once. Start or cancel one first.` };
        }
    }
    if (starting) {
        const max = Number(v['campaigns.maxRunning']) || 0;
        if (max && counts('running') >= max) {
            return { status: 409, message: `Your plan allows ${max} campaigns running at once. Wait for one to finish.` };
        }
    }
    return null;
}

/**
 * Retention: finished campaigns (and their message rows) older than
 * campaigns.retentionDays, per tenant. Runs from the app sweep; throttled
 * because the sweep ticks every few seconds and days are long.
 */
let lastRetention = 0;
export function retentionSweep(db, policyStore, { now = new Date(), force = false } = {}) {
    if (!force && Date.now() - lastRetention < 3600_000) return 0;
    lastRetention = Date.now();
    let removed = 0;
    const tenants = db.db.prepare("SELECT DISTINCT tenant_id FROM campaigns WHERE status IN ('done', 'cancelled')").all();
    for (const { tenant_id: tenantId } of tenants) {
        const days = Number(policyStore.get(tenantId, 'campaigns.retentionDays')) || 0;
        if (!days) continue;
        const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '+00:00');
        const old = db.db.prepare(
            `SELECT id FROM campaigns WHERE tenant_id = ? AND status IN ('done', 'cancelled')
               AND COALESCE(finished_at, updated_at) < ?`).all(tenantId, cutoff);
        for (const { id } of old) {
            db.db.prepare('DELETE FROM messages WHERE tenant_id = ? AND campaign_id = ?').run(tenantId, campaignKey(id));
            db.db.prepare('DELETE FROM campaigns WHERE id = ? AND tenant_id = ?').run(id, tenantId);
            removed += 1;
        }
    }
    return removed;
}

// ---------------------------------------------------------------- admin --

/**
 * Super-admin endpoints, mounted on the admin router:
 *   GET  /campaigns?status=        every tenant's campaigns
 *   POST /campaigns/:id/:action    pause | resume | cancel (audited)
 *   POST /bulk/stop-all            stop every running bulk send now (audited)
 *   POST /tenants/:id/bulk/stop    stop one tenant's (audited)
 */
export function createCampaignOpsRouter({ db, runtimes, runtimeFor, tenancy, policyStore, audit }) {
    const router = express.Router();

    /** Stop every live bulk run of one tenant runtime; returns messages dropped and campaigns cancelled. */
    const stopTenant = (runtime, reason) => {
        let dropped = 0;
        let cancelled = 0;
        for (const { state } of runtime.runtimes.values()) {
            // The list is the whole tenant's; each number cancels only the runs it sends.
            const live = state.campaigns?.list({ limit: 1000 })
                .filter((c) => ['running', 'paused'].includes(c.status) && state.campaigns.owns(c)) ?? [];
            for (const c of live) {
                state.campaigns.cancel(c.id, reason);
                cancelled += 1;
            }
            dropped += state.manager.stop(reason);
        }
        return { dropped, cancelled };
    };
    const sum = (list) => list.reduce((a, b) => ({ dropped: a.dropped + b.dropped, cancelled: a.cancelled + b.cancelled }),
        { dropped: 0, cancelled: 0 });

    router.post('/bulk/stop-all', (req, res) => {
        const result = sum([...runtimes.values()].map((r) => stopTenant(r, 'Stopped by the platform administrator.')));
        audit(req, 'bulk.stop_all', 'platform', result);
        res.json({ ...result, killSwitch: policyStore.values('global')['bulk.killSwitch'] === true });
    });

    router.post('/tenants/:id/bulk/stop', (req, res) => {
        const tenant = tenancy.getTenant(Number(req.params.id));
        if (!tenant) return res.status(404).json({ errors: ['tenant not found'] });
        req.tenantId = tenant.id;
        const runtime = runtimes.get(tenant.id);
        const result = runtime ? stopTenant(runtime, 'Stopped by the platform administrator.') : { dropped: 0, cancelled: 0 };
        audit(req, 'bulk.stop', tenant.id, result);
        return res.json(result);
    });

    router.get('/campaigns', (req, res) => {
        const status = req.query.status && req.query.status !== 'all' ? String(req.query.status) : null;
        const rows = db.db.prepare(
            `SELECT c.id, c.tenant_id, t.name AS tenant_name, c.name, c.status, c.started_at, c.finished_at,
                    c.scheduled_at, c.options
             FROM campaigns c LEFT JOIN tenants t ON t.id = c.tenant_id
             ${status ? 'WHERE c.status = ?' : ''} ORDER BY c.id DESC LIMIT 500`).all(...(status ? [status] : []));
        const marks = SUCCESS_STATUSES.map(() => '?').join(',');
        const tally = new Map();
        if (rows.length) {
            const keys = rows.map((r) => campaignKey(r.id));
            for (const t of db.db.prepare(
                `SELECT campaign_id, COUNT(*) AS total, SUM(status = 'FAILED') AS failed,
                        SUM(status IN (${marks}, 'SANDBOX')) AS sent
                 FROM messages m WHERE campaign_id IN (${keys.map(() => '?').join(',')})
                   -- A failure a retry followed up is not a failure any more (campaigns/store.js stats).
                   AND NOT (status = 'FAILED' AND EXISTS (SELECT 1 FROM messages x WHERE x.tenant_id = m.tenant_id
                       AND x.campaign_id = m.campaign_id AND x.recipient = m.recipient AND x.rowid > m.rowid))
                 GROUP BY campaign_id`)
                .all(...SUCCESS_STATUSES, ...keys)) tally.set(t.campaign_id, t);
        }
        res.json({
            killSwitch: policyStore.values('global')['bulk.killSwitch'] === true,
            campaigns: rows.map((r) => {
                const t = tally.get(campaignKey(r.id)) ?? { total: 0, failed: 0, sent: 0 };
                const done = Number(t.sent) + Number(t.failed);
                let reason = null;
                try { reason = JSON.parse(r.options || '{}').statusReason ?? null; } catch { /* bad row */ }
                return {
                    id: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name ?? `Tenant ${r.tenant_id}`,
                    name: r.name, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at,
                    scheduledAt: r.scheduled_at, total: Number(t.total), sent: Number(t.sent), failed: Number(t.failed),
                    failureRate: done ? Math.round((Number(t.failed) / done) * 1000) / 10 : 0,
                    statusReason: reason,
                };
            }),
        });
    });

    router.post('/campaigns/:id/:action', (req, res) => {
        const { action } = req.params;
        if (!['pause', 'resume', 'cancel'].includes(action)) return res.status(404).json({ errors: [`unknown action: ${action}`] });
        const row = db.db.prepare('SELECT id, tenant_id, channel_id FROM campaigns WHERE id = ?').get(Number(req.params.id));
        if (!row) return res.status(404).json({ errors: ['campaign not found'] });
        req.tenantId = row.tenant_id;
        const tenant = runtimeFor(row.tenant_id);
        const channel = (row.channel_id != null && tenant.channels.get?.(row.channel_id)) || tenant.channels.getDefault();
        if (!channel) return res.status(409).json({ errors: ['that business has no number to run the campaign on'] });
        const { state } = tenant.runtimeFor(channel);
        const store = state.campaigns;
        try {
            // The store acts on the manager only when it holds this run, so another campaign on the number is untouched.
            const campaign = {
                pause: () => store.pause(row.id, 'Paused by the platform admin.'),
                resume: () => store.resume(row.id),
                cancel: () => store.cancel(row.id, 'Cancelled by the platform administrator.'),
            }[action]();
            audit(req, `campaign.admin_${action}`, row.id, { tenantId: row.tenant_id, name: campaign.name });
            // The business's open pages hear it too, not only the admin's.
            state.broadcast?.({ type: { pause: 'campaignPaused', resume: 'campaignResumed', cancel: 'campaignCancelled' }[action], campaign });
            if (action === 'cancel') state.broadcast?.({ type: 'historyDirty' });
            return res.json({ campaign });
        } catch (err) {
            if (typeof err?.status !== 'number') throw err;
            return res.status(err.status).json({ errors: [err.message] });
        }
    });

    return router;
}
