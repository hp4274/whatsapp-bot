/**
 * The auto-responder.
 *
 * One inbound message runs through two stages, split so the HELP list, school
 * commands and the FAQ can sit between them (see handleInbound in app.js):
 *
 *   pre   0. questions     - the contact is answering a rule's questions (name, phone, order id...)
 *         1. menu answer   - the contact is inside a menu and picked an option
 *         2. human handoff - "agent"/"human": confirm, open the inbox
 *                            conversation and pause the bot
 *         3. welcome       - first message ever from this number on this channel
 *         4. away          - outside business hours (throttled per contact)
 *   main  5. rules         - by priority; audience, schedule, actions, menus
 *         6. fallback      - a FALLBACK rule, else the system fallback (throttled);
 *                            skipped when the welcome/away reply already answered;
 *                            the Nth unanswered message in an hour goes to a person instead
 *
 * Every reply goes out in the customer's language when the rule (or system
 * message) has a translation for it (language.js detects it).
 *
 * A text-only welcome/away message is not sent on its own: it is held as the
 * plan's `greeting` and goes out in front of whatever answers next (HELP,
 * school command, FAQ, rule), so the contact gets one message, not two. Only
 * when nothing answers is it sent alone.
 *
 * `plan()` decides without side effects, which is what the test console shows;
 * `execute()` sends the plan through the message service (opt-out, bot pause,
 * idempotency, pacing) and only then applies actions and remembers menus.
 */

import { personalize } from '../protocol.js';
import { matchReply, personalizeInteractive, renderFallbackText } from '../messaging/interactive.js';
import { LANGUAGE_CODES, detect, languageLabel, parseLanguage } from './language.js';
import { INTENTS } from './intents.js';
import { fold, hasWord, matchRules } from './match.js';
import { effectiveSettings, inQuietHours, kindAllowed } from './policy.js';
import { AutoReplyStore } from './store.js';

const HOUR = 3_600_000;
const BUILTIN_VARS = ['name', 'first_name', 'phone', 'sender', 'time_greeting', 'date', 'time', 'business_name'];

