/**
 * What happens after a campaign with buttons goes out.
 *
 * Every successful send that carried an interactive block is written to
 * `interactive_sends`. When that recipient answers - a native button/list tap
 * on the Cloud API, or "1" / the option title typed on WhatsApp Web - the
 * inbound path asks `handleInteractiveReply`, which records a `button_clicks`
 * row (once per inbound message id, so a redelivered webhook is a no-op) and
 * runs the campaign's reply rules: tag, set a field, send a follow-up, mute
 * bulk for N days, opt out, or hand the conversation to a human.
 *
 * Rules are keyed by the manager's campaign id string ('camp-7' for a saved
 * campaign, a random id for a quick /campaign/start), with 'default' as the
 * tenant-wide fallback.
 */

import express from 'express';

import { personalize, utcNow } from '../protocol.js';
import { campaignKey } from '../campaigns/store.js';
import { InteractiveError, matchReply } from './interactive.js';
import { MessageJobError } from './job.js';

export const INTERACTIVE_SCHEMA = `
CREATE TABLE IF NOT EXISTS interactive_sends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    channel_id INTEGER,
    recipient TEXT NOT NULL,
    campaign_id TEXT,
    message_id TEXT,
    interactive TEXT NOT NULL,
    sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interactive_sends_recipient ON interactive_sends(tenant_id, recipient, sent_at);
CREATE TABLE IF NOT EXISTS button_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    channel_id INTEGER,
    campaign_id TEXT,
    recipient TEXT NOT NULL,
    option_id TEXT,
    option_title TEXT,
    payload TEXT,
    message_id TEXT,
    inbound_message_id TEXT NOT NULL,
    actions TEXT NOT NULL DEFAULT '[]',
    at TEXT NOT NULL,
    UNIQUE (tenant_id, inbound_message_id)
);
CREATE INDEX IF NOT EXISTS idx_button_clicks_campaign ON button_clicks(tenant_id, campaign_id, at);
CREATE TABLE IF NOT EXISTS campaign_reply_rules (
    tenant_id INTEGER NOT NULL,
    campaign_id TEXT NOT NULL,
    rules TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL,
    PRIMARY KEY (tenant_id, campaign_id)
);
CREATE TABLE IF NOT EXISTS bulk_mutes (
    tenant_id INTEGER NOT NULL,
    phone TEXT NOT NULL,
    until TEXT NOT NULL,
    PRIMARY KEY (tenant_id, phone)
);
`;

/** How long after a send a reply still counts as an answer to it. */
export const REPLY_WINDOW_DAYS = 7;
export const DEFAULT_RULES_KEY = 'default';
const ACTION_TYPES = ['send_message', 'add_tag', 'remove_tag', 'set_field', 'mute_days', 'opt_out', 'escalate'];

const isoAt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, '+00:00');
const parse = (text, fallback) => {
    try { return JSON.parse(text); } catch { return fallback; }
};
const tagList = (value) => (Array.isArray(value) ? value : String(value ?? '').split(','))
    .map((t) => String(t).trim()).filter(Boolean).slice(0, 20);

