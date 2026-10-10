/**
 * Auto-reply rules, system-reply settings, menu sessions and hit counters.
 *
 * Takes a tenant- (or channel-) scoped Database handle. Rules and settings are
 * the tenant's; menu sessions and throttles are per number (channel), because
 * "this contact is in the delivery menu" is a fact about one conversation.
 */

import { normalizeInteractive } from '../messaging/interactive.js';
import { utcNow } from '../protocol.js';
import { MATCH_TYPES, byPriority, ruleKeywords } from './match.js';

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
    },
    handoff: {
        enabled: false,
        keywords: ['agent', 'human', 'talk to a person'],
        text: 'Connecting you to a team member. Someone will reply here shortly.',
        media: null,
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
        return { ruleId: row.rule_id, path: parse(row.path, []), expiresAt: row.expires_at };
    }

    setSession(phone, { ruleId, path = [] }, now = new Date()) {
        const expiresAt = new Date(now.getTime() + SESSION_MINUTES * 60_000).toISOString();
        this.db.prepare(`INSERT INTO autoreply_sessions (tenant_id, channel_id, phone, rule_id, path, expires_at) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, channel_id, phone) DO UPDATE SET rule_id = excluded.rule_id, path = excluded.path, expires_at = excluded.expires_at`)
            .run(this.tenantId, this.channelId, String(phone), Number(ruleId), JSON.stringify(path), expiresAt);
        return { ruleId: Number(ruleId), path, expiresAt };
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

    /** When this number last got this reply on this channel, or null. */
    lastHit(key, phone) {
        const row = this.db.prepare(`SELECT MAX(at) AS at FROM autoreply_hits
            WHERE tenant_id = ? AND channel_id = ? AND phone = ? AND rule_key = ?`)
            .get(this.tenantId, this.channelId, String(phone), String(key));
        return row?.at ? new Date(row.at) : null;
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
    return { days: days.length ? [...new Set(days)] : [...DAYS], start, end, outsideReply: str(schedule.outsideReply) };
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
    return errors.length ? { errors } : rule;
}

// ------------------------------------------------------------- settings --
function mergeSettings(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch ?? {})) {
        if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
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
        welcome: { enabled: Boolean(s.welcome?.enabled), text: str(s.welcome?.text), media: cleanMedia(s.welcome?.media) },
        away: {
            enabled: Boolean(s.away?.enabled), text: str(s.away?.text), media: cleanMedia(s.away?.media), hours,
            holidays: [...new Set((Array.isArray(s.away?.holidays) ? s.away.holidays : []).map(String).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort(),
            throttleHours: hrs(s.away?.throttleHours, 12),
        },
        fallback: { enabled: Boolean(s.fallback?.enabled), text: str(s.fallback?.text), media: cleanMedia(s.fallback?.media), throttleHours: hrs(s.fallback?.throttleHours, 0) },
        handoff: {
            enabled: Boolean(s.handoff?.enabled),
            keywords: [...new Set((Array.isArray(s.handoff?.keywords) ? s.handoff.keywords : []).map((k) => str(k, 60).toLowerCase()).filter(Boolean))].slice(0, 20),
            text: str(s.handoff?.text), media: cleanMedia(s.handoff?.media),
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
