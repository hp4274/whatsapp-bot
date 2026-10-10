/**
 * Analytics over one channel's message history: the numbers behind the
 * Analytics page, computed with a handful of GROUP BY queries rather than
 * shipping thousands of rows to the browser.
 *
 * Every query is pinned to the handle's tenant and, when the handle is
 * channel-scoped, to that channel - analytics is per WhatsApp number, the
 * same way the rest of the app is.  Date filters sit on the indexed
 * `messages.created_at` / `inbound_messages.received_at` columns.  Both are
 * written by `utcNow()` (ISO-8601, UTC), so string comparison is time order
 * and `substr(..., 1, 10)` is the UTC calendar day.
 *
 * Definitions (outbound messages only):
 *   total      every outbound row created in the range, whatever its status
 *   attempted  everything that left the queue: status NOT IN (QUEUED, SENDING)
 *   sent       attempted and not FAILED: SENT + DELIVERED + READ + SANDBOX
 *   delivered  DELIVERED + READ (a read receipt implies delivery)
 *   read       READ
 *   failed     FAILED
 *   deliveryRate = delivered / attempted   (failures count against it)
 *   readRate     = read / delivered        (WhatsApp's own definition)
 *   failureRate  = failed / attempted
 * Rates are percentages to one decimal, or null when the denominator is 0.
 *
 * Response time: a "conversation" is one sender number that wrote in during
 * the range.  Its first response time is from that sender's first inbound
 * message in the range to the first outbound message to the same number at or
 * after it.  Broadcasts (campaign, reminder) and FAILED sends are not
 * responses; auto-replies, workflow sends and agent replies are.
 * within5m / within1h are shares of ALL conversations, so an unanswered
 * conversation counts against them.  p90 uses the nearest-rank method.
 */

export const ALLOWED_DAYS = Object.freeze([7, 30, 90]);
export const DEFAULT_DAYS = 30;

const PENDING = new Set(['QUEUED', 'SENDING']);
const STATUSES = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SANDBOX'];
/** Outbound types that go out on a schedule rather than in answer to someone. */
const BROADCAST_TYPES = ['campaign', 'reminder'];
const AUTO_REPLY_TYPE = 'auto_reply';
const TOP_RULES = 8;

/** Response-time histogram edges, in seconds (upper bound inclusive). */
const BUCKETS = [
    { key: 'lt1m', label: '< 1 min', max: 60 },
    { key: '1to5m', label: '1–5 min', max: 300 },
    { key: '5to15m', label: '5–15 min', max: 900 },
    { key: '15to60m', label: '15–60 min', max: 3600 },
    { key: '1to4h', label: '1–4 h', max: 4 * 3600 },
    { key: '4to24h', label: '4–24 h', max: 86400 },
    { key: 'gt24h', label: '> 24 h', max: Infinity },
];

export class AnalyticsError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** `undefined`/'' means the default; anything else must be one of ALLOWED_DAYS. */
export function parseDays(value) {
    if (value === undefined || value === null || value === '') return DEFAULT_DAYS;
    const days = Number(value);
    if (!ALLOWED_DAYS.includes(days)) {
        throw new AnalyticsError(`days must be one of ${ALLOWED_DAYS.join(', ')}`);
    }
    return days;
}

const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, '+00:00');
const rate = (n, of) => (of > 0 ? Math.round((n / of) * 1000) / 10 : null);

/** The UTC day keys from `since` through `now`, inclusive. */
function dayKeys(days, now) {
    const keys = [];
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86400000;
    for (let i = 0; i < days; i += 1) keys.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
    return keys;
}

function emptyCounts() {
    return { total: 0, attempted: 0, sent: 0, delivered: 0, read: 0, failed: 0, sandbox: 0, pending: 0 };
}

/** Fold `n` messages of `status` into a counts object. */
function add(counts, status, n) {
    counts.total += n;
    if (PENDING.has(status)) {
        counts.pending += n;
        return;
    }
    counts.attempted += n;
    if (status === 'FAILED') counts.failed += n;
    else counts.sent += n;
    if (status === 'DELIVERED' || status === 'READ') counts.delivered += n;
    if (status === 'READ') counts.read += n;
    if (status === 'SANDBOX') counts.sandbox += n;
}

function withRates(counts) {
    return {
        ...counts,
        deliveryRate: rate(counts.delivered, counts.attempted),
        readRate: rate(counts.read, counts.delivered),
        failureRate: rate(counts.failed, counts.attempted),
    };
}