/** Validate a replyRules array from a request. Throws InteractiveError (400). */
export function normalizeReplyRules(input) {
    if (input == null) return [];
    if (!Array.isArray(input)) throw new InteractiveError('replyRules must be an array.');
    if (input.length > 30) throw new InteractiveError('At most 30 reply rules per campaign.');
    return input.map((rule, i) => {
        const optionId = String(rule?.optionId ?? '').trim().slice(0, 200);
        if (!optionId) throw new InteractiveError(`Reply rule ${i + 1} needs an optionId (or "any").`);
        const actions = (Array.isArray(rule.actions) ? rule.actions : []).slice(0, 10).map((a) => {
            const type = String(a?.type ?? '');
            if (!ACTION_TYPES.includes(type)) throw new InteractiveError(`Unknown reply action "${type}".`);
            switch (type) {
                case 'send_message': {
                    const text = String(a.text ?? '').trim().slice(0, 4096);
                    if (!text) throw new InteractiveError('A follow-up message needs text.');
                    return { type, text };
                }
                case 'add_tag':
                case 'remove_tag': {
                    const tags = tagList(a.tags ?? a.tag);
                    if (!tags.length) throw new InteractiveError('A tag action needs at least one tag.');
                    return { type, tags };
                }
                case 'set_field': {
                    const key = String(a.key ?? '').trim().slice(0, 64);
                    if (!key) throw new InteractiveError('Set field needs a field name.');
                    return { type, key, value: String(a.value ?? '').slice(0, 500) };
                }
                case 'mute_days': {
                    const days = Math.round(Number(a.days));
                    if (!(days >= 1 && days <= 365)) throw new InteractiveError('Mute days must be between 1 and 365.');
                    return { type, days };
                }
                case 'escalate':
                    return { type, assignTo: a.assignTo ? String(a.assignTo).trim() : null, ticket: Boolean(a.ticket) };
                default:
                    return { type };
            }
        });
        return { optionId, actions };
    }).filter((rule) => rule.actions.length);
}

/** Route param -> the manager's campaign id: '7' -> 'camp-7'. */
export const campaignIdFromParam = (param) => {
    const value = String(param ?? '').trim();
    return /^\d+$/.test(value) ? campaignKey(value) : value;
};

export class InteractiveStore {
    /** @param {import('../db.js').Database} database a tenant (and channel) scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? null;
    }

    recordSend({ recipient, campaignId = null, messageId = null, interactive, channelId = this.channelId, at = utcNow() }) {
        this.db.prepare(`INSERT INTO interactive_sends (tenant_id, channel_id, recipient, campaign_id, message_id, interactive, sent_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, channelId, String(recipient), campaignId || null, messageId, JSON.stringify(interactive), at);
    }

    /** The most recent interactive message this number got inside the reply window. */
    latestSend(recipient, { days = REPLY_WINDOW_DAYS } = {}) {
        const row = this.db.prepare(`SELECT * FROM interactive_sends WHERE tenant_id = ? AND recipient = ? AND sent_at >= ?
                                     ORDER BY sent_at DESC, id DESC LIMIT 1`)
            .get(this.tenantId, String(recipient), isoAt(Date.now() - days * 86400000));
        return row ? { ...row, interactive: parse(row.interactive, null) } : null;
    }

