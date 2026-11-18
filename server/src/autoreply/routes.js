/**
 * HTTP for auto-replies. Mounted per channel runtime (paths carry no /api).
 *
 * POST /auto-replies/test is the operator's dry run: the whole pipeline -
 * menus, handoff, welcome, away, HELP, FAQ, rules, fallback - for a sample
 * message, sender and time, without sending and without moving counters.
 */

import express from 'express';

import { isHelp, helpText } from '../help.js';
import { localClock } from './engine.js';
import { INTENTS } from './intents.js';
import { LANGUAGES } from './language.js';
import { MESSAGE_TYPES } from './match.js';
import { SYSTEM_SWITCH, featureRefusal, ruleKind, ruleRefusal, systemAllowed } from './policy.js';
import { AutoReplyStore, EMPTY_STATS, SYSTEM_KEYS, validateRule } from './store.js';

export function createAutoReplyRouter({ db, state }) {
    const app = express.Router();
    const store = new AutoReplyStore(db);

    const clock = () => localClock(new Date(), state.channel?.timezone || 'UTC');
    const stats = () => store.stats(new Date(), clock().dayStart);
    const withStats = (rule, all = stats()) => ({ ...rule, stats: all[`rule:${rule.id}`] ?? { ...EMPTY_STATS } });
    const mediaInfo = (media) => {
        if (!media?.mediaId) return null;
        const found = state.media?.get(media.mediaId);
        return { mediaId: media.mediaId, filename: found?.filename ?? media.filename, mimetype: found?.mimetype ?? media.mimetype, url: `/api/media/${media.mediaId}` };
    };

    app.get('/auto-replies', (req, res) => {
        const all = stats();
        // Platform rules the tenant inherits and cannot remove (shown locked in the UI).
        res.json({
            rules: store.list().map((r) => withStats(r, all)),
            platformOptOutWords: state.platformPolicy?.()['autoReplies.optOutWords'] ?? [],
            // What the editor offers: the built-in intents (with a few sample words) and the reply languages.
            intents: Object.entries(INTENTS).map(([id, i]) => ({ id, label: i.label, examples: i.words.slice(0, 4), words: i.words })),
            languages: LANGUAGES,
            messageTypes: MESSAGE_TYPES,
        });
    });

    app.post('/auto-replies', (req, res) => {
        const rule = validateRule(req.body ?? {});
        if (rule.errors) return res.status(400).json({ errors: rule.errors });
        const refusal = ruleRefusal(rule, state.platformPolicy?.(), store.list().length);
        if (refusal) return res.status(403).json({ errors: [refusal] });
        const saved = store.save({ ...rule, priority: req.body?.priority });
        return res.status(201).json({ rule: withStats(saved) });
    });

    // The Activity log: what the automation did with each message, newest first.
    app.get('/auto-replies/log', (req, res) => {
        res.json({ log: store.recentLog({ limit: req.query.limit, outcome: req.query.outcome || null }) });
    });

    /** The Reports tab, over the last `days` (1..90, default 7) in the number's time zone. */
    app.get('/auto-replies/report', (req, res) => {
        const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
        const now = new Date();
        const since = new Date(now.getTime() - (days - 1) * 86_400_000);
        since.setUTCHours(0, 0, 0, 0);
        res.json({ days, ...store.report(since, now, state.channel?.timezone || 'UTC') });
    });

    app.post('/auto-replies/reorder', (req, res) => {
        if (!Array.isArray(req.body?.ids)) return res.status(400).json({ errors: ['ids must be an array of rule ids'] });
        const all = stats();
        return res.json({ rules: store.reorder(req.body.ids).map((r) => withStats(r, all)) });
    });

    app.get('/auto-replies/settings', (req, res) => {
        const all = stats();
        res.json({
            settings: { ...store.settings(), timezone: state.channel?.timezone || 'UTC' },
            stats: Object.fromEntries(SYSTEM_KEYS.map((k) => [k, all[k] ?? { ...EMPTY_STATS }])),
        });
    });

    app.put('/auto-replies/settings', (req, res) => {
        const { timezone, ...patch } = req.body ?? {};
        void timezone; // read-only: it is the channel's
        const policy = state.platformPolicy?.() ?? {};
        const blocked = Object.keys(SYSTEM_SWITCH).find((key) => patch[key]?.enabled === true && !systemAllowed(key, policy));
        if (blocked) return res.status(403).json({ errors: [`The ${blocked} message is not included in your plan.`] });
        return res.json({ settings: { ...store.saveSettings(patch), timezone: state.channel?.timezone || 'UTC' } });
    });

    app.put('/auto-replies/:id', (req, res) => {
        const current = store.get(req.params.id);
        if (!current) return res.status(404).json({ errors: ['rule not found'] });
        const body = req.body ?? {};
        // A v1 client sends keyword/replyBody only: those replace the first keyword/variant.
        const merged = { ...current, ...body };
        if (body.keyword !== undefined && body.keywords === undefined) merged.keywords = [body.keyword, ...current.keywords.slice(1)];
        if (body.replyBody !== undefined && body.variants === undefined) merged.variants = [body.replyBody, ...current.variants.slice(1)];
        const rule = validateRule(merged);
        if (rule.errors) return res.status(400).json({ errors: rule.errors });
        // Editing never counts against the cap; a change into a disallowed kind is refused, and so is anything
        // the plan's feature switches and limits leave out.
        const policy = state.platformPolicy?.() ?? {};
        const refusal = featureRefusal(rule, policy) ?? (ruleKind(rule) !== ruleKind(current) ? ruleRefusal(rule, policy, 0) : null);
        if (refusal) return res.status(403).json({ errors: [refusal] });
        return res.json({ rule: withStats(store.save({ ...rule, id: current.id, priority: body.priority ?? current.priority })) });
    });

    app.delete('/auto-replies/:id', (req, res) => {
        res.json({ deleted: store.remove(req.params.id) });
    });

    app.post('/auto-replies/preview', (req, res) => {
        const { template = '', sender = '15551234567', senderName = 'Valued Customer' } = req.body ?? {};
        res.json({ preview: state.autoReply.formatResponse(template, { sender, senderName, body: '' }) });
    });

    app.post('/auto-replies/test', (req, res) => {
        const b = req.body ?? {};
        const body = String(b.body ?? '');
        const sender = String(b.sender ?? '').replace(/[^\d]/g, '') || '15551234567';
        const at = b.at ? new Date(b.at) : new Date();
        if (Number.isNaN(at.getTime())) return res.status(400).json({ errors: ['at must be a date-time'] });
        const msg = { sender, senderName: String(b.senderName ?? ''), body, messageId: `test.${Date.now()}`, replyId: b.replyId ?? null,
            // Try a photo, voice note or location against message-type rules.
            mediaType: MESSAGE_TYPES.includes(b.mediaType) ? b.mediaType : null };
        const firstContact = typeof b.firstContact === 'boolean' ? b.firstContact : null;
        const tags = Array.isArray(b.tags) ? b.tags.map(String) : null;
        const session = b.session && Number.isInteger(Number(b.session.ruleId))
            ? {
                ruleId: Number(b.session.ruleId), path: Array.isArray(b.session.path) ? b.session.path.map(String) : [], expiresAt: b.session.expiresAt ?? null,
                // A rule's questions in progress: which one, and the answers so far.
                flow: b.session.flow && typeof b.session.flow === 'object' ? {
                    step: Number(b.session.flow.step) || 0, tries: Number(b.session.flow.tries) || 0,
                    answers: b.session.flow.answers && typeof b.session.flow.answers === 'object' ? b.session.flow.answers : {},
                } : null,
            }
            : null;

        // What sits between the two engine stages in the live path.
        const between = (m) => {
            if (isHelp(m.body)) {
                const text = helpText(state);
                if (text) return reply('help', 'HELP list', text, 'HELP: the keyword list');
            }
            const hit = state.knowledge?.answer?.(m.body, { channel: state.channel, now: at, record: false });
            if (hit?.item) return reply('faq', hit.item.question || `FAQ ${hit.item.id}`, hit.item.answer, `Answered by the FAQ (${hit.level})`);
            return null;
        };
        const plan = state.autoReply.plan(msg, { now: at, stage: 'all', firstContact, tags, session, between });
        const nextSession = plan.session === undefined ? session : plan.session;
        res.json({
            replies: plan.replies.map((r) => ({
                source: r.source, ruleId: r.ruleId ?? null, ruleName: r.ruleName ?? '', text: r.text,
                media: mediaInfo(r.media), interactive: r.interactive ?? null, fallbackText: r.fallbackText ?? r.text,
            })),
            actions: plan.actions.map(({ type, detail }) => ({ type, detail })),
            trace: plan.trace,
            matched: plan.matched,
            context: plan.context,
            session: nextSession
                ? { ruleId: nextSession.ruleId, path: nextSession.path ?? [], flow: nextSession.flow ?? null, expiresAt: nextSession.expiresAt ?? new Date(at.getTime() + 30 * 60_000).toISOString() }
                : null,
        });
    });

    return app;
}

function reply(source, ruleName, text, note) {
    return { source, ruleId: null, ruleName, key: source, text, media: null, interactive: null, fallbackText: text, note };
}
