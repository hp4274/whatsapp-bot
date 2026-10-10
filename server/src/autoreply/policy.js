/**
 * Platform policy (`autoReplies.*`, see policy/autoreplies.js) applied to auto-replies.
 * Values come from `deps.platformPolicy()`; a missing key means "no restriction".
 */

import { inWindow } from './engine.js';

/** 'menu' (buttons/list with follow-ups), 'fallback', else 'keyword'. */
export function ruleKind(rule) {
    if (rule.interactive && Object.keys(rule.menu ?? {}).length) return 'menu';
    return String(rule.matchType).toUpperCase() === 'FALLBACK' ? 'fallback' : 'keyword';
}

/** Is a rule of this kind allowed on the plan? Existing disallowed rules are skipped at match time. */
export function kindAllowed(rule, policy = {}) {
    const kind = ruleKind(rule);
    if (kind === 'menu') return policy['autoReplies.allowMenus'] !== false;
    if (kind === 'keyword') return policy['autoReplies.allowKeywords'] !== false;
    return true;
}

/** Plain-sentence refusal for saving `rule`, or null. `count` = rules the tenant already has (0 when editing). */
export function ruleRefusal(rule, policy = {}, count = 0) {
    const max = Number(policy['autoReplies.maxRules'] ?? 0);
    if (max > 0 && count >= max) return `Your plan allows ${max} auto-reply rule${max === 1 ? '' : 's'}; delete one or ask for a bigger plan.`;
    const kind = ruleKind(rule);
    if (kind === 'menu' && !kindAllowed(rule, policy)) return 'Menus are not included in your plan.';
    if (kind === 'keyword' && !kindAllowed(rule, policy)) return 'Keyword rules are not included in your plan.';
    return null;
}

/** Inside the platform quiet window (overnight windows allowed) in the channel's local clock. */
export function inQuietHours(policy = {}, clock) {
    if (!policy['autoReplies.quietHoursEnabled']) return false;
    return inWindow(clock, { days: null, start: policy['autoReplies.quietStart'] ?? '22:00', end: policy['autoReplies.quietEnd'] ?? '07:00' });
}

/** Normalised platform opt-out words, same folding as optout.js. */
export const platformOptOut = (policy = {}) => (policy['autoReplies.optOutWords'] ?? [])
    .map((w) => String(w).toLowerCase().replace(/['’]/g, '').replace(/[-_\s]+/g, ' ').trim()).filter(Boolean);
