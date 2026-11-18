/**
 * HELP: one reply that lists every keyword a customer can use - the school
 * commands, the tenant's auto-reply keywords, and the FAQ questions it answers.
 * Called from `handleInbound` ahead of every engine, so it is the same word on
 * all of them.
 */

import { SCHOOL_HELP_LINES } from './school/commands.js';
import { getSettings } from './school/settings.js';
import { normalizeInboundText } from './autoreply/engine.js';
import { INTENTS } from './autoreply/intents.js';
import { AutoReplyStore } from './autoreply/store.js';
import { shopHelpLines, usableModes } from './shop/bot.js';

const HELP_WORDS = new Set(['help', 'menu', 'commands']);
const MAX_KEYWORDS = 15;
const MAX_QUESTIONS = 8;

/**
 * What a rule is for, in a few words: its name when it has one (other than the keyword itself), else the start
 * of its reply with {variables} left out.
 */
function ruleUse(rule, word) {
    const name = String(rule.name ?? '').trim();
    if (name && name.toLowerCase() !== word) return name;
    const reply = String(rule.variants?.[0] ?? rule.replyBody ?? '')
        .replace(/\{[^}]*\}/g, '').replace(/\s+/g, ' ').trim()
        // "{time_greeting} {name}, thank you..." leaves a comma in front once the variables are out.
        .replace(/^[\s,.;:!-]+/, '').split(/(?<=[.!?])\s/)[0];
    const sentence = reply.charAt(0).toUpperCase() + reply.slice(1);
    return sentence.length > 48 ? `${sentence.slice(0, 47).trimEnd()}…` : sentence || 'Quick reply';
}

/** True when the message is just the help word. */
export const isHelp = (body) => HELP_WORDS.has(normalizeInboundText(body));

/**
 * @returns {string|null} null when the tenant has its own rule for the word:
 *   a custom "help" auto-reply wins over this generic list.
 */
export function helpText(state) {
    const rules = state.db.getActiveAutoReplies();
    const words = (r) => (r.keywords?.length ? r.keywords : [r.keyword]);
    if (rules.some((r) => r.matchType !== 'REGEX' && words(r).some((k) => HELP_WORDS.has(normalizeInboundText(k))))) return null;

    const settings = getSettings(state.db.db, state.db.tenantId);
    const tenant = state.tenancy?.getTenant(state.db.tenantId);
    const school = tenant?.services.includes('school_whatsapp_bot') && settings.commandsEnabled;

    const out = [`${settings.schoolName || 'Reply with a keyword'}:`];
    if (school) out.push('', 'School', ...SCHOOL_HELP_LINES);

    // One line per rule: the word to send, and what it gets them ("PRICING - Our price list").
    const seen = new Set();
    const lines = [];
    for (const r of rules) {
        if (['FALLBACK', 'REGEX', 'MESSAGE_TYPE'].includes(String(r.matchType).toUpperCase())) continue;
        const raw = String(words(r)[0] ?? '').trim();
        // An intent rule's keyword is an id ("order_status"): show a word that means it.
        const word = (String(r.matchType).toUpperCase() === 'INTENT' ? INTENTS[raw]?.words[0] ?? raw : raw).toLowerCase();
        if (!word || seen.has(word)) continue;
        seen.add(word);
        lines.push(`- ${word.toUpperCase()} - ${ruleUse(r, word)}`);
        if (lines.length >= MAX_KEYWORDS) break;
    }
    const shop = shopHelpLines(usableModes(state));
    if (shop.length) out.push('', 'Orders & bookings', ...shop);
    if (lines.length) out.push('', 'Quick replies', ...lines);

    const questions = (state.knowledge?.list({ activeOnly: true }) ?? [])
        .map((q) => String(q.question ?? '').trim()).filter(Boolean).slice(0, MAX_QUESTIONS);
    if (questions.length) out.push('', 'Ask us', ...questions.map((q) => `- ${q}`));

    const handoff = new AutoReplyStore(state.db).settings().handoff;
    out.push('', 'HELP - this list');
    if (handoff.enabled && handoff.keywords.length) out.push(`${handoff.keywords[0].toUpperCase()} - talk to a person`);
    out.push('STOP - stop receiving messages');
    return out.join('\n');
}