export class AutoReplyEngine {
    constructor(db, transport, options = {}) {
        this.db = db;
        this.transport = transport;
        // A fixed range (tests pass [0, 0]); otherwise the business's reply delay inside the platform's range.
        this.delayRangeMs = options.delayRangeMs ?? null;
        // With a message service attached, replies go down the common pipeline
        // (pacing, retries, opt-out, bot pause). Without one the engine talks to
        // the transport directly, which is what the unit tests use.
        this.service = options.service ?? null;
        this.random = options.random ?? Math.random;
        this.deps = { contacts: null, conversations: null, channel: () => null, media: () => null, businessName: () => '', platformPolicy: () => ({}) };
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
    /**
     * Stage 1-4. Returns { handled, greeted, greeting, replies, actions }.
     * `greeting` ({ text, replies } or null) is the welcome/away message, not
     * yet sent: whatever answers next puts it in front (`withGreeting`, then
     * `noteGreeting` once accepted), and handleInbound sends it either way.
     */
    async handlePre(msg, { now = new Date() } = {}) {
        if (!this.store || !this.transport?.isConnected?.()) return { handled: false, greeted: false, greeting: null, replies: [], actions: [] };
        const plan = this.plan(msg, { now, stage: 'pre' });
        const sent = await this.execute(msg, plan, now);
        // Quiet hours or the hourly cap would have kept it from going out alone; it does not ride along either.
        const greeting = plan.greeting && this.#canSend(msg, now) ? plan.greeting : null;
        return { handled: plan.handled, greeted: plan.greeted, greeting, replies: sent, actions: plan.actions };
    }

    /**
     * Stage 5-6. Returns null when nothing was sent, else
     * { rule, responseText, result, replies, actions } (rule/responseText/result
     * describe the first reply, as v1 did). A held `greeting` goes in front of
     * the first reply, or alone when no rule answers.
     */
    async handleInbound(msg, { greeted = false, greeting = null, now = new Date() } = {}) {
        if (!this.transport?.isConnected?.() || (!fold(msg.body) && !msg.mediaType && !greeting)) return null;
        const plan = this.plan(msg, { now, stage: 'main', greeted, greeting });
        const sent = await this.execute(msg, plan, now);
        // Counted whether or not a fallback went out: the Nth miss in an hour hands over to a person.
        if (plan.miss) this.store?.recordHit('miss', msg.sender, now);
        if (!plan.replies.length && fold(msg.body)) {
            // Silence is a decision too: the log says which rule matched but held back, or that none did.
            const why = plan.trace.filter((line) => line !== 'No reply').join('. ') || 'Nothing matched';
            this.log(msg, 'none', '', why, now);
        }
        const first = sent.find((r) => r.accepted);
        if (!first) return null;
        const rule = first.ruleId ? this.store?.get(first.ruleId) ?? { id: first.ruleId, keyword: first.ruleName } : { id: null, keyword: first.source };
        return { rule, responseText: first.text, result: first.result, replies: sent, actions: plan.actions };
    }

    /** `text` with the held welcome/away message in front, for a reply sent outside the engine. */
    withGreeting(text, greeting) {
        return greeting?.text ? joinText(greeting.text, text) : text;
    }

    /** A reply carrying `greeting` was accepted: count it as sent (analytics, the away throttle). */
    noteGreeting(msg, greeting, now = new Date()) {
        for (const r of greeting?.replies ?? []) this.store?.recordHit(r.key ?? r.source, msg.sender, now);
    }

    /** Platform quiet hours right now (channel time zone)? FAQ answers use this too. */
    quiet(now = new Date()) {
        return inQuietHours(this.deps.platformPolicy(), localClock(now, this.deps.channel?.()?.timezone || 'UTC'));
    }

    // ----------------------------------------------------------- decisions --
    /**
     * Decide what to send, without sending.
     * @param {object} msg { sender, senderName, body, messageId, replyId? }
     * @param {object} opts stage 'pre'|'main'|'all'; firstContact/tags/session
     *   override what the database says (test console); `between(msg)` may
     *   return a reply that ends the run after the pre stage (HELP, FAQ);
     *   `greeting` is the one the pre stage held back (stage 'main').
     */
    plan(msg, { now = new Date(), stage = 'all', greeted = false, greeting = null, firstContact = null, tags = null, session, between = null } = {}) {
        const ctx = this.#context(msg, { now, firstContact, tags });
        const off = !ctx.settings.enabled;
        const out = {
            replies: [], actions: [], trace: [], matched: null, handled: false, greeted, greeting,
            session: undefined, // undefined = leave as is, null = clear, object = set
            context: {
                firstContact: ctx.firstContact, newContact: ctx.newContact, withinHours: ctx.withinHours,
                localTime: `${ctx.clock.label} (${ctx.tz})`, tags: ctx.tags, language: languageNote(ctx.language),
            },
        };
        if (off) {
            // The business switched its automation off: STOP is still honoured (app.js), nothing else answers.
            out.trace.push('Auto replies are switched off for this business');
            out.handled = true;
            return out;
        }
        if (stage !== 'main') {
            this.#pre(msg, ctx, out, session);
            if (out.handled) return out;
            this.#holdGreeting(out);
            if (stage === 'pre') return out;
        }
        if (stage === 'all' && between) {
            const reply = between(msg);
            if (reply) {
                out.trace.push(reply.note ?? `Answered by ${reply.source}`);
                out.replies.push(reply);
                out.handled = true;
                this.#mergeGreeting(out);
                return out;
            }
        }
        this.#main(msg, ctx, out);
        this.#mergeGreeting(out);
        this.#languageNote(ctx, out);
        if (!out.replies.length) out.trace.push('No reply');
        return out;
    }

    /**
     * Take text-only welcome/away replies off the plan into `out.greeting`. One
     * with media or buttons cannot be folded into another message's text, so
     * then they all stay their own messages, as before.
     */
    #holdGreeting(out) {
        const held = out.replies.filter((r) => r.source === 'welcome' || r.source === 'away');
        if (!held.length || held.some((r) => r.media || r.interactive)) return;
        out.replies = out.replies.filter((r) => !held.includes(r));
        out.greeting = { text: held.map((r) => r.text).reduce(joinText), replies: held };
    }

