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

/** The refusal when a plan switch this rule needs (its trigger, its questions) is off, else null. */
function featureOff(rule, policy) {
    const type = String(rule.matchType).toUpperCase();
    if (type === 'INTENT' && policy['autoReplies.allowIntents'] === false) return 'Intent rules are not included in your plan.';
    if (type === 'MESSAGE_TYPE' && policy['autoReplies.allowMessageTypes'] === false) return 'Message-type rules are not included in your plan.';
    if (rule.collect?.questions?.length && policy['autoReplies.allowQuestions'] === false) return 'Asking questions is not included in your plan.';
    return null;
}

/** Is a rule of this kind allowed on the plan? Existing disallowed rules are skipped at match time. */
export function kindAllowed(rule, policy = {}) {
    if (featureOff(rule, policy)) return false;
    const kind = ruleKind(rule);
    if (kind === 'menu') return policy['autoReplies.allowMenus'] !== false;
    if (kind === 'keyword') return policy['autoReplies.allowKeywords'] !== false;
    return true;
}

/** Plain-sentence refusal for saving `rule`, or null. `count` = rules the tenant already has (0 when editing). */
export function ruleRefusal(rule, policy = {}, count = 0) {
    const max = Number(policy['autoReplies.maxRules'] ?? 0);
    if (max > 0 && count >= max) return `Your plan allows ${max} auto-reply rule${max === 1 ? '' : 's'}; delete one or ask for a bigger plan.`;
    const refusal = featureRefusal(rule, policy);
    if (refusal) return refusal;
    const kind = ruleKind(rule);
    if (kind === 'menu' && !kindAllowed(rule, policy)) return 'Menus are not included in your plan.';
    if (kind === 'keyword' && !kindAllowed(rule, policy)) return 'Keyword rules are not included in your plan.';
    return null;
}

/** What the plan's feature switches and limits refuse in a rule (checked on every save, edits too), or null. */
export function featureRefusal(rule, policy = {}) {
    const off = featureOff(rule, policy);
    if (off) return off;
    const limit = (key) => Number(policy[key] ?? 0);
    const questions = rule.collect?.questions?.length ?? 0;
    if (limit('autoReplies.maxQuestions') > 0 && questions > limit('autoReplies.maxQuestions')) {
        return `Your plan allows ${limit('autoReplies.maxQuestions')} questions per rule.`;
    }
    if (limit('autoReplies.maxVariants') > 0 && (rule.variants?.length ?? 0) > limit('autoReplies.maxVariants')) {
        return `Your plan allows ${limit('autoReplies.maxVariants')} reply variants per rule.`;
    }
    const languages = Object.keys(rule.translations ?? {}).length;
    if (languages && policy['autoReplies.allowTranslations'] === false) return 'Replies in other languages are not included in your plan.';
    if (limit('autoReplies.maxLanguages') > 0 && languages > limit('autoReplies.maxLanguages')) {
        return `Your plan allows ${limit('autoReplies.maxLanguages')} languages per reply.`;
    }
    return null;
}

/** Inside the platform quiet window (overnight windows allowed) in the channel's local clock. */
export function inQuietHours(policy = {}, clock) {
    if (!policy['autoReplies.quietHoursEnabled']) return false;
    return inWindow(clock, { days: null, start: policy['autoReplies.quietStart'] ?? '22:00', end: policy['autoReplies.quietEnd'] ?? '07:00' });
}

/** The four system replies and the plan switch each needs. */
export const SYSTEM_SWITCH = Object.freeze({
    welcome: 'autoReplies.allowWelcome', away: 'autoReplies.allowAway',
    fallback: 'autoReplies.allowFallback', handoff: 'autoReplies.allowHandoff',
});

/** Is this system reply (welcome, away, fallback, handoff) on the plan? */
export const systemAllowed = (key, policy = {}) => policy[SYSTEM_SWITCH[key]] !== false;

/**
 * Business settings with the plan applied: a system reply the plan leaves out is off, the bot pause and the
 * automatic handover are capped, the reply delay sits inside the platform range.
 */
export function effectiveSettings(settings, policy = {}) {
    const out = { ...settings };
    for (const key of Object.keys(SYSTEM_SWITCH)) {
        if (!systemAllowed(key, policy) && out[key]) out[key] = { ...out[key], enabled: false };
    }
    const cap = (value, key, fallback) => Math.min(Number(value ?? 0), Number(policy[key] ?? fallback));
    if (out.handoff) out.handoff = { ...out.handoff, pauseHours: cap(out.handoff.pauseHours, 'autoReplies.maxPauseHours', 72) };
    if (out.fallback) out.fallback = { ...out.fallback, handoffAfter: cap(out.fallback.handoffAfter, 'autoReplies.maxHandoffAfter', 5) };
    const lo = Number(policy['autoReplies.minDelaySec'] ?? 0);
    const hi = Math.max(lo, Number(policy['autoReplies.maxDelaySec'] ?? 10));
    out.delaySec = Math.min(hi, Math.max(lo, Number(settings.delaySec ?? 1)));
    return out;
}

/** Normalised platform opt-out words, same folding as optout.js. */
export const platformOptOut = (policy = {}) => (policy['autoReplies.optOutWords'] ?? [])
    .map((w) => String(w).toLowerCase().replace(/['’]/g, '').replace(/[-_\s]+/g, ' ').trim()).filter(Boolean);
