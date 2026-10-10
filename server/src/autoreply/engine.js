/**
 * The auto-responder.
 *
 * One inbound message runs through two stages, split so the HELP list, school
 * commands and the FAQ can sit between them (see handleInbound in app.js):
 *
 *   pre   1. menu answer   - the contact is inside a menu and picked an option
 *         2. human handoff - "agent"/"human": confirm, open the inbox
 *                            conversation and pause the bot
 *         3. welcome       - first message ever from this number on this channel
 *         4. away          - outside business hours (throttled per contact)
 *   main  5. rules         - by priority; audience, schedule, actions, menus
 *         6. fallback      - a FALLBACK rule, else the system fallback (throttled);
 *                            skipped when the welcome/away reply already answered
 *
 * `plan()` decides without side effects, which is what the test console shows;
 * `execute()` sends the plan through the message service (opt-out, bot pause,
 * idempotency, pacing) and only then applies actions and remembers menus.
 */

import { personalize } from '../protocol.js';
import { matchReply, personalizeInteractive, renderFallbackText } from '../messaging/interactive.js';
import { fold, hasWord, matchRules } from './match.js';
import { AutoReplyStore } from './store.js';

const HOUR = 3_600_000;
const BUILTIN_VARS = ['name', 'first_name', 'phone', 'sender', 'time_greeting', 'date', 'time', 'business_name'];

export class AutoReplyEngine {
    constructor(db, transport, options = {}) {
        this.db = db;
        this.transport = transport;
        this.delayRangeMs = options.delayRangeMs ?? [200, 600];
        // With a message service attached, replies go down the common pipeline
        // (pacing, retries, opt-out, bot pause). Without one the engine talks to
        // the transport directly, which is what the unit tests use.
        this.service = options.service ?? null;
        this.random = options.random ?? Math.random;
        this.deps = { contacts: null, conversations: null, channel: () => null, media: () => null, businessName: () => '' };
        this.store = db?.db ? new AutoReplyStore(db) : null;
    }

    setTransport(transport) {
        this.transport = transport;
    }

    setService(service) {
        this.service = service;
    }

    /** contacts, conversations, channel(), media(id), businessName() */
    attach(deps) {
        Object.assign(this.deps, deps);
    }

    // ------------------------------------------------------------ live path --
    /** Stage 1-4. Returns { handled, greeted, replies, actions }. */
    async handlePre(msg, { now = new Date() } = {}) {
        if (!this.store || !this.transport?.isConnected?.()) return { handled: false, greeted: false, replies: [], actions: [] };
        const plan = this.plan(msg, { now, stage: 'pre' });
        const sent = await this.execute(msg, plan, now);
        return { handled: plan.handled, greeted: plan.greeted, replies: sent, actions: plan.actions };
    }

    /**
     * Stage 5-6. Returns null when nothing was sent, else
     * { rule, responseText, result, replies, actions } (rule/responseText/result
     * describe the first reply, as v1 did).
     */
    async handleInbound(msg, { greeted = false, now = new Date() } = {}) {
        if (!fold(msg.body) || !this.transport?.isConnected?.()) return null;
        const plan = this.plan(msg, { now, stage: 'main', greeted });
        const sent = await this.execute(msg, plan, now);
        const first = sent.find((r) => r.accepted);
        if (!first) return null;
        const rule = first.ruleId ? this.store?.get(first.ruleId) ?? { id: first.ruleId, keyword: first.ruleName } : { id: null, keyword: first.source };
        return { rule, responseText: first.text, result: first.result, replies: sent, actions: plan.actions };
    }

    // ----------------------------------------------------------- decisions --
    /**
     * Decide what to send, without sending.
     * @param {object} msg { sender, senderName, body, messageId, replyId? }
     * @param {object} opts stage 'pre'|'main'|'all'; firstContact/tags/session
     *   override what the database says (test console); `between(msg)` may
     *   return a reply that ends the run after the pre stage (HELP, FAQ).
     */
    plan(msg, { now = new Date(), stage = 'all', greeted = false, firstContact = null, tags = null, session, between = null } = {}) {
        const ctx = this.#context(msg, { now, firstContact, tags });
        const out = {
            replies: [], actions: [], trace: [], matched: null, handled: false, greeted,
            session: undefined, // undefined = leave as is, null = clear, object = set
            context: {
                firstContact: ctx.firstContact, newContact: ctx.newContact, withinHours: ctx.withinHours,
                localTime: `${ctx.clock.label} (${ctx.tz})`, tags: ctx.tags,
            },
        };
        if (stage !== 'main') {
            this.#pre(msg, ctx, out, session);
            if (out.handled) return out;
        }
        if (stage === 'all' && between) {
            const reply = between(msg);
            if (reply) {
                out.trace.push(reply.note ?? `Answered by ${reply.source}`);
                out.replies.push(reply);
                out.handled = true;
                return out;
            }
        }
        if (stage !== 'pre') this.#main(msg, ctx, out);
        if (!out.replies.length) out.trace.push('No reply');
        return out;
    }

