/**
 * Read-only views for the platform owner's ops pages (super admin only; the
 * caller enforces that). Everything comes from existing tables plus the live
 * channel runtimes, so nothing here can change how a tenant sends.
 */

import { Channels, withinSendingWindow } from './channels.js';
import { DailyQuota } from './campaign/safety.js';
import { DEFAULTS } from './config.js';
import { PolicyStore } from './policy/index.js';
import { pinFromRow, startFromRow } from './policy/channelOps.js';
import { applySendingPolicy } from './policy/levels.js';
import { TENANT_SERVICES } from './tenancy.js';
import { auditVerb, describeAudit, parseDetail } from './observability/auditText.js';
import { publishWarnings, recentLogs } from './observability/logBuffer.js';
import { captureConsole, currentContext } from './observability/logger.js';

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

// The ops page's Create / Change / Remove / Other buckets. One classifier (auditText.js auditVerb), registered as a
// SQL function so the filter, the pagination and the label on each row can never disagree.
const VERB_SQL = 'audit_verb(a.action)';
export const AUDIT_VERBS = Object.freeze(['create', 'change', 'remove', 'other']);
/** `…1234`: how a number without a display name is named in an audit sentence. */
const lastDigits = (s) => (String(s ?? '').replace(/\D/g, '').length >= 5 ? `…${String(s).replace(/\D/g, '').slice(-4)}` : '');

