/**
 * HELP: one reply that lists every keyword a customer can use - the school
 * commands, the tenant's auto-reply keywords, and the FAQ questions it answers.
 * Called from `handleInbound` ahead of every engine, so it is the same word on
 * all of them.
 */

import { SCHOOL_HELP_LINES } from './school/commands.js';
import { getSettings } from './school/settings.js';
import { normalizeInboundText } from './autoreply/engine.js';
import { AutoReplyStore } from './autoreply/store.js';

const HELP_WORDS = new Set(['help', 'menu', 'commands']);
const MAX_KEYWORDS = 15;
const MAX_QUESTIONS = 8;

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

    const keywords = [...new Set(rules
        .filter((r) => r.matchType !== 'FALLBACK' && r.matchType !== 'REGEX')
        .flatMap((r) => words(r).map((k) => String(k).trim().toLowerCase()))
        .filter(Boolean))].slice(0, MAX_KEYWORDS);
    if (keywords.length) out.push('', 'Quick replies', keywords.join(', '));

    const questions = (state.knowledge?.list({ activeOnly: true }) ?? [])
        .map((q) => String(q.question ?? '').trim()).filter(Boolean).slice(0, MAX_QUESTIONS);
    if (questions.length) out.push('', 'Ask us', ...questions.map((q) => `- ${q}`));

    const handoff = new AutoReplyStore(state.db).settings().handoff;
    out.push('', 'HELP - this list');
    if (handoff.enabled && handoff.keywords.length) out.push(`${handoff.keywords[0].toUpperCase()} - talk to a person`);
    out.push('STOP - stop receiving messages');
    return out.join('\n');
}