    #pre(msg, ctx, out, sessionOverride) {
        const { settings, phone, now } = ctx;
        const hasText = Boolean(fold(msg.body));

        // 1. The contact is answering a menu we sent.
        const session = sessionOverride !== undefined ? sessionOverride : this.store.session(phone, now);
        if (hasText && session && (!session.expiresAt || new Date(session.expiresAt) > now)) {
            const rule = this.store.get(session.ruleId);
            const node = rule?.isActive ? nodeAt(rule, session.path ?? []) : null;
            const shown = node?.interactive ? personalizeInteractive(node.interactive, ctx.vars) : null;
            const pick = shown ? matchReply(shown, { body: msg.body, replyId: msg.replyId ?? null }) : null;
            const next = pick && (node.menu?.[pick.id] ?? node.menu?.[pick.payload] ?? node.menu?.[String(pick.index + 1)]);
            if (next) {
                out.trace.push(`In the menu of "${label(rule)}": picked option ${pick.index + 1} (${pick.title})`);
                this.#push(out, ctx, next, { source: 'menu', ruleId: rule.id, ruleName: label(rule), key: `menu:${rule.id}` });
                if (next.actions?.addTag) out.actions.push({ type: 'tag', detail: next.actions.addTag, value: next.actions.addTag });
                if (next.actions?.escalate) out.actions.push({ type: 'escalate', detail: 'Open the inbox conversation and pause the bot' });
                const deeper = next.interactive && Object.keys(next.menu ?? {}).length;
                out.session = deeper ? { ruleId: rule.id, path: [...(session.path ?? []), pick.id] } : null;
                if (deeper) out.actions.push({ type: 'menu', detail: `Waiting for an answer to "${label(rule)}" (level ${(session.path ?? []).length + 2})` });
                out.handled = true;
                return;
            }
            out.trace.push(rule ? `In the menu of "${label(rule)}", but this is not one of its options` : 'Menu expired');
        }