    /** Put the held greeting in front of the first reply, or send it alone when nothing answered. */
    #mergeGreeting(out) {
        const greeting = out.greeting;
        if (!greeting) return;
        out.greeting = null;
        const [first] = out.replies;
        if (!first) {
            // Welcome and away both: still one message, sent under the first one's key.
            const [lead, ...rest] = greeting.replies;
            out.replies.push(rest.length
                ? { ...lead, text: greeting.text, fallbackText: greeting.text, greeting: { text: '', replies: rest } }
                : lead);
            return;
        }
        out.trace.push(`${greeting.replies.map((r) => r.ruleName).join(' and ')} sent in the same message`);
        out.replies[0] = {
            ...first,
            text: joinText(greeting.text, first.text),
            fallbackText: joinText(greeting.text, first.fallbackText ?? first.text),
            greeting,
        };
    }

    #pre(msg, ctx, out, sessionOverride) {
        const { settings, phone, now } = ctx;
        const hasText = Boolean(fold(msg.body));

        const session = sessionOverride !== undefined ? sessionOverride : this.store.session(phone, now);
        // 0. The contact is answering a rule's questions.
        if (hasText && session?.flow && (!session.expiresAt || new Date(session.expiresAt) > now)) {
            if (this.#flow(msg, ctx, out, session)) return;
        }

        // 1. The contact is answering a menu we sent.
        if (hasText && session && !session.flow && (!session.expiresAt || new Date(session.expiresAt) > now)) {
            const rule = this.store.get(session.ruleId);
            // A menu started inside the rule's hours does not keep answering after they end.
            const node = rule?.isActive && kindAllowed(rule, this.deps.platformPolicy()) && scheduleOpen(rule, ctx)
                ? nodeAt(rule, session.path ?? []) : null;
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
            this.#push(out, ctx, { replyBody: settings.handoff.text, media: settings.handoff.media, translations: settings.handoff.translations },
                { source: 'handoff', ruleId: null, ruleName: 'Human handoff', key: 'handoff' });
            out.actions.push({ type: 'escalate', detail: 'Open the inbox conversation and pause the bot' });
            out.session = null;
            out.handled = true;
            return;
        }

        // 3. Welcome a first-time contact.
        if (settings.welcome.enabled && ctx.firstContact) {
            out.trace.push('First message from this contact: welcome');
            if (this.#push(out, ctx, { replyBody: settings.welcome.text, media: settings.welcome.media, translations: settings.welcome.translations },
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
                if (this.#push(out, ctx, { replyBody: settings.away.text, media: settings.away.media, translations: settings.away.translations },
                    { source: 'away', ruleId: null, ruleName: 'Away message', key: 'away' })) out.greeted = true;
            }
        }
    }

    /**
     * One answer to a rule's questions: check it, save it to the contact, ask the next one or say thanks.
     * False when the message is not an answer (the contact asked for a person, or the rule is gone) and
     * the pipeline should carry on as usual.
     * shortcut: the re-ask hints and the cancel reply are English only; translate them when a business asks.
     */
    #flow(msg, ctx, out, session) {
        const rule = this.store.get(session.ruleId);
        const questions = rule?.isActive ? rule.collect?.questions ?? [] : [];
        const { step = 0, tries = 0, answers = {} } = session.flow;
        const q = questions[step];
        const meta = { source: 'flow', ruleId: rule?.id ?? null, ruleName: rule ? label(rule) : 'Questions', key: `flow:${session.ruleId}` };
        if (!q) {
            out.trace.push('The questions this contact was answering no longer exist');
            out.session = null;
            return false;
        }
        const { handoff } = ctx.settings;
        if (handoff.enabled && hasWord(msg.body, handoff.keywords)) {
            out.trace.push(`Asked for a person in the middle of "${meta.ruleName}"`);
            return false;
        }
        if (CANCEL_WORDS.has(fold(msg.body))) {
            out.trace.push(`Cancelled "${meta.ruleName}" at question ${step + 1}`);
            this.#push(out, ctx, { replyBody: 'No problem, cancelled. Send a message any time if you need anything.' }, meta);
            out.session = null;
            out.handled = true;
            return true;
        }
        if (BACK_WORDS.has(fold(msg.body)) && step > 0) {
            out.trace.push(`"${meta.ruleName}": back to question ${step}`);
            this.#push(out, ctx, { replyBody: questionText(questions[step - 1], ctx, this) }, meta);
            out.session = { ruleId: rule.id, flow: { step: step - 1, tries: 0, answers } };
            out.handled = true;
            return true;
        }
        const value = q.type === 'language' ? parseLanguage(msg.body, q.options) : checkAnswer(q.type, msg.body);
        if (value === null) {
            if (tries >= 2) {
                // Three unclear answers in a row: they have moved on; let the rules answer what they are really asking.
                out.trace.push(`Gave up on "${meta.ruleName}" question ${step + 1} after three unclear answers`);
                out.session = null;
                return false;
            }
            out.trace.push(`"${meta.ruleName}" question ${step + 1}: not a valid ${q.type}, asking again`);
            this.#push(out, ctx, { replyBody: joinText(ANSWER_HINTS[q.type], questionText(q, ctx, this)) }, meta);
            out.session = { ruleId: rule.id, flow: { step, tries: tries + 1, answers } };
            out.handled = true;
            return true;
        }
        const saved = { ...answers, [q.key]: value };
        out.trace.push(`"${meta.ruleName}" question ${step + 1}: saved ${q.key} = ${value}`);
        out.actions.push({ type: 'field', detail: `${q.key} = ${value}`, key: q.key, value });
        if (q.type === 'name') out.actions.push({ type: 'name', detail: `Contact name = ${value}`, value });
        const vars = { ...ctx.vars, ...saved };
        // A language just chosen answers in that language from the next message on.
        const after = q.type === 'language' ? { ...ctx, vars, lang: value } : { ...ctx, vars };
        const next = questions[step + 1];
        if (next) {
            this.#push(out, after, { replyBody: questionText(next, after, this) }, meta);
            out.session = { ruleId: rule.id, flow: { step: step + 1, tries: 0, answers: saved } };
        } else {
            out.trace.push(`"${meta.ruleName}": all ${questions.length} answers in`);
            this.#push(out, after, { replyBody: rule.collect.doneReply || 'Thank you! We have your details and will get back to you.', translations: rule.collect.doneTranslations }, meta);
            out.session = null;
        }
        out.handled = true;
        return true;
    }

    #main(msg, ctx, out) {
        const hasText = Boolean(fold(msg.body));
        if (!hasText && !msg.mediaType) return;
        const policy = this.deps.platformPolicy();
        // Rules of a kind the plan no longer includes stay stored but never fire.
        const rules = this.store.list({ activeOnly: true }).filter((r) => kindAllowed(r, policy))
            // Synonyms ride on the intent groups: off with them.
            .map((r) => (policy['autoReplies.allowIntents'] === false ? { ...r, noSynonyms: true } : r));
        let answered = false;
        let afterHours = false;
        for (const hit of matchRules(msg.body, rules, msg.mediaType ?? null)) {
            const { rule } = hit;
            const name = label(rule);
            if (!audienceOk(rule, ctx)) {
                out.trace.push(`"${name}" matched but its audience is ${audienceLabel(rule.audience)}`);
                continue;
            }
            const meta = { ruleId: rule.id, ruleName: name, key: `rule:${rule.id}` };
            if (!scheduleOpen(rule, ctx)) {
                if (!rule.schedule.outsideReply) {
                    out.trace.push(`"${name}" matched but is outside its schedule`);
                    afterHours = true;
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
            this.#ruleActions(rule, out, ctx);
            answered = true;
            if (rule.actions.stop !== false) break;
            out.trace.push(`"${name}" does not stop further rules`);
        }
        if (answered) return;
        if (!hasText) {
            // A photo or file nobody wrote a rule for: no "didn't catch that", the business sees it in the chat.
            out.trace.push(`A ${msg.mediaType} with no message-type rule: no reply`);
            return;
        }
        if (afterHours) {
            // The keyword was understood, just out of hours: a "didn't catch that" fallback would be wrong.
            out.trace.push('Nothing else matched; staying silent outside the schedule');
            return;
        }
        if (out.greeted) {
            out.trace.push('Nothing matched; fallback skipped because the welcome/away message already answered');
            return;
        }
        out.miss = true;
        const { handoff } = ctx.settings;
        const after = Number(ctx.settings.fallback.handoffAfter ?? 0);
        if (after > 0 && handoff.enabled && this.store.keyHitsSince(['miss'], ctx.phone, new Date(ctx.now - HOUR)) >= after - 1) {
            // The bot keeps not understanding: a person is better than another "didn't catch that".
            out.trace.push(`Nothing understood ${after} times in an hour: handing over to a person`);
            this.#push(out, ctx, { replyBody: handoff.text, media: handoff.media, translations: handoff.translations },
                { source: 'handoff', ruleId: null, ruleName: 'Human handoff', key: 'handoff' });
            out.actions.push({ type: 'escalate', detail: 'Open the inbox conversation and pause the bot' });
            out.session = null;
            return;
        }
        const fallbackRule = rules.find((r) => String(r.matchType).toUpperCase() === 'FALLBACK'
            && audienceOk(r, ctx) && scheduleOpen(r, ctx));
        if (fallbackRule) {
            out.trace.push(`Nothing matched: fallback rule "${label(fallbackRule)}"`);
            this.#push(out, ctx, fallbackRule, { source: 'fallback', ruleId: fallbackRule.id, ruleName: label(fallbackRule), key: `rule:${fallbackRule.id}` });
            this.#ruleActions(fallbackRule, out, ctx);
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
        this.#push(out, ctx, { replyBody: fb.text, media: fb.media, translations: fb.translations }, { source: 'fallback', ruleId: null, ruleName: 'Default fallback', key: 'fallback' });
    }

    #ruleActions(rule, out, ctx) {
        const a = rule.actions ?? {};
        const first = rule.collect?.questions?.[0];
        if (first && out.replies.at(-1)?.ruleId === rule.id) {
            // The first question rides in the rule's own reply; the answers come back through #flow.
            const reply = out.replies.at(-1);
            const question = questionText(first, ctx, this);
            reply.text = joinText(reply.text, question);
            reply.fallbackText = joinText(reply.fallbackText, question);
            out.session = { ruleId: rule.id, flow: { step: 0, tries: 0, answers: {} } };
            out.actions.push({ type: 'menu', detail: `Asking "${label(rule)}" question 1 of ${rule.collect.questions.length}` });
        }
        if (a.addTag) out.actions.push({ type: 'tag', detail: a.addTag, value: a.addTag });
        if (a.setField?.key) out.actions.push({ type: 'field', detail: `${a.setField.key} = ${a.setField.value}`, key: a.setField.key, value: a.setField.value });
        if (a.escalate) {
            out.actions.push({ type: 'escalate', detail: 'Open the inbox conversation and pause the bot' });
            out.session = null;
        } else if (!first && rule.interactive && Object.keys(rule.menu ?? {}).length) {
            out.session = { ruleId: rule.id, path: [] };
            out.actions.push({ type: 'menu', detail: `Waiting for an answer to "${label(rule)}"` });
        }
    }

    /** Render a reply node and queue it on the plan. False when there is nothing to send. */
    #push(out, ctx, node, meta) {
        const [code, translated] = translationFor(node.translations, ctx.lang, ctx.settings.language);
        if (translated) out.trace.push(`${meta.ruleName}: replying in ${languageLabel(code)}`);
        const variants = translated ? [translated]
            : Array.isArray(node.variants) && node.variants.length ? node.variants : [node.replyBody ?? ''];
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
        // Platform rules: quiet hours, and a per-contact hourly cap against bot-to-bot loops.
        if (this.quiet(now)) {
            this.log(msg, 'skipped', plan.replies[0]?.ruleName ?? '', 'Quiet hours: no automatic replies now', now);
            return results;
        }
        // Answers to our own questions and menus are bounded by them, so the loop cap does not cut a form short.
        const prompted = plan.replies.every((r) => r.source === 'flow' || r.source === 'menu');
        let budget = prompted ? Infinity : this.#budget(msg, now);
        if (budget <= 0) {
            this.log(msg, 'skipped', plan.replies[0]?.ruleName ?? '', 'This contact already got the most automatic replies allowed this hour', now);
            return results;
        }
        await this.#delay();
        let accepted = false;
        for (const reply of plan.replies) {
            if (budget <= 0) break;
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
                budget -= 1;
                this.store?.recordHit(reply.key ?? reply.source, msg.sender, now);
                this.noteGreeting(msg, reply.greeting, now);
                if (reply.languageNote) this.store?.recordHit('language-note', msg.sender, now);
            }
            results.push({ ...reply, accepted: ok, result });
            if (ok) this.log(msg, 'replied', reply.ruleName ?? reply.source ?? '', reply.fallbackText ?? reply.text ?? '', now);
            else if (result?.error) this.log(msg, 'failed', reply.ruleName ?? '', result.error, now);
            else this.log(msg, 'skipped', reply.ruleName ?? '', result?.reason ?? 'Not sent', now);
        }
        if (!accepted) return results;
        if (plan.session === null) this.store?.clearSession(msg.sender);
        else if (plan.session) this.store?.setSession(msg.sender, plan.session, now);
        for (const action of plan.actions) {
            try {
                this.#apply(action, msg.sender, msg);
            } catch {
                // an action that fails (bad number for contacts, say) must not undo the reply
            }
        }
        return results;
    }

    /** A line in the Activity log. Never throws: a log that fails must not stop a reply. */
    log(msg, outcome, rule, detail, now = new Date()) {
        try {
            const days = Number(this.deps.platformPolicy?.()['autoReplies.logDays'] ?? 30);
            this.store?.log({ phone: msg.sender, inbound: msg.body ?? '', outcome, rule, detail }, now, days);
        } catch (err) {
            console.error('[auto-replies] could not write the activity log:', err.message);
        }
    }

    /** Replies this contact may still get this hour (the platform's per-contact cap). */
    #budget(msg, now) {
        const caps = [this.deps.platformPolicy()['autoReplies.maxPerContactHour'], this.store?.settings().maxPerContactHour]
            .map(Number).filter((n) => n > 0);
        const cap = caps.length ? Math.min(...caps) : 0;
        return cap > 0 ? cap - this.store.hitsSince(msg.sender, new Date(now.getTime() - HOUR)) : Infinity;
    }

    #canSend(msg, now) {
        return !this.quiet(now) && this.#budget(msg, now) > 0;
    }

    #apply(action, phone, msg = null) {
        const { contacts, conversations } = this.deps;
        if (action.type === 'tag' && contacts) contacts.upsert({ phone, tags: [action.value] });
        if (action.type === 'field' && contacts) contacts.upsert({ phone, customFields: { [action.key]: action.value } });
        if (action.type === 'name' && contacts) contacts.upsert({ phone, name: action.value });
        if (action.type === 'escalate' && conversations) {
            const channelId = this.deps.channel?.()?.id ?? null;
            const c = conversations.getByPhone(phone, channelId) ?? conversations.upsertForInbound({ phone, channelId });
            if (c.status !== 'open') conversations.setStatus(c.id, 'open');
            conversations.addTag(c.id, 'handoff');
            // The handoff reply promised a person: the bot gives them room for a while.
            this.#pauseFor(c);
            // Tickets opens one for the business that asked it to (tickets/whatsapp.js).
            if (msg) this.deps.onEscalate?.(msg);
        }
    }

    /**
     * Someone answered this contact from the phone or WhatsApp Web: the bot stays out of that chat for the
     * handoff pause, counted again from every reply they send.
     */
    humanReplied(phone, now = new Date()) {
        const { conversations } = this.deps;
        if (!conversations || !this.store) return;
        const channelId = this.deps.channel?.()?.id ?? null;
        const c = conversations.getByPhone(phone, channelId) ?? conversations.upsertForInbound({ phone, channelId });
        this.#pauseFor(c, now);
        // Questions or a menu in progress are over: the person is handling it.
        this.store.clearSession(phone);
    }

    /** Timed, because nothing in the app hands a chat back any more. */
    #pauseFor(conversation, now = new Date()) {
        const hours = this.store ? Number(this.#settings().handoff.pauseHours ?? 0) : 0;
        if (hours > 0) this.deps.conversations?.pauseBot?.(conversation.id, new Date(now.getTime() + hours * HOUR));
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

    /** The business's settings with the plan applied: switched-off system replies off, values clamped. */
    #settings() {
        return effectiveSettings(this.store.settings(), this.deps.platformPolicy());
    }

    #context(msg, { now, firstContact, tags }) {
        const settings = this.#settings();
        const tz = this.deps.channel?.()?.timezone || 'UTC';
        const clock = localClock(now, tz);
        const contact = this.#contact(msg.sender);
        const first = firstContact ?? this.store.isFirstInbound(msg.sender, msg.messageId);
        const seen = this.store.firstSeenAt(msg.sender);
        const ctx = {
            now, tz, clock, settings, contact,
            phone: msg.sender,
            firstContact: first,
            newContact: Boolean(first || !seen || now - seen < 24 * HOUR),
            tags: (tags ?? contact?.tags ?? []).map((t) => String(t).toLowerCase()),
            withinHours: businessOpen(settings.away, clock),
            vars: this.#vars(msg, contact, now),
        };
        ctx.language = this.#language(msg, contact, settings);
        ctx.lang = ctx.language.code;
        return ctx;
    }

    /**
     * Which language to reply in, and why: a fixed business language; the contact's own choice (the
     * `language` field, set by them through a question or by the business, never by detection); else
     * the message; a message too short to tell ("ok") reads their last few messages together.
     */
    #language(msg, contact, settings) {
        if (this.deps.platformPolicy()['autoReplies.allowTranslations'] === false) return { code: 'en', confidence: 1, source: 'plan' };
        const pref = settings.language ?? {};
        if (pref.mode === 'fixed' && pref.fixed) return { code: pref.fixed, confidence: 1, source: 'fixed' };
        const chosen = String(contact?.customFields?.language ?? '').toLowerCase();
        if (LANGUAGE_CODES.includes(chosen)) return { code: chosen, confidence: 1, source: 'contact' };
        const now = detect(msg.body);
        if (now.confidence >= 0.5 || !this.store) return { ...now, source: 'message' };
        const recent = detect(this.store.recentInbound(msg.sender, 5).join('\n'));
        return recent.confidence > now.confidence ? { ...recent, source: 'recent' } : { ...now, source: 'message' };
    }

    /**
     * A customer writing in a language none of the replies are in: say which languages we answer in, in theirs and in
     * English, and ask them to write in one. Under the reply when one matched, alone when nothing did; once a day each.
     */
    #languageNote(ctx, out) {
        const { language: lang, settings } = ctx;
        if (settings.language?.askUnknown === false || !lang || lang.confidence < 0.5) return;
        // Only what the message says: a language they chose, or one the business fixed, is already a decision.
        if (lang.source !== 'message' && lang.source !== 'recent') return;
        const supported = this.#replyLanguages(settings);
        const roman = { hinglish: 'hi', gujlish: 'gu' }[lang.code];
        // Hinglish and Gujlish writers read English (or their own language) fine.
        if (supported.has(lang.code) || (roman && (supported.has('en') || supported.has(roman)))) return;
        const last = this.store.lastHit('language-note', ctx.phone);
        if (last && ctx.now - last < 24 * HOUR) return;
        const names = [...supported].map(languageLabel).join(', ');
        const say = (code) => (LANGUAGE_NOTE[code] ?? LANGUAGE_NOTE.en).replace('{langs}', names);
        const text = [...new Set([say(lang.code), say('en')])].join('\n');
        out.trace.push(`Written in ${languageLabel(lang.code)}, which no reply is in: asking them to write in ${names}`);
        const last2 = out.replies.at(-1);
        if (last2 && !last2.interactive) {
            last2.text = joinText(last2.text, text);
            last2.fallbackText = joinText(last2.fallbackText, text);
            last2.languageNote = true;
            return;
        }
        out.replies.push({ source: 'language', ruleId: null, ruleName: 'Language note', key: 'language-note', text, fallbackText: text, media: null, interactive: null });
    }

    /** The languages replies go out in: the main one (English, or the business's fixed language) and every translation. */
    #replyLanguages(settings) {
        const out = new Set([settings.language?.mode === 'fixed' && settings.language.fixed ? settings.language.fixed : 'en']);
        const add = (t) => Object.keys(t ?? {}).forEach((code) => out.add(code));
        for (const r of this.store.list({ activeOnly: true })) {
            add(r.translations);
            add(r.collect?.doneTranslations);
        }
        for (const key of ['welcome', 'away', 'fallback', 'handoff']) add(settings[key]?.translations);
        return out;
    }

    /** True unless the business switched its auto replies off (app.js skips HELP and the FAQ too then). */
    active() {
        try {
            return this.store?.settings().enabled !== false;
        } catch {
            return true;
        }
    }

    async #delay() {
        const sec = this.delayRangeMs ? null : Number(this.#settings().delaySec ?? 1);
        // About the delay the business chose, give or take a fifth, so replies do not land like clockwork.
        const [min, max] = this.delayRangeMs ?? [sec * 800, sec * 1200];
        const delayMs = Math.max(0, min + Math.floor(Math.random() * Math.max(1, max - min)));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
}