/** Nearest-rank percentile over an ascending array. */
export function percentile(sorted, p) {
    if (!sorted.length) return null;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

export function median(sorted) {
    if (!sorted.length) return null;
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** `camp-12` is a campaign record; anything else is a legacy run id. */
const recordIdOf = (campaignId) => {
    const m = /^camp-(\d+)$/.exec(campaignId);
    return m ? Number(m[1]) : null;
};

function legacyName(campaignId) {
    if (campaignId === 'single') return 'Single sends';
    return `Run ${campaignId}`;
}

export class AnalyticsStore {
    /** @param {import('../db.js').Database} database a tenant- or channel-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? null;
    }

    /** `AND <col> = ?` plus its args, or nothing on an unscoped handle. */
    #scope(alias = '') {
        const col = `${alias}channel_id`;
        return this.channelId == null
            ? { sql: '', args: [] }
            : { sql: ` AND ${col} = ?`, args: [this.channelId] };
    }

    overview({ days = DEFAULT_DAYS, now = new Date() } = {}) {
        const keys = dayKeys(days, now);
        const since = `${keys[0]}T00:00:00+00:00`;
        const scope = this.#scope();

        // 1. Status x day x type: totals, the daily series and auto-reply hits.
        const rows = this.db.prepare(
            `SELECT substr(created_at, 1, 10) AS day, status, message_type AS type, COUNT(*) AS n
             FROM messages
             WHERE tenant_id = ?${scope.sql} AND direction = 'outbound' AND created_at >= ?
             GROUP BY day, status, type`,
        ).all(this.tenantId, ...scope.args, since);

        const totals = emptyCounts();
        const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
        const byType = {};
        const daily = new Map(keys.map((k) => [k, emptyCounts()]));
        let autoReplyMessages = 0;
        for (const r of rows) {
            add(totals, r.status, r.n);
            byStatus[r.status] = (byStatus[r.status] ?? 0) + r.n;
            byType[r.type] = (byType[r.type] ?? 0) + r.n;
            const bucket = daily.get(r.day);
            if (bucket) add(bucket, r.status, r.n);
            if (r.type === AUTO_REPLY_TYPE) autoReplyMessages += r.n;
        }

        return {
            range: { days, since, until: iso(now) },
            totals: { ...withRates(totals), byStatus, byType },
            daily: keys.map((date) => {
                const c = daily.get(date);
                return { date, total: c.total, sent: c.sent, delivered: c.delivered, read: c.read, failed: c.failed };
            }),
            campaigns: this.#campaigns(since),
            autoReplies: { messages: autoReplyMessages, ...this.#rules(since) },
            responseTimes: this.#responseTimes(since),
        };
    }

    /** 2. Per-campaign breakdown, newest activity first. */
    #campaigns(since) {
        const scope = this.#scope();
        const rows = this.db.prepare(
            `SELECT campaign_id AS id, status, COUNT(*) AS n,
                    MIN(CASE WHEN status NOT IN ('QUEUED', 'SENDING') THEN created_at END) AS first_at,
                    MAX(CASE WHEN status NOT IN ('QUEUED', 'SENDING') THEN created_at END) AS last_at,
                    MAX(created_at) AS latest
             FROM messages
             WHERE tenant_id = ?${scope.sql} AND direction = 'outbound' AND created_at >= ?
               AND message_type = 'campaign' AND campaign_id IS NOT NULL AND campaign_id != ''
             GROUP BY campaign_id, status`,
        ).all(this.tenantId, ...scope.args, since);

        const byId = new Map();
        for (const r of rows) {
            let c = byId.get(r.id);
            if (!c) {
                c = { counts: emptyCounts(), first: null, last: null, latest: '' };
                byId.set(r.id, c);
            }
            add(c.counts, r.status, r.n);
            if (r.first_at && (!c.first || r.first_at < c.first)) c.first = r.first_at;
            if (r.last_at && (!c.last || r.last_at > c.last)) c.last = r.last_at;
            if (r.latest > c.latest) c.latest = r.latest;
        }

        // Names for the campaign records, in one lookup.
        const recordIds = [...byId.keys()].map(recordIdOf).filter((n) => n != null);
        const names = new Map();
        if (recordIds.length) {
            const marks = recordIds.map(() => '?').join(', ');
            for (const row of this.db.prepare(
                `SELECT id, name, status FROM campaigns WHERE tenant_id = ? AND id IN (${marks})`,
            ).all(this.tenantId, ...recordIds)) names.set(row.id, row);
        }

        return [...byId.entries()]
            .sort((a, b) => (a[1].latest < b[1].latest ? 1 : a[1].latest > b[1].latest ? -1 : 0))
            .map(([campaignId, c]) => {
                const recordId = recordIdOf(campaignId);
                const record = recordId != null ? names.get(recordId) : null;
                const { pending, ...counts } = withRates(c.counts);
                return {
                    campaignId,
                    recordId: record ? recordId : null,
                    name: record?.name ?? (recordId != null ? `Campaign #${recordId}` : legacyName(campaignId)),
                    campaignStatus: record?.status ?? null,
                    ...counts,
                    pending,
                    firstSentAt: c.first,
                    lastSentAt: c.last,
                };
            });
    }

    /** 3. Inbound volume and which auto-reply rules answered it. */
    #rules(since) {
        const scope = this.#scope();
        const inbound = this.db.prepare(
            `SELECT COUNT(*) AS total,
                    SUM(CASE WHEN replied_rule IS NOT NULL AND replied_rule != '' THEN 1 ELSE 0 END) AS matched
             FROM inbound_messages WHERE tenant_id = ?${scope.sql} AND received_at >= ?`,
        ).get(this.tenantId, ...scope.args, since);
        const topRules = this.db.prepare(
            `SELECT replied_rule AS rule, COUNT(*) AS count FROM inbound_messages
             WHERE tenant_id = ?${scope.sql} AND received_at >= ?
               AND replied_rule IS NOT NULL AND replied_rule != ''
             GROUP BY replied_rule ORDER BY count DESC, rule ASC LIMIT ${TOP_RULES}`,
        ).all(this.tenantId, ...scope.args, since).map((r) => ({ rule: r.rule, count: r.count }));
        const total = inbound.total ?? 0;
        const matched = inbound.matched ?? 0;
        return { inbound: total, matched, matchRate: rate(matched, total), topRules };
    }

    /** 4. First response time per conversation. */
    #responseTimes(since) {
        const inScope = this.#scope('i.');
        const outScope = this.#scope('m.');
        const broadcast = BROADCAST_TYPES.map(() => '?').join(', ');
        const rows = this.db.prepare(
            `WITH firsts AS (
                 SELECT i.sender AS sender, MIN(i.received_at) AS first_in
                 FROM inbound_messages i
                 WHERE i.tenant_id = ?${inScope.sql} AND i.received_at >= ?
                 GROUP BY i.sender
             )
             SELECT f.sender, f.first_in,
                    (SELECT MIN(m.created_at) FROM messages m
                     WHERE m.tenant_id = ?${outScope.sql} AND m.direction = 'outbound'
                       AND m.recipient = f.sender AND m.created_at >= f.first_in
                       AND m.status != 'FAILED' AND m.message_type NOT IN (${broadcast})) AS first_out
             FROM firsts f`,
        ).all(this.tenantId, ...inScope.args, since, this.tenantId, ...outScope.args, ...BROADCAST_TYPES);

        const durations = [];
        for (const r of rows) {
            if (!r.first_out) continue;
            const seconds = Math.max(0, Math.round((Date.parse(r.first_out) - Date.parse(r.first_in)) / 1000));
            if (Number.isFinite(seconds)) durations.push(seconds);
        }
        durations.sort((a, b) => a - b);

        const conversations = rows.length;
        const answered = durations.length;
        const within = (limit) => durations.filter((s) => s <= limit).length;
        const within5m = within(300);
        const within1h = within(3600);
        const buckets = BUCKETS.map((b) => ({ key: b.key, label: b.label, count: 0 }));
        for (const s of durations) buckets[BUCKETS.findIndex((b) => s <= b.max)].count += 1;
        return {
            conversations,
            answered,
            unanswered: conversations - answered,
            medianSeconds: median(durations),
            p90Seconds: percentile(durations, 0.9),
            averageSeconds: answered ? Math.round(durations.reduce((a, s) => a + s, 0) / answered) : null,
            within5m,
            within1h,
            within5mPct: rate(within5m, conversations),
            within1hPct: rate(within1h, conversations),
            buckets,
        };
    }
}