        // 2. Human handoff.
        if (hasText && settings.handoff.enabled && hasWord(msg.body, settings.handoff.keywords)) {
            out.trace.push('Handoff keyword: escalating to a person');
            this.#push(out, ctx, { replyBody: settings.handoff.text, media: settings.handoff.media },
                { source: 'handoff', ruleId: null, ruleName: 'Human handoff', key: 'handoff' });
            out.actions.push({ type: 'escalate', detail: 'Open the inbox conversation and pause the bot' });
            out.session = null;
            out.handled = true;
            return;
        }

        // 3. Welcome a first-time contact.
        if (settings.welcome.enabled && ctx.firstContact) {
            out.trace.push('First message from this contact: welcome');
            if (this.#push(out, ctx, { replyBody: settings.welcome.text, media: settings.welcome.media },
                { source: 'welcome', ruleId: null, ruleName: 'Welcome message', key: 'welcome' })) out.greeted = true;
        }

        // 4. Out of office.
        if (settings.away.enabled && !ctx.withinHours) {
            const last = this.store.lastHit('away', phone);
            const throttle = Number(settings.away.throttleHours ?? 0) * HOUR;
            if (last && throttle && now - last < throttle) {
                out.trace.push(`Outside business hours; away message already sent in the last ${settings.away.throttleHours} h`);
            } else {
                out.trace.push('Outside business hours: away message');
                if (this.#push(out, ctx, { replyBody: settings.away.text, media: settings.away.media },
                    { source: 'away', ruleId: null, ruleName: 'Away message', key: 'away' })) out.greeted = true;
            }
        }
    }

    #main(msg, ctx, out) {
        if (!fold(msg.body)) return;
        const rules = this.store.list({ activeOnly: true });
        let answered = false;
        for (const hit of matchRules(msg.body, rules)) {
            const { rule } = hit;
            const name = label(rule);
            if (!audienceOk(rule, ctx)) {
                out.trace.push(`"${name}" matched but its audience is ${audienceLabel(rule.audience)}`);
                continue;
            }
            const meta = { ruleId: rule.id, ruleName: name, key: `rule:${rule.id}` };
            if (rule.schedule && !inWindow(ctx.clock, rule.schedule)) {
                if (!rule.schedule.outsideReply) {
                    out.trace.push(`"${name}" matched but is outside its schedule`);
                    continue;
                }
                out.trace.push(`"${name}" matched outside its schedule: outside-hours reply`);
                out.matched ??= { ruleId: rule.id, matchType: rule.matchType, keyword: hit.keyword, score: hit.score };
                this.#push(out, ctx, { replyBody: rule.schedule.outsideReply }, { source: 'schedule', ...meta });
                answered = true;
                if (rule.actions.stop !== false) break;
                continue;
            }
            out.trace.push(`"${name}" matched (${rule.matchType} "${hit.keyword}"${hit.score < 1 ? `, ${Math.round(hit.score * 100)}%` : ''})`);
            out.matched ??= { ruleId: rule.id, matchType: rule.matchType, keyword: hit.keyword, score: hit.score };
            this.#push(out, ctx, rule, { source: 'rule', ...meta });
            this.#ruleActions(rule, out);
            answered = true;
            if (rule.actions.stop !== false) break;
            out.trace.push(`"${name}" does not stop further rules`);
        }
        if (answered) return;
        if (out.greeted) {
            out.trace.push('Nothing matched; fallback skipped because the welcome/away message already answered');
            return;
        }
        const fallbackRule = rules.find((r) => String(r.matchType).toUpperCase() === 'FALLBACK'
            && audienceOk(r, ctx) && (!r.schedule || inWindow(ctx.clock, r.schedule)));
        if (fallbackRule) {
            out.trace.push(`Nothing matched: fallback rule "${label(fallbackRule)}"`);
            this.#push(out, ctx, fallbackRule, { source: 'fallback', ruleId: fallbackRule.id, ruleName: label(fallbackRule), key: `rule:${fallbackRule.id}` });
            this.#ruleActions(fallbackRule, out);
            return;
        }
        const fb = ctx.settings.fallback;
        if (!fb.enabled) return;
        const last = this.store.lastHit('fallback', ctx.phone);
        const throttle = Number(fb.throttleHours ?? 0) * HOUR;
        if (last && throttle && ctx.now - last < throttle) {
            out.trace.push(`Nothing matched; default fallback already sent in the last ${fb.throttleHours} h`);
            return;
        }
        out.trace.push('Nothing matched: default fallback');
        this.#push(out, ctx, { replyBody: fb.text, media: fb.media }, { source: 'fallback', ruleId: null, ruleName: 'Default fallback', key: 'fallback' });
    }

    #ruleActions(rule, out) {
        const a = rule.actions ?? {};
        if (a.addTag) out.actions.push({ type: 'tag', detail: a.addTag, value: a.addTag });
        if (a.setField?.key) out.actions.push({ type: 'field', detail: `${a.setField.key} = ${a.setField.value}`, key: a.setField.key, value: a.setField.value });
        if (a.escalate) {
            out.actions.push({ type: 'escalate', detail: 'Open the inbox conversation and pause the bot' });
            out.session = null;
        } else if (rule.interactive && Object.keys(rule.menu ?? {}).length) {
            out.session = { ruleId: rule.id, path: [] };
            out.actions.push({ type: 'menu', detail: `Waiting for an answer to "${label(rule)}"` });
        }
    }

    /** Render a reply node and queue it on the plan. False when there is nothing to send. */
    #push(out, ctx, node, meta) {
        const variants = Array.isArray(node.variants) && node.variants.length ? node.variants : [node.replyBody ?? ''];
        const template = variants[Math.min(variants.length - 1, Math.floor(this.random() * variants.length))] ?? '';
        const text = this.formatText(template, ctx.vars);
        const media = node.media?.mediaId ? node.media : null;
        if (!text && !media) {
            out.trace.push(`${meta.ruleName} has no text to send`);
            return false;
        }
        const interactive = node.interactive ? personalizeInteractive(node.interactive, ctx.vars) : null;
        out.replies.push({
            ...meta, text, media, interactive,
            fallbackText: interactive ? renderFallbackText(text, interactive) : text,
        });
        return true;
    }

    // ------------------------------------------------------------- sending --
    /** Send a plan. Actions and menu state apply only if something was accepted. */
    async execute(msg, plan, now = new Date()) {
        const results = [];
        if (!plan.replies.length) return results;
        await this.#delay();
        let accepted = false;
        for (const reply of plan.replies) {
            const idempotencyKey = reply.source === 'rule'
                ? `reply.${msg.messageId}.${reply.ruleId}` : `reply.${msg.messageId}.${reply.key ?? reply.source}`;
            const media = reply.media ? (this.deps.media?.(reply.media.mediaId) ?? null) : null;
            let ok = false;
            let result = null;
            try {
                if (this.service) {
                    const outcome = this.service.send({
                        messageType: 'auto_reply', recipient: msg.sender, text: reply.text, name: msg.senderName ?? '',
                        media, interactive: reply.interactive, idempotencyKey,
                    });
                    ok = outcome.accepted;
                    result = { messageId: outcome.messageId, queued: ok, reason: outcome.reason };
                } else {
                    // The transport renders `interactive` natively or as the numbered fallback.
                    result = await this.transport.sendMessage(msg.sender, reply.text, { media, interactive: reply.interactive });
                    ok = true;
                }
            } catch (err) {
                result = { error: err.message };
            }
            if (ok) {
                accepted = true;
                this.store?.recordHit(reply.key ?? reply.source, msg.sender, now);
            }
            results.push({ ...reply, accepted: ok, result });
        }
        if (!accepted) return results;
        if (plan.session === null) this.store?.clearSession(msg.sender);
        else if (plan.session) this.store?.setSession(msg.sender, plan.session, now);
        for (const action of plan.actions) {
            try {
                this.#apply(action, msg.sender);
            } catch {
                // an action that fails (bad number for contacts, say) must not undo the reply
            }
        }
        return results;
    }

    #apply(action, phone) {
        const { contacts, conversations } = this.deps;
        if (action.type === 'tag' && contacts) contacts.upsert({ phone, tags: [action.value] });
        if (action.type === 'field' && contacts) contacts.upsert({ phone, customFields: { [action.key]: action.value } });
        if (action.type === 'escalate' && conversations) {
            const channelId = this.deps.channel?.()?.id ?? null;
            const c = conversations.getByPhone(phone, channelId) ?? conversations.upsertForInbound({ phone, channelId });
            if (c.status !== 'open') conversations.setStatus(c.id, 'open');
            conversations.addTag(c.id, 'handoff');
            conversations.pauseBot(c.id);
        }
    }

    // ------------------------------------------------------------- helpers --
    /** v1: the rule a message would fire (first match, else the FALLBACK rule). */
    matchRule(text, rules) {
        return matchRules(text, rules)[0]?.rule
            ?? rules.find((rule) => String(rule.matchType).toUpperCase() === 'FALLBACK') ?? null;
    }

    /** v1 preview: render a template for a sample sender. */
    formatResponse(template, msg, now = new Date()) {
        return this.formatText(template, this.#vars(msg, null, now));
    }

    /** {var}, {var|fallback} and spintax. Known variables and contact fields get their fallback when empty. */
    formatText(template, vars) {
        const context = { ...vars };
        for (const key of this.#fieldKeys()) if (!(key in context)) context[key] = '';
        return personalize(String(template ?? ''), context);
    }

    #fieldKeys() {
        try {
            return this.deps.contacts?.fieldKeys?.() ?? [];
        } catch {
            return [];
        }
    }

    #contact(phone) {
        const contacts = this.deps.contacts;
        if (!contacts) return null;
        try {
            return contacts.getByPhone(contacts.normalize(phone)) ?? contacts.getByPhone(phone);
        } catch {
            return contacts.getByPhone?.(phone) ?? null;
        }
    }

    #vars(msg, contact, now) {
        const tz = this.deps.channel?.()?.timezone || 'UTC';
        const clock = localClock(now, tz);
        let greeting = 'Good morning';
        if (clock.hour >= 12 && clock.hour < 17) greeting = 'Good afternoon';
        else if (clock.hour >= 17 || clock.hour < 4) greeting = 'Good evening';
        const name = String(contact?.name || msg.senderName || '').trim();
        let businessName = '';
        try {
            businessName = this.store?.settings().businessName || this.deps.businessName?.() || '';
        } catch {
            // a missing table in a unit test is not worth failing a preview over
        }
        const builtins = {
            name: name || 'Valued Customer',
            first_name: name.split(/\s+/)[0] || 'there',
            phone: msg.sender ?? '',
            sender: msg.sender ?? '',
            time_greeting: greeting,
            date: clock.dateLabel,
            time: clock.timeLabel,
            business_name: businessName,
        };
        return { ...(contact?.customFields ?? {}), ...builtins };
    }

    #context(msg, { now, firstContact, tags }) {
        const settings = this.store.settings();
        const tz = this.deps.channel?.()?.timezone || 'UTC';
        const clock = localClock(now, tz);
        const contact = this.#contact(msg.sender);
        const first = firstContact ?? this.store.isFirstInbound(msg.sender, msg.messageId);
        const seen = this.store.firstSeenAt(msg.sender);
        return {
            now, tz, clock, settings, contact,
            phone: msg.sender,
            firstContact: first,
            newContact: Boolean(first || !seen || now - seen < 24 * HOUR),
            tags: (tags ?? contact?.tags ?? []).map((t) => String(t).toLowerCase()),
            withinHours: businessOpen(settings.away, clock),
            vars: this.#vars(msg, contact, now),
        };
    }

    async #delay() {
        const [min, max] = this.delayRangeMs;
        const delayMs = Math.max(0, min + Math.floor(Math.random() * Math.max(1, max - min)));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
}

