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

/** Real sends by one business since `sinceIso`, across all its numbers. */
export function tenantSentSince(db, tenantId, sinceIso) {
    const marks = SUCCESS_STATUSES.map(() => '?').join(',');
    return db.prepare(
        `SELECT COUNT(*) AS n FROM messages WHERE tenant_id = ? AND status IN (${marks}) AND created_at >= ?`,
    ).get(tenantId, ...SUCCESS_STATUSES, sinceIso).n;
}

const monthStart = (at) => new Date(at.getFullYear(), at.getMonth(), 1);

/** The tightest daily / monthly allowance left, or null when neither cap is set. */
export function capRemaining(db, tenantId, rules, now = new Date()) {
    const left = [];
    if (rules.dailyCap) {
        left.push({ cap: rules.dailyCap, period: 'daily',
            left: rules.dailyCap - tenantSentSince(db, tenantId, dayStart(now).toISOString()) });
    }
    if (rules.monthlyCap) {
        left.push({ cap: rules.monthlyCap, period: 'monthly',
            left: rules.monthlyCap - tenantSentSince(db, tenantId, monthStart(now).toISOString()) });
    }
    if (!left.length) return null;
    const tightest = left.sort((a, b) => a.left - b.left)[0];
    return { ...tightest, left: Math.max(0, tightest.left) };
}

export const capReachedText = ({ period, cap }) =>
    `Your business has reached its ${period} message cap of ${cap}. Sending resumes when the cap resets.`;

/** Phones (digits) the contact book holds as not opted in. */
export function notOptedIn(db, tenantId) {
    return new Set(db.prepare("SELECT phone FROM contacts WHERE tenant_id = ? AND opt_in_status != 'opted_in'")
        .all(tenantId).map((r) => String(r.phone).replace(/\D/g, '')));
}

/** A preset no faster than the ceiling. */
export function clampPreset(preset, ceiling) {
    const max = PACING_PRESETS.indexOf(ceiling);
    const want = PACING_PRESETS.indexOf(preset);
    if (max < 0 || want <= max) return preset;
    return ceiling;
}

/**
 * One tenant's bulk/campaign rules, normalised. Where a legacy per-tenant
 * limit overlaps (maxContactsPerCampaign), the stricter of the two wins.
 */
export function bulkRules(values = {}, limits = {}) {
    const int = (v) => Math.max(0, Number(v) || 0);
    const caps = [int(values['bulk.maxRecipients']), int(limits.maxContactsPerCampaign)].filter(Boolean);
    return {
        dailyCap: int(values['bulk.dailyCap']),
        monthlyCap: int(values['bulk.monthlyCap']),
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

/** Kill switch: on at the platform default beats any override; else the tenant's own value. */
export function bulkKillReason(policyStore, tenantId) {
    if (policyStore.values('global')['bulk.killSwitch'] === true) {
        return 'Stopped: the platform has paused all bulk sending.';
    }
    if (policyStore.get(tenantId, 'bulk.killSwitch') === true) {
        return 'Stopped: bulk sending is switched off for your business.';
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
    const rules = () => bulkRules(deps.platformPolicy?.() ?? {}, state.limits?.() ?? {});
    manager.bulkPolicy = () => {
        const r = rules();
        return {
            ...r,
            capRemaining: () => capRemaining(db.db, db.tenantId, r),
            notOptedIn: r.requireOptIn ? () => notOptedIn(db.db, db.tenantId) : null,
        };
    };
    manager.killSwitch = cached(() => deps.bulkKill?.() ?? null);
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
            const live = state.campaigns?.list({ limit: 1000 }).filter((c) => ['running', 'paused'].includes(c.status)) ?? [];
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
                 FROM messages WHERE campaign_id IN (${keys.map(() => '?').join(',')}) GROUP BY campaign_id`)
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
        const store = tenant.runtimeFor(channel).state.campaigns;
        try {
            const campaign = action === 'cancel'
                ? store.cancel(row.id, 'Cancelled by the platform administrator.')
                : store[action](row.id);
            audit(req, `campaign.admin_${action}`, row.id, { tenantId: row.tenant_id });
            return res.json({ campaign });
        } catch (err) {
            if (typeof err?.status !== 'number') throw err;
            return res.status(err.status).json({ errors: [err.message] });
        }
    });

    return router;
}