export function createAdminOps({ db, tenancy, runtimes, policy = new PolicyStore(db) }) {
    const raw = tenancy.db;
    raw.function('audit_verb', { deterministic: true }, (action) => auditVerb(action));
    // Sweeps and hooks still report through console.error ("[campaigns] … failed"); the Backend logs view
    // must show those too, not only the structured lines.
    captureConsole();
    // Audit rows written without the request at hand (sign-in, a campaign's own audit) still get the request id
    // of the request they ran in, so "show backend logs for this request" works on them too.
    tenancy.currentRequestId ??= () => currentContext().requestId ?? null;
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
        // Saved campaigns only ('camp-<id>'): quick sends and automatic messages carry other ids ('transactional', …).
        const campaigns = countBy(`SELECT tenant_id, COUNT(DISTINCT campaign_id) AS n FROM messages
            WHERE campaign_id LIKE 'camp-%' AND created_at >= '${since30}' GROUP BY tenant_id`);
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

        // Pause reason and last-seen come from policy/channelOps.js (absent until it has run).
        let ops = new Map();
        try {
            ops = new Map(raw.prepare('SELECT * FROM channel_ops').all().map((r) => [r.channel_id, r]));
        } catch { /* table not created yet */ }
        const lastIn = new Map(raw.prepare(`SELECT tenant_id, channel_id, MAX(received_at) AS at
            FROM inbound_messages WHERE channel_id IS NOT NULL GROUP BY tenant_id, channel_id`).all()
            .map((r) => [`${r.tenant_id}:${r.channel_id}`, r.at]));

        const channels = [];
        for (const tenant of tenancy.listTenants()) {
            const scoped = db.forTenant(tenant.id);
            const rules = policy.resolve(tenant.id).values;
            const offlineMs = (rules['channels.offlineAfterMinutes'] ?? 30) * 60_000;
            for (const ch of new Channels(scoped).list()) {
                const state = runtimes.get(tenant.id)?.runtimes.get(ch.id)?.state;
                const s = stats.get(`${tenant.id}:${ch.id}`) ?? {};
                const config = state?.config ?? { ...DEFAULTS, ...ch.settings, ...tenancy.enforcedSafety(tenant) };
                const op = ops.get(ch.id) ?? {};
                const pin = pinFromRow(op);
                const start = startFromRow(op);
                const quota = state?.manager?.quota ?? applySendingPolicy(new DailyQuota(scoped.forChannel(ch.id), config), rules, () => pin, () => start);
                if (!state?.manager) quota.zone = () => ch.timezone || null;
                const budget = quota.status(new Date(now));
                const lv = quota.qr ? quota.allowance(new Date(now)).level : null;
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
                const lastSeenAt = live === 'connected' ? stamp(now)
                    : [op.last_seen_at, s.last_sent, lastIn.get(`${tenant.id}:${ch.id}`)]
                        .filter(Boolean).sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
                // A loaded runtime knows the truth right now: "seen 4 min ago" on a number that just dropped is not
                // online. Last-seen is only the guess for a number whose runtime is not loaded in this process.
                // A number switched off (force disconnect, a move, a pause) is not coming back by itself, however
                // recently it was seen.
                const online = state ? live === 'connected'
                    : ch.status === 'active' && ch.settings?.autoConnect !== false
                        && Boolean(lastSeenAt) && now - Date.parse(lastSeenAt) < offlineMs;
                const pausedReason = ch.status !== 'active' ? (op.paused_reason ?? null) : null;
                if (pausedReason) flag('bad', pausedReason);
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
                    // A QR number's sending level; `pinned` is the admin's pin while it holds (null on the sandbox).
                    // `start`: the number questions as answered (`answers` { age, usage } or { skipped: true }), null if never;
                    // `asked` false while they must be answered (again, after a ban or a new number), which holds bulk.
                    level: lv && {
                        level: lv.level, earned: lv.earned, of: lv.of, pinned: lv.pinned ? pin?.level ?? null : null, cap: lv.cap ?? null,
                        // The admin's brakes-off `{ until, by, at }` while it holds, else null.
                        brakesOff: lv.brakesOff ?? null,
                        // As the business sees it: with safety off nothing is held, so nothing is asked.
                        start, asked: !budget.enabled || quota.allowance(new Date(now)).asked !== false,
                        // Waiting after a fresh link (not a ban's rest): the admin can end it (end-link-wait). ISO end, else null.
                        linkWaitUntil: (() => {
                            const al = quota.allowance(new Date(now));
                            return budget.enabled && al.level.resting?.active && !al.brakes.some((b) => b.code === 'ban')
                                ? al.level.resting.endsAt ?? null : null;
                        })(),
                        // `ready`: what history alone gives (above `earned` while the promotion gate holds it).
                        // `growth`: today's growth cap (campaign/safety.js growthFrom). `health`: the 7-day health
                        // the gate and demotion judge; `probation`: after a demotion, else null. `events`: level
                        // changes of the last 30 days (db.levelEvents; `shadow` true = logged, never applied).
                        ready: lv.ready, growth: quota.allowance(new Date(now)).growth, health: lv.health, probation: lv.probation,
                        events: scoped.forChannel(ch.id).levelEvents(stamp(now - 30 * 86_400_000)),
                    },
                    // The delivery, stuck and unstable brakes on a QR number: `mode` (sending.brakesMode), the 2-24h
                    // `delivery` window they judge, and their rows of the last 7 days (kind 'shadow' = logged, never applied).
                    brakeHealth: lv && {
                        mode: quota.tables().brakes.brakesMode,
                        delivery: quota.allowance(new Date(now)).delivery,
                        events: scoped.forChannel(ch.id).brakeEvents(stamp(now - 7 * 86_400_000)),
                    },
                    online, lastSeenAt, pausedReason,
                    pausedBy: pausedReason ? op.paused_by : null, pausedAt: pausedReason ? op.paused_at : null,
                    problems, severity,
                });
            }
        }
        channels.sort((a, b) => RANK[a.severity] - RANK[b.severity]
            || a.tenantName.localeCompare(b.tenantName) || a.id - b.id);
        return { generatedAt: stamp(now), channels };
    };

    /**
     * Names for one page of audit rows: three IN queries for the numbers, campaigns and users the rows point at
     * (tenants are few, so all of them). Archived tenants and deleted numbers still resolve: their rows stay.
     */
    const auditNames = (rows) => {
        const ids = { channel: new Set(), campaign: new Set(), user: new Set() };
        for (const r of rows) {
            const id = Number(/(\d+)$/.exec(String(r.target ?? ''))?.[1]);
            if (r.action.startsWith('channel.') && id) ids.channel.add(id);
            if (r.action === 'ops.alert') {
                const ch = Number(parseDetail(r.detail)?.channelId);
                if (ch) ids.channel.add(ch);
            }
            if (r.action.startsWith('campaign.') && id) ids.campaign.add(id);
            if (r.action.startsWith('user.') && id) ids.user.add(id);
        }
        const fetch = (sql, set) => {
            if (!set.size) return [];
            try {
                return raw.prepare(sql.replace('?', [...set].map(() => '?').join(', '))).all(...set);
            } catch {
                return []; // a table this deployment does not have yet: ids are shown instead
            }
        };
        const channels = new Map(fetch('SELECT id, display_name, phone_number, provider_account_id FROM whatsapp_channels WHERE id IN (?)', ids.channel)
            .map((c) => [c.id, c.display_name || lastDigits(c.phone_number || c.provider_account_id) || null]));
        const campaigns = new Map(fetch('SELECT id, name FROM campaigns WHERE id IN (?)', ids.campaign).map((c) => [c.id, c.name]));
        const users = new Map(fetch('SELECT id, name, email FROM users WHERE id IN (?)', ids.user)
            .map((u) => [u.id, { name: u.name, email: String(u.email).replace(/#deleted-\d+$/, '') }]));
        const tenants = new Map(raw.prepare('SELECT id, name FROM tenants').all().map((t) => [t.id, t.name]));
        return {
            tenant: (id) => tenants.get(Number(id)) ?? null,
            channel: (id) => channels.get(Number(id)) ?? null,
            campaign: (id) => campaigns.get(Number(id)) ?? null,
            user: (id) => users.get(Number(id)) ?? null,
        };
    };

    /**
     * Audit search, newest first, keyset-paginated by id (`before`).
     * Filters: tenant (id or "platform"), user (id), verb, from/to (YYYY-MM-DD, inclusive), q (text), requestId.
     * `after` (an id) returns only newer rows, so a live page can prepend them without reloading what it shows.
     * Each row carries the raw record plus `summary`, `severity`, `category` and `actor` (auditText.js).
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
        if (Number(query.after) > 0) { where.push('id > ?'); args.push(Number(query.after)); }
        if (query.requestId) { where.push('request_id = ?'); args.push(String(query.requestId).slice(0, 128)); }
        if (query.q) {
            where.push(`(action || ' ' || COALESCE(target, '') || ' ' || COALESCE(detail, '') || ' ' || COALESCE(user_email, '')
                || ' ' || COALESCE(user_name, '') || ' ' || COALESCE(tenant_name, '') || ' ' || COALESCE(ip, '')) LIKE ? ESCAPE '\\'`);
            args.push(`%${String(query.q).slice(0, 200).replace(/[\\%_]/g, '\\$&')}%`);
        }
        const limit = Math.min(Math.max(Number(query.limit) || 200, 1), maxLimit);
        const rows = raw.prepare(`
            SELECT * FROM (SELECT a.*, u.email AS user_email, u.name AS user_name, u.role AS user_role,
                                  t.name AS tenant_name, ${VERB_SQL} AS verb
                           FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN tenants t ON t.id = a.tenant_id)
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
            ORDER BY id DESC LIMIT ?`).all(...args, limit + 1);
        const shown = rows.slice(0, limit);
        const names = auditNames(shown);
        const logs = shown.map((r) => {
            const detail = r.detail ?? '';
            const ip = r.ip ?? parseDetail(detail)?.ip ?? null;
            const text = describeAudit({ action: r.action, target: r.target, detail, tenantId: r.tenant_id, ip }, names);
            return {
                id: r.id, tenantId: r.tenant_id, tenantName: r.tenant_name ?? null,
                userId: r.user_id, userEmail: r.user_email ?? '',
                actor: r.user_id && r.user_email ? { name: r.user_name ?? '', email: r.user_email, role: r.user_role ?? '' } : 'System',
                action: r.action, verb: r.verb, target: r.target ?? '', detail,
                summary: text.summary, severity: text.severity, category: text.category,
                ip: typeof ip === 'string' ? ip : null, requestId: r.request_id ?? null, createdAt: r.created_at,
            };
        });
        const page = { logs, nextBefore: rows.length > limit ? logs[logs.length - 1].id : null };
        // Who appears in the log, for the user filter. First page only.
        if (!query.before) {
            page.users = raw.prepare(`SELECT DISTINCT u.id, u.email FROM audit_logs a
                JOIN users u ON u.id = a.user_id ORDER BY u.email`).all().map((u) => ({ id: u.id, email: u.email }));
        }
        return page;
    };

    /**
     * What shadow mode (sending.brakesMode 'shadow') logged in the last `days`, every number at once: one row per
     * number and kind, with how many times it fired and, for a brake, the hours it would have paused (its rows' ends,
     * message_id, minus their start). Level rows (`level:<reason>`) have no pause. Read before flipping to 'enforce'.
     */
    const shadowReview = ({ days = 7, now = Date.now() } = {}) => {
        const span = Math.min(30, Math.max(1, Number(days) || 7));
        const rows = raw.prepare(
            `SELECT e.tenant_id, e.channel_id, e.phone AS code, e.message_id, e.at, t.name AS tenant_name,
                    c.display_name, c.provider_account_id
             FROM safety_events e LEFT JOIN tenants t ON t.id = e.tenant_id LEFT JOIN whatsapp_channels c ON c.id = e.channel_id
             WHERE e.kind = 'shadow' AND e.at >= ? ORDER BY e.at`,
        ).all(stamp(now - span * DAY_MS));
        const groups = new Map();
        for (const r of rows) {
            const key = `${r.channel_id}|${r.code}`;
            const g = groups.get(key) ?? {
                tenantId: r.tenant_id, tenantName: r.tenant_name ?? '', channelId: r.channel_id,
                number: r.display_name || r.provider_account_id || `#${r.channel_id}`, kind: r.code, count: 0, pauseHours: 0, lastAt: r.at,
            };
            const until = r.code.startsWith('level:') ? NaN : Date.parse(r.message_id);
            g.count += 1;
            if (until > Date.parse(r.at)) g.pauseHours += (until - Date.parse(r.at)) / 3_600_000;
            g.lastAt = r.at;
            groups.set(key, g);
        }
        const out = [...groups.values()].map((g) => ({ ...g, pauseHours: Math.round(g.pauseHours) }))
            .sort((a, b) => b.pauseHours - a.pauseHours || b.count - a.count);
        return { days: span, generatedAt: stamp(now), rows: out };
    };

    /** Recent backend log lines, newest first (observability/logBuffer.js); already redacted when written. */
    const logs = (query = {}) => recentLogs(query);
    /** Topic `logs` on the admin feed after warn/error lines; returns the stop function. */
    const feedLogs = (feed) => publishWarnings(feed, 'logs');

    return { plans, usage, health, audit, shadowReview, logs, feedLogs };
}

/** RFC 4180 CSV. Cells that a spreadsheet would run as a formula get a leading quote. */
export function auditCsv(logs) {
    const cell = (v) => {
        let s = v == null ? '' : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
        return `"${s.replace(/"/g, '""')}"`;
    };
    // The sentence first, for the person reading the sheet; the raw record after it, for the one checking it.
    const head = ['id', 'createdAt', 'tenantId', 'tenantName', 'userEmail', 'summary', 'severity', 'verb', 'action', 'target',
        'ip', 'requestId', 'detail'];
    const title = { summary: 'Summary' };
    return [head.map((k) => title[k] ?? k).join(','), ...logs.map((l) => head.map((k) => cell(l[k])).join(','))].join('\r\n');
}