// --------------------------------------------------------------- pure bits --
const label = (rule) => rule.name || rule.keywords?.[0] || rule.keyword || `Rule ${rule.id}`;

function audienceLabel(audience) {
    if (audience?.type === 'new') return 'new contacts only';
    if (audience?.type === 'tag') return `contacts tagged "${audience.tag}"`;
    return 'everyone';
}

function audienceOk(rule, ctx) {
    const a = rule.audience ?? { type: 'all' };
    if (a.type === 'new') return ctx.newContact;
    if (a.type === 'tag') return ctx.tags.includes(String(a.tag).toLowerCase());
    return true;
}

/** The menu node a session points at: the rule itself, then down the picked option ids. */
function nodeAt(rule, path) {
    let node = rule;
    for (const id of path) {
        node = node?.menu?.[id];
        if (!node) return null;
    }
    return node;
}

const toMinutes = (hhmm) => {
    const [h, m] = String(hhmm ?? '0:0').split(':');
    return Number(h) * 60 + Number(m || 0);
};

/** Inside days/start/end? A start after the end is an overnight window (22:00-06:00). */
export function inWindow(clock, { days, start, end }) {
    if (Array.isArray(days) && days.length && !days.includes(clock.day)) return false;
    const s = toMinutes(start);
    const e = toMinutes(end);
    if (s === e) return true;
    return s < e ? clock.minutes >= s && clock.minutes < e : clock.minutes >= s || clock.minutes < e;
}

