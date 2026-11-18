/**
 * Auto-reply rules, system-reply settings, menu sessions and hit counters.
 *
 * Takes a tenant- (or channel-) scoped Database handle. Rules and settings are
 * the tenant's; menu sessions and throttles are per number (channel), because
 * "this contact is in the delivery menu" is a fact about one conversation.
 */

import { normalizeInteractive } from '../messaging/interactive.js';
import { utcNow } from '../protocol.js';
import { INTENT_IDS } from './intents.js';
import { LANGUAGE_CODES } from './language.js';
import { MATCH_TYPES, MESSAGE_TYPES, byPriority, ruleKeywords } from './match.js';

export const DAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
export const SYSTEM_KEYS = Object.freeze(['welcome', 'away', 'fallback', 'handoff']);
export const SESSION_MINUTES = 30;
const MAX_MENU_DEPTH = 2;

export class AutoReplyError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

const workday = { open: true, start: '09:00', end: '18:00' };
export const DEFAULT_SETTINGS = Object.freeze({
    businessName: '',
    // The business's own switch for all of its automatic replies (STOP is honoured either way).
    enabled: true,
    // Seconds to wait before replying, inside the platform's range (autoReplies.minDelaySec / maxDelaySec).
    delaySec: 1,
    // Automatic replies one contact may get in an hour; 0 = the platform's limit. Never above it.
    maxPerContactHour: 0,
    welcome: {
        enabled: false,
        text: '{time_greeting} {first_name}! Welcome to {business_name|us}. Reply HELP to see what we can do for you.',
        media: null,
    },
    away: {
        enabled: false,
        text: 'Thanks for your message! We are closed right now and will reply as soon as we are back.',
        media: null,
        hours: { mon: workday, tue: workday, wed: workday, thu: workday, fri: workday,
            sat: { open: false, start: '10:00', end: '14:00' }, sun: { open: false, start: '10:00', end: '14:00' } },
        holidays: [],
        throttleHours: 12,
    },
    fallback: {
        enabled: false,
        text: "Sorry, I didn't catch that. Reply HELP to see the options, or AGENT to talk to a person.",
        media: null,
        throttleHours: 6,
        // After this many fallbacks to one contact within an hour, the next miss hands over to a person (0 = never).
        handoffAfter: 2,
    },
    // Which language replies go out in (see AutoReplyEngine #language).
    language: {
        mode: 'auto', // 'auto': the contact's choice, else what they write in; 'fixed': always `fixed`
        fixed: 'en',
        fallback: '', // the translation to use when there is none for the customer's language ('' = main reply)
        mixed: 'mirror', // Hinglish/Gujlish: 'mirror' answers in kind, 'dominant' prefers Hindi/Gujarati
        // A customer writing in a language no reply is in is told which ones we answer in (once a day).
        askUnknown: true,
    },
    handoff: {
        enabled: false,
        keywords: ['agent', 'human', 'talk to a person'],
        text: 'Connecting you to a team member. Someone will reply here shortly.',
        media: null,
        // The bot stays quiet this long after a handoff or after a person replies from the phone (0 = never pauses).
        pauseHours: 2,
    },
});