// --------------------------------------------------------------- pure bits --
const joinText = (a, b) => [a, b].filter(Boolean).join('\n\n');


const INTENT_WORDS = Object.values(INTENTS).flatMap((i) => i.words);

const BACK_WORDS = new Set(['back', 'previous', 'go back', 'peeche', 'pachhu', 'pachu']);

/** A question as sent: a language question lists its choices by number. */
function questionText(q, ctx, engine) {
    const text = engine.formatText(q.question, ctx.vars);
    if (q.type !== 'language') return text;
    return joinText(text, (q.options ?? []).map((code, i) => `${i + 1}. ${languageLabel(code)}`).join('\n'));
}

/**
 * The text for this language: its own translation; in 'dominant' mode Hindi before Hinglish (and Gujarati
 * before Gujlish), in 'mirror' mode the other way round; then the business's fallback language.
 * [code, text], or [null, null] for "use the main reply".
 */
function translationFor(translations, lang, settings = {}) {
    if (!translations || !lang) return [null, null];
    const native = ROMAN_OF[lang];
    const roman = Object.keys(ROMAN_OF).find((k) => ROMAN_OF[k] === lang);
    const order = settings.mixed === 'dominant' ? [native, lang, roman] : [lang, native, roman];
    for (const code of [...order, settings.fallback]) {
        if (code && code !== 'en' && translations[code]) return [code, translations[code]];
        if (code === 'en' && lang === 'en') return [null, null];
    }
    return [null, null];
}

