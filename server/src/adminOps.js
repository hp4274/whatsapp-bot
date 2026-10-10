/**
 * Read-only views for the platform owner's ops pages (super admin only; the
 * caller enforces that). Everything comes from existing tables plus the live
 * channel runtimes, so nothing here can change how a tenant sends.
 */

import { Channels, withinSendingWindow } from './channels.js';
import { DailyQuota, dayStart } from './campaign/safety.js';
import { DEFAULTS } from './config.js';
import { TENANT_SERVICES } from './tenancy.js';

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const stamp = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00'); // same shape as utcNow()
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const RANK = { bad: 0, warn: 1, ok: 2, off: 3 };

/** Status (latest per message) -> buckets. A READ message was also sent and delivered. */
function emptyBucket() {
    return { sent: 0, delivered: 0, read: 0, failed: 0, queued: 0, sandbox: 0, total: 0 };
}
function addTo(bucket, status, n) {
    bucket.total += n;
    if (status === 'SENT' || status === 'DELIVERED' || status === 'READ') bucket.sent += n;
    if (status === 'DELIVERED' || status === 'READ') bucket.delivered += n;
    if (status === 'READ') bucket.read += n;
    if (status === 'FAILED') bucket.failed += n;
    if (status === 'QUEUED' || status === 'SENDING') bucket.queued += n;
    if (status === 'SANDBOX') bucket.sandbox += n;
}

// Same buckets the ops page shows; server-side so filters and pagination agree.
const VERB_SQL = `CASE
    WHEN a.action LIKE 'auth.%' THEN 'other'
    WHEN a.action LIKE '%create%' OR a.action LIKE '%provision%' OR a.action LIKE '%seed%' OR a.action LIKE 'POST %' THEN 'create'
    WHEN a.action LIKE '%delete%' OR a.action LIKE '%remove%' OR a.action LIKE '%revoke%'
      OR a.action LIKE '%archived%' OR a.action LIKE 'DELETE %' THEN 'remove'
    ELSE 'change' END`;
export const AUDIT_VERBS = Object.freeze(['create', 'change', 'remove', 'other']);