export class AutoReplyStore {
    /** @param {import('../db.js').Database} database */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? 0;
    }

    // -------------------------------------------------------------- rules --
    list({ activeOnly = false } = {}) {
        const rows = this.db.prepare(`SELECT * FROM auto_replies WHERE tenant_id = ?${activeOnly ? ' AND is_active = 1' : ''}`)
            .all(this.tenantId);
        return rows.map(toRule).sort(byPriority);
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM auto_replies WHERE id = ? AND tenant_id = ?').get(Number(id), this.tenantId);
        return row ? toRule(row) : null;
    }

    /** Insert or update. Accepts v1 shapes ({ keyword, matchType, replyBody }) as well as v2. */
    save(input) {
        const rule = cleanRule(input);
        const now = utcNow();
        const config = JSON.stringify({
            keywords: rule.keywords, variants: rule.variants, media: rule.media, interactive: rule.interactive,
            menu: rule.menu, schedule: rule.schedule, audience: rule.audience, actions: rule.actions,
            synonyms: rule.synonyms, typos: rule.typos, translations: rule.translations, collect: rule.collect,
        });
        const row = {
            keyword: rule.keywords[0] ?? '',
            match_type: rule.matchType,
            reply_body: rule.variants[0] ?? '',
            is_active: rule.isActive ? 1 : 0,
            cooldown_sec: Number.isFinite(Number(input.cooldownSec)) ? Number(input.cooldownSec) : 0,
            name: rule.name,
            config,
            updated_at: now,
            tenant_id: this.tenantId,
        };
        const existing = input.id ? this.get(input.id) : null;
        if (existing) {
            this.db.prepare(`UPDATE auto_replies SET keyword = :keyword, match_type = :match_type, reply_body = :reply_body,
                    is_active = :is_active, cooldown_sec = :cooldown_sec, name = :name, config = :config,
                    priority = :priority, updated_at = :updated_at
                WHERE id = :id AND tenant_id = :tenant_id`)
                .run({ ...row, id: existing.id, priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : existing.priority });
            return this.get(existing.id);
        }
        const priority = Number.isFinite(Number(input.priority)) && input.priority !== null && input.priority !== ''
            ? Number(input.priority)
            : (this.db.prepare('SELECT COALESCE(MAX(priority), 0) AS p FROM auto_replies WHERE tenant_id = ?').get(this.tenantId).p + 1);
        const info = this.db.prepare(`INSERT INTO auto_replies
                (tenant_id, keyword, match_type, reply_body, is_active, cooldown_sec, name, config, priority, created_at, updated_at)
            VALUES (:tenant_id, :keyword, :match_type, :reply_body, :is_active, :cooldown_sec, :name, :config, :priority, :created_at, :updated_at)`)
            .run({ ...row, priority, created_at: input.createdAt ?? now });
        return this.get(Number(info.lastInsertRowid));
    }

    remove(id) {
        const changes = this.db.prepare('DELETE FROM auto_replies WHERE id = ? AND tenant_id = ?').run(Number(id), this.tenantId).changes;
        if (changes) this.db.prepare('DELETE FROM autoreply_sessions WHERE tenant_id = ? AND rule_id = ?').run(this.tenantId, Number(id));
        return changes;
    }

    /** Priorities become 1..n in the given order; rules not listed keep their place after them. */
    reorder(ids) {
        const order = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
        const rest = this.list().filter((r) => !order.includes(r.id)).map((r) => r.id);
        const update = this.db.prepare('UPDATE auto_replies SET priority = ? WHERE id = ? AND tenant_id = ?');
        [...order, ...rest].forEach((id, i) => update.run(i + 1, id, this.tenantId));
        return this.list();
    }

    // ----------------------------------------------------------- settings --
    settings() {
        const row = this.db.prepare('SELECT settings FROM autoreply_settings WHERE tenant_id = ?').get(this.tenantId);
        return mergeSettings(DEFAULT_SETTINGS, parse(row?.settings, {}));
    }

    saveSettings(patch = {}) {
        const next = cleanSettings(mergeSettings(this.settings(), patch ?? {}));
        this.db.prepare(`INSERT INTO autoreply_settings (tenant_id, settings, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(tenant_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
            .run(this.tenantId, JSON.stringify(next), utcNow());
        return this.settings();
    }

    // ----------------------------------------------------------- sessions --
    session(phone, now = new Date()) {
        const row = this.db.prepare('SELECT * FROM autoreply_sessions WHERE tenant_id = ? AND channel_id = ? AND phone = ?')
            .get(this.tenantId, this.channelId, String(phone));
        if (!row || row.expires_at <= now.toISOString()) return null;
        // `path` holds a menu path (array) or, for a rule asking questions, { flow: { step, tries, answers } }.
        const path = parse(row.path, []);
        return Array.isArray(path)
            ? { ruleId: row.rule_id, path, expiresAt: row.expires_at }
            : { ruleId: row.rule_id, path: [], flow: path.flow ?? null, expiresAt: row.expires_at };
    }

    setSession(phone, { ruleId, path = [], flow = null }, now = new Date()) {
        const expiresAt = new Date(now.getTime() + SESSION_MINUTES * 60_000).toISOString();
        this.db.prepare(`INSERT INTO autoreply_sessions (tenant_id, channel_id, phone, rule_id, path, expires_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, channel_id, phone) DO UPDATE SET rule_id = excluded.rule_id, path = excluded.path, expires_at = excluded.expires_at`)
            .run(this.tenantId, this.channelId, String(phone), Number(ruleId), JSON.stringify(flow ? { flow } : path), expiresAt);
        return { ruleId: Number(ruleId), path, flow, expiresAt };
    }

    clearSession(phone) {
        this.db.prepare('DELETE FROM autoreply_sessions WHERE tenant_id = ? AND channel_id = ? AND phone = ?')
            .run(this.tenantId, this.channelId, String(phone));
    }

    // --------------------------------------------------------------- hits --
    recordHit(key, phone, now = new Date()) {
        this.db.prepare('INSERT INTO autoreply_hits (tenant_id, channel_id, rule_key, phone, at) VALUES (?, ?, ?, ?, ?)')
            .run(this.tenantId, this.channelId, String(key), String(phone), now.toISOString());
    }

    // ---------------------------------------------------------------- log --
    /** One line of the Activity log. `outcome`: replied | failed | skipped | none. Lines older than `keepDays` (the platform's autoReplies.logDays) go. */
    log({ phone, inbound = '', outcome, rule = '', detail = '' }, now = new Date(), keepDays = 30) {
        this.db.prepare(`INSERT INTO autoreply_log (tenant_id, channel_id, phone, inbound, outcome, rule, detail, at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, this.channelId, String(phone), String(inbound ?? '').slice(0, 500), outcome,
                String(rule ?? '').slice(0, 120), String(detail ?? '').slice(0, 500), now.toISOString());
        this.db.prepare('DELETE FROM autoreply_log WHERE tenant_id = ? AND at < ?')
            .run(this.tenantId, new Date(now.getTime() - Math.max(1, Number(keepDays) || 30) * 86_400_000).toISOString());
    }

    /** For the super admin: rules (active of all), replies sent and failures since `since`, every number. */
    usage(since) {
        const at = since.toISOString();
        const rules = this.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(is_active), 0) AS active FROM auto_replies WHERE tenant_id = ?').get(this.tenantId);
        const one = (sql) => this.db.prepare(sql).get(this.tenantId, at).n;
        return {
            rules: rules.n,
            activeRules: rules.active,
            replies: one("SELECT COUNT(*) AS n FROM autoreply_hits WHERE tenant_id = ? AND at >= ? AND rule_key != 'miss'"),
            failed: one("SELECT COUNT(*) AS n FROM autoreply_log WHERE tenant_id = ? AND at >= ? AND outcome = 'failed'"),
        };
    }

    /** The newest Activity log lines, every number of the business; `outcome` narrows it. */
    recentLog({ limit = 100, outcome = null } = {}) {
        const n = Math.min(500, Math.max(1, Number(limit) || 100));
        const rows = outcome
            ? this.db.prepare('SELECT * FROM autoreply_log WHERE tenant_id = ? AND outcome = ? ORDER BY id DESC LIMIT ?').all(this.tenantId, String(outcome), n)
            : this.db.prepare('SELECT * FROM autoreply_log WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(this.tenantId, n);
        return rows.map((r) => ({
            id: r.id, channelId: r.channel_id || null, phone: r.phone, inbound: r.inbound, outcome: r.outcome,
            rule: r.rule, detail: r.detail, at: r.at,
        }));
    }

    /** When this number last got this reply on this channel, or null. */
    lastHit(key, phone) {
        const row = this.db.prepare(`SELECT MAX(at) AS at FROM autoreply_hits
            WHERE tenant_id = ? AND channel_id = ? AND phone = ? AND rule_key = ?`)
            .get(this.tenantId, this.channelId, String(phone), String(key));
        return row?.at ? new Date(row.at) : null;
    }

    /** Replies with one of these keys sent to this number on this channel since `since`. */
    keyHitsSince(keys, phone, since) {
        if (!keys.length) return 0;
        return this.db.prepare(`SELECT COUNT(*) AS n FROM autoreply_hits
            WHERE tenant_id = ? AND channel_id = ? AND phone = ? AND at >= ? AND rule_key IN (${keys.map(() => '?').join(', ')})`)
            .get(this.tenantId, this.channelId, String(phone), since.toISOString(), ...keys.map(String)).n;
    }

    /** The texts of this contact's last messages on this channel, newest first. */
    recentInbound(phone, limit = 5) {
        return this.db.prepare(`SELECT body FROM inbound_messages WHERE tenant_id = ? AND COALESCE(channel_id, 0) = ? AND sender = ?
            ORDER BY id DESC LIMIT ?`).all(this.tenantId, this.channelId, String(phone), limit).map((r) => r.body ?? '');
    }

    /**
     * Auto-replies sent to this number on this channel since `since` (loop protection). 'miss' marks no reply;
     * answers to our own questions and menus (flow:, menu:) are bounded by those and do not count.
     */
    hitsSince(phone, since) {
        return this.db.prepare(`SELECT COUNT(*) AS n FROM autoreply_hits
            WHERE tenant_id = ? AND channel_id = ? AND phone = ? AND at >= ? AND rule_key != 'miss'
              AND rule_key NOT LIKE 'flow:%' AND rule_key NOT LIKE 'menu:%'`)
            .get(this.tenantId, this.channelId, String(phone), since.toISOString()).n;
    }

    /**
     * The Reports tab: what customers sent since `since`, what answered them, what nothing answered, and where they
     * left a menu or a rule's questions part-way. Every number of the business. `timeZone` buckets days and hours.
     *
     * - "Answered" is an incoming message something replied to (`inbound_messages.replied_rule`: the keyword, FAQ,
     *   HELP, a menu pick...). A message while a person had the chat is not answered by the bot, and counts as not.
     * - "Left part-way" is a menu or question session that expired: a finished one is deleted (clearSession), so an
     *   expired row is someone who stopped answering. Only each contact's latest session is kept, so it undercounts.
     */
    report(since, now = new Date(), timeZone = 'UTC') {
        const at = since.toISOString();
        const inbound = this.db.prepare(`SELECT sender, body, replied_rule, received_at FROM inbound_messages
            WHERE tenant_id = ? AND received_at >= ?`).all(this.tenantId, at);
        const rules = this.list();
        const byId = new Map(rules.map((r) => [r.id, r]));
        const byKeyword = new Map(rules.flatMap((r) => ruleKeywords(r).map((k) => [String(k).toLowerCase(), r])));

        let fmt;
        try {
            fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
        } catch {
            fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
        }
        const local = (iso) => {
            const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
            return { day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) % 24 };
        };

        const days = new Map();
        const hours = Array(24).fill(0);
        const answeredBy = new Map();
        let answered = 0;
        for (const m of inbound) {
            const { day, hour } = local(m.received_at);
            const d = days.get(day) ?? { date: day, answered: 0, unanswered: 0 };
            if (m.replied_rule) {
                d.answered += 1;
                answered += 1;
                const hit = answeredBy.get(m.replied_rule) ?? { key: m.replied_rule, uses: 0, customers: new Set() };
                hit.uses += 1;
                hit.customers.add(m.sender);
                answeredBy.set(m.replied_rule, hit);
            } else {
                d.unanswered += 1;
            }
            days.set(day, d);
            hours[hour] += 1;
        }

        // Every day in the range, quiet ones included, so the chart does not skip.
        const byDay = [];
        for (let t = new Date(since); t <= now; t = new Date(t.getTime() + 86_400_000)) {
            const { day } = local(t.toISOString());
            if (!byDay.some((d) => d.date === day)) byDay.push(days.get(day) ?? { date: day, answered: 0, unanswered: 0 });
        }

        const hot = [...answeredBy.values()]
            .map((h) => ({ key: h.key, ...this.#answerLabel(h.key, byKeyword), uses: h.uses, customers: h.customers.size }))
            .sort((a, b) => b.uses - a.uses).slice(0, 10);

        const unanswered = this.db.prepare(`SELECT LOWER(TRIM(inbound)) AS text, COUNT(*) AS count, COUNT(DISTINCT phone) AS customers, MAX(at) AS lastAt
            FROM autoreply_log WHERE tenant_id = ? AND at >= ? AND outcome = 'none' AND TRIM(inbound) != ''
            GROUP BY LOWER(TRIM(inbound)) ORDER BY count DESC, lastAt DESC LIMIT 10`).all(this.tenantId, at);

        const left = new Map();
        for (const s of this.db.prepare(`SELECT rule_id, path FROM autoreply_sessions
            WHERE tenant_id = ? AND expires_at >= ? AND expires_at <= ?`).all(this.tenantId, at, now.toISOString())) {
            const rule = byId.get(s.rule_id);
            const path = parse(s.path, []);
            const step = Array.isArray(path) ? null : Number(path.flow?.step ?? 0);
            const where = step === null
                ? `Menu, level ${path.length + 1}`
                : `Question ${step + 1}: ${rule?.collect?.questions?.[step]?.question ?? ''}`.replace(/: $/, '');
            const key = `${s.rule_id}|${where}`;
            const row = left.get(key) ?? { ruleId: s.rule_id, rule: rule ? (rule.name || ruleKeywords(rule)[0] || `Rule ${rule.id}`) : 'A deleted rule', where, count: 0 };
            row.count += 1;
            left.set(key, row);
        }

        const hits = (key) => this.db.prepare('SELECT COUNT(*) AS n FROM autoreply_hits WHERE tenant_id = ? AND at >= ? AND rule_key = ?')
            .get(this.tenantId, at, key).n;
        const messages = inbound.length;
        return {
            totals: {
                messages,
                answered,
                unanswered: messages - answered,
                answerRate: messages ? Math.round((answered / messages) * 100) : 0,
                customers: new Set(inbound.map((m) => m.sender)).size,
                handoffs: hits('handoff'),
                leftPartWay: [...left.values()].reduce((n, r) => n + r.count, 0),
                failed: this.db.prepare("SELECT COUNT(*) AS n FROM autoreply_log WHERE tenant_id = ? AND at >= ? AND outcome = 'failed'").get(this.tenantId, at).n,
            },
            byDay,
            hours,
            hot,
            unanswered,
            leftPartWay: [...left.values()].sort((a, b) => b.count - a.count).slice(0, 10),
        };
    }

    /**
     * What `inbound_messages.replied_rule` names, for people: { label, kind, rule? }. It holds a rule's keyword, an
     * engine source (welcome, menu, flow...), `faq:<id>`, `help`, or a module tag (`shop:menu`, `school:fees`).
     */
    #answerLabel(key, byKeyword) {
        const SYSTEM = {
            welcome: 'Welcome message', away: 'Away message', fallback: 'Default fallback', handoff: 'Human handoff',
            menu: 'Menu choice', flow: 'Answer to a question', schedule: 'Outside-hours reply', help: 'HELP list',
        };
        if (SYSTEM[key]) return { label: SYSTEM[key], kind: 'system' };
        const faq = /^faq:(d+)$/.exec(key);
        if (faq) {
            const row = this.db.prepare('SELECT question FROM faq_items WHERE id = ? AND tenant_id = ?').get(Number(faq[1]), this.tenantId);
            return { label: row?.question || 'A deleted FAQ answer', kind: 'faq' };
        }
        const mod = /^(shop|school):(.+)$/.exec(key);
        if (mod) return { label: mod[2].toUpperCase(), kind: mod[1] === 'shop' ? 'orders' : 'school' };
        const rule = byKeyword.get(String(key).toLowerCase());
        return { label: key, kind: 'keyword', rule: rule ? rule.name || null : null };
    }

    /** { key: { hits, lastTriggeredAt, today, week } } for every key with hits. `dayStart` is local midnight. */
    stats(now = new Date(), dayStart = startOfDay(now)) {
        const week = new Date(dayStart.getTime() - 6 * 86_400_000).toISOString();
        const rows = this.db.prepare(`SELECT rule_key, COUNT(*) AS hits, MAX(at) AS last,
                SUM(at >= ?) AS today, SUM(at >= ?) AS week
            FROM autoreply_hits WHERE tenant_id = ? GROUP BY rule_key`).all(dayStart.toISOString(), week, this.tenantId);
        return Object.fromEntries(rows.map((r) => [r.rule_key,
            { hits: r.hits, lastTriggeredAt: r.last, today: r.today ?? 0, week: r.week ?? 0 }]));
    }

    // ------------------------------------------------------ contact facts --
    /** No other inbound message from this number on this channel. */
    isFirstInbound(phone, messageId = null) {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM inbound_messages
            WHERE tenant_id = ? AND COALESCE(channel_id, 0) = ? AND sender = ? AND message_id != ?`)
            .get(this.tenantId, this.channelId, String(phone), String(messageId ?? ''));
        return row.n === 0;
    }

    firstSeenAt(phone) {
        const row = this.db.prepare(`SELECT MIN(received_at) AS at FROM inbound_messages
            WHERE tenant_id = ? AND COALESCE(channel_id, 0) = ? AND sender = ?`)
            .get(this.tenantId, this.channelId, String(phone));
        const at = row?.at ? new Date(row.at) : null;
        return at && !Number.isNaN(at.getTime()) ? at : null;
    }
}

export const EMPTY_STATS = Object.freeze({ hits: 0, lastTriggeredAt: null, today: 0, week: 0 });

function startOfDay(now) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

// ------------------------------------------------------------ row shape --
function toRule(row) {
    const config = parse(row.config, {});
    const variants = Array.isArray(config.variants) && config.variants.length ? config.variants : [row.reply_body ?? ''];
    const keywords = Array.isArray(config.keywords) ? config.keywords : ruleKeywords({ keyword: row.keyword, matchType: row.match_type });
    return {
        id: row.id,
        name: row.name || '',
        priority: row.priority ?? 0,
        matchType: row.match_type,
        keyword: keywords[0] ?? row.keyword ?? '',
        keywords,
        replyBody: variants[0] ?? '',
        variants,
        media: config.media ?? null,
        interactive: config.interactive ?? null,
        menu: config.menu ?? {},
        schedule: config.schedule ?? null,
        audience: config.audience ?? { type: 'all' },
        actions: { stop: true, ...(config.actions ?? {}) },
        synonyms: Boolean(config.synonyms),
        // On unless switched off: rules saved before the option existed forgive typos too.
        typos: config.typos !== false,
        translations: config.translations ?? {},
        collect: config.collect ?? null,
        isActive: Boolean(row.is_active),
        cooldownSec: row.cooldown_sec ?? 0,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// ----------------------------------------------------------- validation --
const str = (v, max = 4096) => String(v ?? '').trim().slice(0, max);
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanMedia(media) {
    if (!media || typeof media !== 'object' || !media.mediaId) return null;
    return { mediaId: str(media.mediaId, 64), filename: str(media.filename, 200) || undefined, mimetype: str(media.mimetype, 100) || undefined };
}

function cleanVariants(input) {
    const list = Array.isArray(input.variants) ? input.variants : [];
    const first = input.replyBody ?? input.reply_body;
    const all = list.length ? list : [first];
    return [...new Set(all.map((v) => str(v)).filter(Boolean))].slice(0, 10);
}

function cleanActions(actions = {}) {
    const field = actions.setField && str(actions.setField.key, 60)
        ? { key: str(actions.setField.key, 60).replace(/[^\w]+/g, '_'), value: str(actions.setField.value, 500) } : null;
    return {
        addTag: str(actions.addTag, 60) || undefined,
        setField: field,
        escalate: Boolean(actions.escalate),
        stop: actions.stop !== false,
    };
}

/** A follow-up reply in a menu; nested menus allowed up to MAX_MENU_DEPTH levels. */
function cleanNode(node, depth) {
    if (!node || typeof node !== 'object') return null;
    const variants = cleanVariants(node);
    const media = cleanMedia(node.media);
    if (!variants.length && !media) return null;
    const interactive = depth < MAX_MENU_DEPTH ? normalizeInteractive(node.interactive) : null;
    return {
        replyBody: variants[0] ?? '',
        variants,
        media,
        interactive,
        menu: interactive ? cleanMenu(node.menu, depth + 1) : {},
        actions: { addTag: str(node.actions?.addTag, 60) || undefined, escalate: Boolean(node.actions?.escalate) },
    };
}

function cleanMenu(menu, depth) {
    if (!menu || typeof menu !== 'object') return {};
    const out = {};
    for (const [key, node] of Object.entries(menu).slice(0, 10)) {
        const clean = cleanNode(node, depth);
        if (clean && str(key, 200)) out[str(key, 200)] = clean;
    }
    return out;
}

function cleanSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object') return null;
    const days = (Array.isArray(schedule.days) ? schedule.days : []).map((d) => String(d).toLowerCase().slice(0, 3)).filter((d) => DAYS.includes(d));
    const start = HHMM.test(schedule.start) ? schedule.start : '00:00';
    const end = HHMM.test(schedule.end) ? schedule.end : '23:59';
    return { days: days.length ? [...new Set(days)] : [...DAYS], start, end, outsideReply: str(schedule.outsideReply), timezone: validZone(schedule.timezone) };
}

/** The zone the times were picked in (the editor sends the browser's), or null for the number's zone. */
function validZone(zone) {
    if (!zone || typeof zone !== 'string') return null;
    try {
        new Intl.DateTimeFormat('en', { timeZone: zone });
        return zone;
    } catch {
        return null;
    }
}

/** { languageCode: text } for the languages the editor offers; empty texts dropped. */
function cleanTranslations(input) {
    if (!input || typeof input !== 'object') return {};
    return Object.fromEntries(Object.entries(input)
        .filter(([code, text]) => LANGUAGE_CODES.includes(code) && str(text))
        .map(([code, text]) => [code, str(text)]));
}

export const COLLECT_TYPES = Object.freeze(['text', 'name', 'phone', 'email', 'number', 'language']);

/** Questions a rule asks one by one after its reply; each answer lands in a contact field. Null when none. */
function cleanCollect(input) {
    const questions = (Array.isArray(input?.questions) ? input.questions : []).slice(0, 8).map((q) => ({
        key: str(q?.key, 60).toLowerCase().replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, ''),
        question: str(q?.question, 1000),
        type: COLLECT_TYPES.includes(q?.type) ? q.type : 'text',
        options: q?.type === 'language' ? languageOptions(q.options) : undefined,
    }))
        // The chosen language is the contact's `language` field: what the engine reads as their preference.
        .map((q) => (q.type === 'language' ? { ...q, key: 'language' } : q))
        .filter((q) => q.key && q.question);
    return questions.length
        ? { questions, doneReply: str(input.doneReply), doneTranslations: cleanTranslations(input.doneTranslations) }
        : null;
}

function languageOptions(list) {
    const codes = [...new Set((Array.isArray(list) ? list : []).filter((c) => LANGUAGE_CODES.includes(c)))].slice(0, 10);
    return codes.length ? codes : ['en', 'hi', 'gu'];
}

function cleanAudience(audience) {
    const type = ['all', 'new', 'tag'].includes(audience?.type) ? audience.type : 'all';
    return type === 'tag' ? { type, tag: str(audience.tag, 60).toLowerCase() } : { type };
}

/** Normalise without complaining (stored rows, seeds, v1 callers). */
export function cleanRule(input = {}) {
    const matchType = String(input.matchType ?? input.match_type ?? 'CONTAINS').trim().toUpperCase();
    const keywordsIn = Array.isArray(input.keywords) && input.keywords.length
        ? input.keywords : ruleKeywords({ keyword: input.keyword ?? '', matchType });
    const keywords = [...new Set(keywordsIn.map((k) => str(k, 500)).filter(Boolean))].slice(0, 30);
    const interactive = normalizeInteractive(input.interactive);
    return {
        name: str(input.name, 80),
        matchType,
        keywords,
        variants: cleanVariants(input),
        media: cleanMedia(input.media),
        interactive,
        menu: interactive ? cleanMenu(input.menu, 1) : {},
        schedule: cleanSchedule(input.schedule),
        audience: cleanAudience(input.audience),
        actions: cleanActions(input.actions),
        synonyms: Boolean(input.synonyms),
        typos: input.typos !== false,
        translations: cleanTranslations(input.translations),
        collect: cleanCollect(input.collect),
        isActive: input.isActive === undefined && input.is_active === undefined ? true : Boolean(input.isActive ?? input.is_active),
    };
}

/** API validation: normalised rule, or { errors }. */
export function validateRule(input = {}) {
    let rule;
    try {
        rule = cleanRule(input);
    } catch (err) {
        return { errors: [err.message] };
    }
    const errors = [];
    if (!MATCH_TYPES.includes(rule.matchType)) errors.push(`matchType must be one of ${MATCH_TYPES.join(', ')}`);
    if (rule.matchType !== 'FALLBACK' && !rule.keywords.length) errors.push('keyword is required');
    if (rule.matchType === 'REGEX') {
        for (const k of rule.keywords) {
            try {
                new RegExp(k, 'i');
            } catch {
                errors.push(`invalid regular expression: ${k}`);
            }
        }
    }
    if (!rule.variants.length && !rule.media) errors.push('replyBody is required');
    if (rule.interactive && !rule.variants.length) errors.push('a reply with buttons or a list needs message text');
    if (rule.audience.type === 'tag' && !rule.audience.tag) errors.push('choose the tag this rule is for');
    if (rule.matchType === 'INTENT' && rule.keywords.some((k) => !INTENT_IDS.includes(k))) errors.push(`intent must be one of ${INTENT_IDS.join(', ')}`);
    if (rule.matchType === 'MESSAGE_TYPE' && rule.keywords.some((k) => !MESSAGE_TYPES.includes(k))) errors.push(`message type must be one of ${MESSAGE_TYPES.join(', ')}`);
    if (rule.collect && (rule.interactive || rule.actions.escalate)) errors.push('a rule that asks questions cannot also show a menu or hand over to a person');
    return errors.length ? { errors } : rule;
}

// ------------------------------------------------------------- settings --
function mergeSettings(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch ?? {})) {
        // Translations are sent whole: a language left out has been removed.
        if (key === 'translations') out[key] = value ?? {};
        else if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
            out[key] = mergeSettings(base[key], value);
        } else if (value !== undefined) {
            out[key] = value;
        }
    }
    return out;
}

function cleanSettings(s) {
    const hours = {};
    for (const day of DAYS) {
        const h = s.away?.hours?.[day] ?? {};
        hours[day] = { open: Boolean(h.open), start: HHMM.test(h.start) ? h.start : '09:00', end: HHMM.test(h.end) ? h.end : '18:00' };
    }
    const hrs = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.min(720, Number(v)) : d);
    return {
        businessName: str(s.businessName, 120),
        enabled: s.enabled !== false,
        delaySec: Math.min(120, Math.max(0, Number(s.delaySec ?? 1) || 0)),
        maxPerContactHour: Math.min(1000, Math.max(0, Math.floor(Number(s.maxPerContactHour ?? 0)) || 0)),
        welcome: { enabled: Boolean(s.welcome?.enabled), text: str(s.welcome?.text), media: cleanMedia(s.welcome?.media), translations: cleanTranslations(s.welcome?.translations) },
        away: {
            enabled: Boolean(s.away?.enabled), text: str(s.away?.text), media: cleanMedia(s.away?.media), hours,
            translations: cleanTranslations(s.away?.translations),
            holidays: [...new Set((Array.isArray(s.away?.holidays) ? s.away.holidays : []).map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort(),
            throttleHours: hrs(s.away?.throttleHours, 12),
        },
        fallback: {
            enabled: Boolean(s.fallback?.enabled), text: str(s.fallback?.text), media: cleanMedia(s.fallback?.media),
            throttleHours: hrs(s.fallback?.throttleHours, 0), translations: cleanTranslations(s.fallback?.translations),
            handoffAfter: Math.min(20, Math.max(0, Math.floor(Number(s.fallback?.handoffAfter ?? 2)) || 0)),
        },
        language: {
            mode: s.language?.mode === 'fixed' ? 'fixed' : 'auto',
            fixed: LANGUAGE_CODES.includes(s.language?.fixed) ? s.language.fixed : 'en',
            fallback: LANGUAGE_CODES.includes(s.language?.fallback) ? s.language.fallback : '',
            mixed: s.language?.mixed === 'dominant' ? 'dominant' : 'mirror',
            askUnknown: s.language?.askUnknown !== false,
        },
        handoff: {
            enabled: Boolean(s.handoff?.enabled),
            keywords: [...new Set((Array.isArray(s.handoff?.keywords) ? s.handoff.keywords : []).map((k) => str(k, 60).toLowerCase()).filter(Boolean))].slice(0, 20),
            text: str(s.handoff?.text), media: cleanMedia(s.handoff?.media), translations: cleanTranslations(s.handoff?.translations),
            pauseHours: Math.min(720, Math.max(0, Number(s.handoff?.pauseHours ?? 2) || 0)),
        },
    };
}

function parse(value, fallback) {
    try {
        const parsed = JSON.parse(value ?? '');
        return parsed ?? fallback;
    } catch {
        return fallback;
    }
}