/** Romanised forms and the language they write. */
const ROMAN_OF = { hinglish: 'hi', gujlish: 'gu' };

/** For the test console: the language and why it was picked. */
function languageNote(l) {
    if (!l) return '';
    const why = { fixed: 'business language', contact: 'saved for this contact', recent: 'from their recent messages' }[l.source]
        ?? `${Math.round((l.confidence ?? 0) * 100)}% sure`;
    return `${languageLabel(l.code)} (${why})`;
}

// Not CANCEL, QUIT or BAND KARO: those are opt-out words (optout.js), which run first and unsubscribe the contact.
/** "We reply in {langs}" in the customer's language (the note also goes in English). */
const LANGUAGE_NOTE = {
    en: 'Sorry, we can reply in {langs}. Please write to us in one of these.',
    pt: 'Desculpe, respondemos em {langs}. Por favor, escreva-nos em um desses idiomas.',
    es: 'Lo sentimos, respondemos en {langs}. Por favor, escríbenos en uno de estos idiomas.',
    fr: 'Désolé, nous répondons en {langs}. Merci de nous écrire dans l\'une de ces langues.',
    de: 'Entschuldigung, wir antworten auf {langs}. Bitte schreiben Sie uns in einer dieser Sprachen.',
    it: 'Ci dispiace, rispondiamo in {langs}. Scrivici in una di queste lingue.',
    nl: 'Sorry, wij antwoorden in {langs}. Schrijf ons alstublieft in een van deze talen.',
    id: 'Maaf, kami membalas dalam {langs}. Silakan tulis dalam salah satu bahasa ini.',
    tr: 'Üzgünüz, {langs} dilinde yanıt veriyoruz. Lütfen bu dillerden birinde yazın.',
    ru: 'Извините, мы отвечаем на: {langs}. Пожалуйста, напишите на одном из этих языков.',
    ar: 'عذرًا، نرد بـ {langs}. يرجى مراسلتنا بإحدى هذه اللغات.',
    hi: 'क्षमा करें, हम {langs} में जवाब देते हैं। कृपया इनमें से किसी भाषा में लिखें।',
    gu: 'માફ કરશો, અમે {langs} માં જવાબ આપીએ છીએ. કૃપા કરીને આમાંથી કોઈ ભાષામાં લખો.',
    mr: 'क्षमस्व, आम्ही {langs} मध्ये उत्तर देतो. कृपया यापैकी एका भाषेत लिहा.',
    bn: 'দুঃখিত, আমরা {langs} ভাষায় উত্তর দিই। অনুগ্রহ করে এর একটিতে লিখুন।',
    ta: 'மன்னிக்கவும், நாங்கள் {langs} மொழியில் பதிலளிக்கிறோம். தயவுசெய்து இவற்றில் ஒன்றில் எழுதுங்கள்.',
    te: 'క్షమించండి, మేము {langs}లో సమాధానం ఇస్తాము. దయచేసి వీటిలో ఒక భాషలో రాయండి.',
    ur: 'معذرت، ہم {langs} میں جواب دیتے ہیں۔ براہ کرم ان میں سے کسی زبان میں لکھیں۔',
};