export function createAdminOps({ db, tenancy, runtimes }) {
    const raw = tenancy.db;
    const countBy = (sql) => new Map(raw.prepare(sql).all().map((r) => [r.tenant_id, r.n]));

    /** Each tenant's services, plan limits, effective safety and what it uses against them. */
    const plans = () => {
        const channels = countBy('SELECT tenant_id, COUNT(*) AS n FROM whatsapp_channels GROUP BY tenant_id');
        const users = countBy('SELECT tenant_id, COUNT(*) AS n FROM users WHERE tenant_id IS NOT NULL GROUP BY tenant_id');
        const templates = countBy('SELECT tenant_id, COUNT(*) AS n FROM templates GROUP BY tenant_id');
        return {
            services: TENANT_SERVICES,
            tenants: tenancy.listTenants().map((t) => ({
                tenantId: t.id,
                name: t.name,
                slug: t.slug,
                status: t.status,
                services: t.services,
                controls: t.controls,
                limits: t.limits,
                safety: tenancy.effectiveSafety(t),
                customSafetyActive: tenancy.customSafetyActive(t),
                usage: {
                    channels: channels.get(t.id) ?? 0,
                    users: users.get(t.id) ?? 0,
                    templates: templates.get(t.id) ?? 0,
                },
            })),
        };
    };

    /** Outbound volume per tenant: today / 7d / 30d (UTC days) and a daily series. */
    const usage = ({ days = 14, now = Date.now() } = {}) => {
        const span = Math.min(Math.max(Math.floor(Number(days)) || 14, 1), 30);
        const series = Array.from({ length: span }, (_, i) => isoDay(now - (span - 1 - i) * DAY_MS));
        const today = isoDay(now);
        const since7 = isoDay(now - 6 * DAY_MS);
        const since30 = isoDay(now - 29 * DAY_MS);
        const rows = raw.prepare(`
            SELECT tenant_id, substr(created_at, 1, 10) AS day, status, message_type AS type, COUNT(*) AS n
            FROM messages WHERE direction = 'outbound' AND created_at >= ?
            GROUP BY tenant_id, day, status, type`).all(since30);
        const campaigns = countBy(`SELECT tenant_id, COUNT(DISTINCT campaign_id) AS n FROM messages
            WHERE campaign_id != '' AND created_at >= '${since30}' GROUP BY tenant_id`);
        // Media is only recorded on saved campaigns (campaigns.media_id); ad-hoc sends do not keep it.
        const media = countBy(`SELECT m.tenant_id, COUNT(*) AS n FROM campaigns c
            JOIN messages m ON m.campaign_id = 'camp-' || c.id AND m.tenant_id = c.tenant_id
            WHERE c.media_id IS NOT NULL AND c.media_id != '' AND m.created_at >= '${since30}'
            GROUP BY m.tenant_id`);

        const index = new Map(series.map((day, i) => [day, i]));
        const make = (t) => ({
            tenantId: t.id, name: t.name, slug: t.slug, status: t.status,
            today: emptyBucket(), d7: emptyBucket(), d30: emptyBucket(),
            daily: series.map(() => 0), dailyFailed: series.map(() => 0),
            byType: {}, campaigns: campaigns.get(t.id) ?? 0, autoReplies: 0, media: media.get(t.id) ?? 0,
        });
        const byTenant = new Map(tenancy.listTenants().map((t) => [t.id, make(t)]));
        const totals = { today: emptyBucket(), d7: emptyBucket(), d30: emptyBucket() };
        for (const r of rows) {
            const t = byTenant.get(r.tenant_id);
            if (!t) continue; // archived tenant
            addTo(t.d30, r.status, r.n);
            addTo(totals.d30, r.status, r.n);
            if (r.day >= since7) { addTo(t.d7, r.status, r.n); addTo(totals.d7, r.status, r.n); }
            if (r.day === today) { addTo(t.today, r.status, r.n); addTo(totals.today, r.status, r.n); }
            t.byType[r.type] = (t.byType[r.type] ?? 0) + r.n;
            const i = index.get(r.day);
            if (i !== undefined) {
                t.daily[i] += r.n;
                if (r.status === 'FAILED') t.dailyFailed[i] += r.n;
            }
        }
        const tenants = [...byTenant.values()]
            .map((t) => ({ ...t, autoReplies: t.byType.auto_reply ?? 0 }))
            .sort((a, b) => b.d30.total - a.d30.total || a.name.localeCompare(b.name));
        return { generatedAt: stamp(now), days: series, totals, tenants };
    };

    /** Every number on the platform, live state first, problems sorted to the top. */
    const health = ({ now = Date.now() } = {}) => {
        const hourAgo = stamp(now - 3_600_000);
        const stats = new Map(raw.prepare(`
            SELECT tenant_id, channel_id,
                MAX(CASE WHEN status IN ('SENT', 'DELIVERED', 'READ') THEN updated_at END) AS last_sent,
                SUM(updated_at >= ? AND status IN ('SENT', 'DELIVERED', 'READ', 'FAILED')) AS hour_total,
                SUM(updated_at >= ? AND status = 'FAILED') AS hour_failed,
                SUM(status IN ('QUEUED', 'SENDING')) AS waiting
            FROM messages WHERE direction = 'outbound' AND channel_id IS NOT NULL
            GROUP BY tenant_id, channel_id`).all(hourAgo, hourAgo)
            .map((r) => [`${r.tenant_id}:${r.channel_id}`, r]));

        const channels = [];
        for (const tenant of tenancy.listTenants()) {
            const scoped = db.forTenant(tenant.id);
            for (const ch of new Channels(scoped).list()) {
                const state = runtimes.get(tenant.id)?.runtimes.get(ch.id)?.state;
                const s = stats.get(`${tenant.id}:${ch.id}`) ?? {};
                const config = state?.config ?? { ...DEFAULTS, ...ch.settings, ...tenancy.enforcedSafety(tenant) };
                const quota = state?.manager?.quota ?? new DailyQuota(scoped.forChannel(ch.id), config);
                const budget = quota.status(new Date(now));
                const warmDays = Number(config.warmupDays) || 0;
                const first = warmDays ? quota.db.firstSentAt?.() : null;
                const age = first ? Math.max(0, Math.round((dayStart(new Date(now)) - dayStart(new Date(first))) / DAY_MS)) : 0;
                const info = state?.info ?? null;
                const waiting = Number(s.waiting ?? 0);
                const hourTotal = Number(s.hour_total ?? 0);
                const hourFailed = Number(s.hour_failed ?? 0);
                const failureRate = hourTotal ? Math.round((hourFailed / hourTotal) * 1000) / 10 : 0;
                const inWindow = withinSendingWindow(ch, new Date(now));

                let live = 'disconnected';
                if (ch.status !== 'active') live = 'disabled';
                else if (!state) live = 'idle';
                else if (info?.code === 'WHATSAPP_WEB_AUTH_FAILURE') live = 'auth_failure';
                else if (state.qr) live = 'qr';
                else if (state.connecting) live = 'connecting';
                else if (state.transport?.isConnected?.()) live = 'connected';
                else if (info?.error) live = 'error';

                const problems = [];
                const flag = (level, text) => problems.push({ level, text });
                if (tenant.status !== 'active') flag('warn', `Business is ${tenant.status}`);
                if (live === 'auth_failure') flag('bad', 'WhatsApp rejected the saved login. Scan a new QR code.');
                if (live === 'error') flag('bad', `Connection error: ${info.error || 'unknown'}`);
                if (live === 'qr') flag('warn', 'Waiting for someone to scan the QR code');
                if (live === 'disconnected') flag(waiting ? 'bad' : 'warn', 'Not connected');
                if (live === 'idle' && waiting) flag('warn', `Not running, ${waiting} waiting`);
                if (hourTotal >= 5 && failureRate >= 20) flag('bad', `${failureRate}% failed in the last hour`);
                else if (hourFailed && failureRate >= 5) flag('warn', `${failureRate}% failed in the last hour`);
                if (budget.enabled && budget.limit && budget.remaining === 0) flag('warn', 'Daily cap reached');
                if (!inWindow && waiting && ch.status === 'active') flag('warn', `Outside sending window, ${waiting} waiting`);
                const severity = live === 'disabled' ? 'off'
                    : problems.some((p) => p.level === 'bad') ? 'bad'
                        : problems.length ? 'warn' : 'ok';

                channels.push({
                    tenantId: tenant.id, tenantName: tenant.name, tenantSlug: tenant.slug, tenantStatus: tenant.status,
                    id: ch.id, displayName: ch.displayName, phoneNumber: ch.phoneNumber, provider: ch.provider,
                    status: ch.status, isDefault: ch.isDefault,
                    state: live, account: info?.account ?? '', detail: info?.detail ?? '', error: info?.error ?? null,
                    withinSendingWindow: inWindow,
                    queue: state?.manager?.queue?.pending ?? 0,
                    waiting,
                    lastSentAt: s.last_sent ?? null,
                    lastHour: { total: hourTotal, failed: hourFailed, failureRate },
                    quota: { enabled: budget.enabled, limit: budget.limit, used: budget.used, remaining: budget.remaining },
                    warmup: warmDays ? { days: warmDays, day: age + 1, active: age < warmDays, started: Boolean(first) } : null,
                    problems, severity,
                });
            }
        }
        channels.sort((a, b) => RANK[a.severity] - RANK[b.severity]
            || a.tenantName.localeCompare(b.tenantName) || a.id - b.id);
        return { generatedAt: stamp(now), channels };
    };

    /**
     * Audit search, newest first, keyset-paginated by id (`before`).
     * Filters: tenant (id or "platform"), user (id), verb, from/to (YYYY-MM-DD, inclusive), q (text).
     */
    const audit = (query = {}, { maxLimit = 1000 } = {}) => {
        const where = [];
        const args = [];
        if (query.tenant === 'platform') where.push('tenant_id IS NULL');
        else if (query.tenant) { where.push('tenant_id = ?'); args.push(Number(query.tenant)); }
        if (query.user) { where.push('user_id = ?'); args.push(Number(query.user)); }
        if (AUDIT_VERBS.includes(query.verb)) { where.push('verb = ?'); args.push(query.verb); }
        if (DATE_RE.test(query.from ?? '')) { where.push('created_at >= ?'); args.push(query.from); }
        if (DATE_RE.test(query.to ?? '')) {
            where.push('created_at < ?');
            args.push(isoDay(Date.parse(`${query.to}T00:00:00Z`) + DAY_MS));
        }
        if (Number(query.before) > 0) { where.push('id < ?'); args.push(Number(query.before)); }
        if (query.q) {
            where.push(`(action || ' ' || COALESCE(target, '') || ' ' || COALESCE(detail, '') || ' ' || COALESCE(user_email, '')) LIKE ? ESCAPE '\\'`);
            args.push(`%${String(query.q).slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`);
        }
        const limit = Math.min(Math.max(Number(query.limit) || 200, 1), maxLimit);
        const rows = raw.prepare(`
            SELECT * FROM (SELECT a.*, u.email AS user_email, ${VERB_SQL} AS verb
                           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id)
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
        const logs = rows.slice(0, limit).map((r) => ({
            id: r.id, tenantId: r.tenant_id, userId: r.user_id, userEmail: r.user_email ?? '',
            action: r.action, verb: r.verb, target: r.target ?? '', detail: r.detail ?? '', createdAt: r.created_at,
        }));
        const page = { logs, nextBefore: rows.length > limit ? logs[logs.length - 1].id : null };
        // Who appears in the log, for the user filter. First page only.
        if (!query.before) {
            page.users = raw.prepare(`SELECT DISTINCT u.id, u.email FROM audit_logs a
                JOIN users u ON u.id = a.user_id ORDER BY u.email`).all().map((u) => ({ id: u.id, email: u.email }));
        }
        return page;
    };

    return { plans, usage, health, audit };
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula get a leading quote. */
export function auditCsv(logs) {
    const cell = (v) => {
        let s = v == null ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
    };
    const head = ['id', 'createdAt', 'tenantId', 'userEmail', 'verb', 'action', 'target', 'detail'];
    return [head.join(','), ...logs.map((l) => head.map((k) => cell(l[k])).join(','))].join('\r\n');
}