    /** Insert once per inbound message. Returns false when it was already recorded. */
    recordClick({ campaignId, recipient, option, messageId, inboundMessageId, channelId = this.channelId }) {
        return this.db.prepare(`INSERT OR IGNORE INTO button_clicks
                (tenant_id, channel_id, campaign_id, recipient, option_id, option_title, payload, message_id, inbound_message_id, at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, channelId, campaignId || null, String(recipient), option.id, option.title, option.payload,
                messageId, inboundMessageId, utcNow()).changes > 0;
    }

    clickFor(inboundMessageId) {
        const row = this.db.prepare('SELECT * FROM button_clicks WHERE tenant_id = ? AND inbound_message_id = ?')
            .get(this.tenantId, inboundMessageId);
        return row ? { ...row, actions: parse(row.actions, []) } : null;
    }

    setClickActions(inboundMessageId, actions) {
        this.db.prepare('UPDATE button_clicks SET actions = ? WHERE tenant_id = ? AND inbound_message_id = ?')
            .run(JSON.stringify(actions), this.tenantId, inboundMessageId);
    }

    /** Analytics for one campaign: totals, per option, latest clicks. */
    clicks(campaignId, { limit = 50 } = {}) {
        const args = [this.tenantId, campaignId];
        const total = this.db.prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT recipient) AS people FROM button_clicks WHERE tenant_id = ? AND campaign_id = ?').get(...args);
        const byOption = this.db.prepare(`SELECT option_id AS id, option_title AS title, COUNT(*) AS count FROM button_clicks
                                          WHERE tenant_id = ? AND campaign_id = ? GROUP BY option_id ORDER BY count DESC, option_id`)
            .all(...args).map((r) => ({ id: r.id, title: r.title, count: r.count }));
        const sent = this.db.prepare('SELECT COUNT(*) AS n FROM interactive_sends WHERE tenant_id = ? AND campaign_id = ?').get(...args).n;
        const recent = this.db.prepare(`SELECT * FROM button_clicks WHERE tenant_id = ? AND campaign_id = ? ORDER BY at DESC, id DESC LIMIT ?`)
            .all(...args, Math.min(Number(limit) || 50, 500))
            .map((r) => ({
                recipient: r.recipient, optionId: r.option_id, title: r.option_title, payload: r.payload,
                messageId: r.message_id, at: r.at, actions: parse(r.actions, []),
            }));
        return { campaignId, sent, total: total.n, uniqueRecipients: total.people, byOption, recent };
    }

    rules(campaignId) {
        const row = this.db.prepare('SELECT rules FROM campaign_reply_rules WHERE tenant_id = ? AND campaign_id = ?')
            .get(this.tenantId, campaignId);
        return row ? parse(row.rules, []) : [];
    }

    setRules(campaignId, rules) {
        this.db.prepare(`INSERT INTO campaign_reply_rules (tenant_id, campaign_id, rules, updated_at) VALUES (?, ?, ?, ?)
                         ON CONFLICT(tenant_id, campaign_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`)
            .run(this.tenantId, campaignId, JSON.stringify(rules), utcNow());
        return rules;
    }

    /** The campaign's own rules, else the tenant default. */
    effectiveRules(campaignId) {
        const own = campaignId ? this.rules(campaignId) : [];
        return own.length ? own : this.rules(DEFAULT_RULES_KEY);
    }

    mute(phone, days) {
        const until = isoAt(Date.now() + days * 86400000);
        this.db.prepare(`INSERT INTO bulk_mutes (tenant_id, phone, until) VALUES (?, ?, ?)
                         ON CONFLICT(tenant_id, phone) DO UPDATE SET until = excluded.until`)
            .run(this.tenantId, String(phone), until);
        return until;
    }
}

/**
 * Inbound hook, called right after opt-out handling. Returns
 * `{ handled: true }` when the message answered an interactive menu and a
 * reply rule acted on it (the caller then skips HELP/FAQ/auto-replies);
 * `{ handled: false, click }` when it was a click without a rule, so normal
 * auto-replies still run.
 */
export async function handleInteractiveReply(state, saved, replyId = null) {
    const store = state.interactions;
    if (!store) return { handled: false };
    const send = store.latestSend(saved.sender);
    if (!send?.interactive) return { handled: false };
    const option = matchReply(send.interactive, { body: saved.body, replyId });
    if (!option) return { handled: false };

    if (!store.recordClick({
        campaignId: send.campaign_id, recipient: saved.sender, option,
        messageId: send.message_id, inboundMessageId: saved.messageId,
    })) {
        // Redelivered webhook: already counted and acted on.
        const previous = store.clickFor(saved.messageId);
        return { handled: Boolean(previous?.actions?.length), duplicate: true };
    }
    state.broadcast?.({ type: 'button_click', sender: saved.sender, campaignId: send.campaign_id, option });

    const rules = store.effectiveRules(send.campaign_id);
    const specific = rules.filter((r) => r.optionId === option.id || r.optionId === option.payload);
    const matched = specific.length ? specific : rules.filter((r) => r.optionId === 'any');
    const actions = matched.flatMap((r) => r.actions);
    if (!actions.length) return { handled: false, click: option };

    const results = await runActions(state, { saved, option, actions, campaignId: send.campaign_id });
    store.setClickActions(saved.messageId, results);
    state.db.markInboundReplied?.(saved.messageId, `button:${option.id}`);
    return { handled: true, click: option, results };
}

async function runActions(state, { saved, option, actions, campaignId }) {
    const phone = saved.sender;
    const results = [];
    const contactFor = () => state.contacts?.getByPhone(phone) ?? null;
    for (const [i, action] of actions.entries()) {
        try {
            results.push({ type: action.type, ok: true, ...await runAction(state, { action, i, phone, saved, option, campaignId, contactFor }) });
        } catch (err) {
            results.push({ type: action.type, ok: false, error: err.message ?? String(err) });
        }
    }
    return results;
}

async function runAction(state, { action, i, phone, saved, option, campaignId, contactFor }) {
    switch (action.type) {
        case 'send_message': {
            const contact = contactFor();
            const text = personalize(action.text, {
                ...(contact?.customFields ?? {}),
                name: contact?.name || saved.senderName || '',
                phone,
                option: option.title,
                payload: option.payload,
            });
            try {
                const outcome = state.messages.send({
                    messageType: 'auto_reply', recipient: phone, text,
                    campaignId: campaignId || '', idempotencyKey: `rule.${saved.messageId}.${i}`,
                });
                return { messageId: outcome.messageId, accepted: outcome.accepted, reason: outcome.reason };
            } catch (err) {
                if (err instanceof MessageJobError) return { accepted: false, reason: err.reason ?? err.message };
                throw err;
            }
        }
        case 'add_tag':
            return { contactId: state.contacts.upsert({ phone, normalized: true, name: contactFor()?.name ?? saved.senderName, tags: action.tags }).id };
        case 'remove_tag': {
            const contact = contactFor();
            if (contact) state.contacts.removeTags(contact.id, action.tags);
            return { contactId: contact?.id ?? null };
        }
        case 'set_field':
            return {
                contactId: state.contacts.upsert({
                    phone, normalized: true, name: contactFor()?.name ?? saved.senderName,
                    customFields: { [action.key]: personalize(action.value, { option: option.title, payload: option.payload }) },
                }).id,
            };
        case 'mute_days':
            return { until: state.interactions.mute(phone, action.days) };
        case 'opt_out':
            state.db.addOptOut(phone, 'reply_rule');
            return {};
        case 'escalate': {
            const conversations = state.conversations;
            let conversation = conversations.getByPhone(phone, state.channel.id)
                ?? conversations.upsertForInbound({ phone, channelId: state.channel.id });
            conversation = conversations.setStatus(conversation.id, 'open');
            const assignee = Number(action.assignTo);
            conversation = action.assignTo && Number.isInteger(assignee)
                ? conversations.assign(conversation.id, assignee)
                : conversations.unassign(conversation.id);
            conversations.pauseBot(conversation.id);
            let ticketId = null;
            if (action.ticket && state.tickets) {
                ticketId = state.tickets.create({
                    conversationId: conversation.id,
                    contactId: contactFor()?.id ?? null,
                    channelId: state.channel.id,
                    assignedTo: Number.isInteger(assignee) ? assignee : null,
                    source: 'keyword',
                    category: 'campaign_reply',
                    subject: `Replied "${option.title}" to campaign ${campaignId ?? ''}`.trim(),
                }).id;
            }
            state.broadcast?.({ type: 'escalated', sender: phone, conversationId: conversation.id, ticketId });
            return { conversationId: conversation.id, ticketId };
        }
        default:
            throw new Error(`unknown action ${action.type}`);
    }
}

/** GET clicks, GET/PUT reply rules. Mounted per channel under /api. */
export function createInteractiveRouter({ state }) {
    const router = express.Router();
    const store = () => state.interactions;

    router.get('/campaigns/:campaignId/clicks', (req, res) => {
        res.json(store().clicks(campaignIdFromParam(req.params.campaignId), { limit: req.query.limit }));
    });

    router.get('/campaigns/:campaignId/reply-rules', (req, res) => {
        const campaignId = campaignIdFromParam(req.params.campaignId);
        res.json({ campaignId, rules: store().rules(campaignId) });
    });

    router.put('/campaigns/:campaignId/reply-rules', (req, res) => {
        const campaignId = campaignIdFromParam(req.params.campaignId);
        try {
            const rules = normalizeReplyRules(req.body?.rules ?? req.body?.replyRules ?? []);
            return res.json({ campaignId, rules: store().setRules(campaignId, rules) });
        } catch (err) {
            if (err instanceof InteractiveError) return res.status(400).json({ errors: [err.message] });
            throw err;
        }
    });

    return router;
}