const CANCEL_WORDS = new Set(['exit', 'exit form', 'rehne do', 'chhodo', 'रहने दो', 'रद्द']);

const ANSWER_HINTS = {
    text: 'Please type your answer.',
    name: 'Please send just your name.',
    phone: 'Please send a valid phone number, for example 9876543210.',
    email: 'Please send a valid email address, for example name@example.com.',
    number: 'Please send a number, for example 25.',
};

/** The cleaned answer for this question type, or null when it is not one. */
export function checkAnswer(type, body) {
    const text = String(body ?? '').trim();
    if (!text || text.length > 500) return null;
    if (type === 'phone') {
        const digits = text.replace(/\D/g, '');
        return digits.length >= 7 && digits.length <= 15 ? digits : null;
    }
    if (type === 'email') return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text) ? text.toLowerCase() : null;
    if (type === 'number') {
        const n = text.replace(/[,\s]/g, '');
        return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
    }
    if (type === 'name') {
        const name = text.replace(/^(my name is|i am|i'm|mera naam|naam)\s+/i, '').replace(/\s+(hai|he)$/i, '').trim();
        // "price kya hai" is a question, not a name: too many words, or a word that means something.
        const looksLikeName = name.split(/\s+/).length <= 4 && !hasWord(name, INTENT_WORDS);
        return looksLikeName && name.length <= 60 && /\p{L}/u.test(name) && !/\d/.test(name) ? name : null;
    }
    return text;
}

const label =(rule) => rule.name || rule.keywords?.[0] || rule.keyword || `Rule ${rule.id}`;

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

/**
 * Is the rule inside its own hours right now? The times are read in the zone
 * they were picked in (the browser's, saved with the schedule); older rules
 * without one use the number's zone.
 */
function scheduleOpen(rule, ctx) {
    if (!rule.schedule) return true;
    const clock = rule.schedule.timezone ? localClock(ctx.now, rule.schedule.timezone) : ctx.clock;
    return inWindow(clock, rule.schedule);
}

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