/** Open per the weekly hours and not a holiday. */
export function businessOpen(away, clock) {
    if ((away?.holidays ?? []).includes(clock.date)) return false;
    const h = away?.hours?.[clock.day];
    if (!h?.open) return false;
    return inWindow(clock, { days: null, start: h.start, end: h.end });
}

/** Wall-clock facts in a timezone: weekday, minutes since midnight, YYYY-MM-DD. */
export function localClock(now, timeZone = 'UTC') {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-GB', {
            timeZone, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(now);
    } catch {
        return localClock(now, 'UTC');
    }
    const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
    const hour = Number(get('hour')) % 24;
    const minute = get('minute');
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const timeLabel = `${String(hour).padStart(2, '0')}:${minute}`;
    // Local midnight as an instant, for "today" in analytics.
    const offset = Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day')), hour, Number(minute)) - Math.floor(now.getTime() / 60_000) * 60_000;
    return {
        day: get('weekday').toLowerCase().slice(0, 3),
        hour,
        minutes: hour * 60 + Number(minute),
        date,
        dateLabel: `${Number(get('day'))} ${months[Number(get('month')) - 1]} ${get('year')}`,
        timeLabel,
        label: `${get('weekday')} ${date} ${timeLabel}`,
        dayStart: new Date(Date.UTC(Number(get('year')), Number(get('month')) - 1, Number(get('day'))) - offset),
    };
}

export { BUILTIN_VARS };

export function normalizeInboundText(text) {
    return String(text ?? '')
        .trim()
        .toLowerCase()
        .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
        .replace(/[.!?,;:]+$/g, '')
        .trim();
}
