/**
 * Platform rules for templates (fields in policy/templates.js): content rules
 * checked on save, the spam score, and the review gate checked on send.
 * Pure functions - app.js feeds them the tenant's effective policy values and
 * the legacy per-tenant `limits`.
 */

import { QR_TRANSPORTS } from '../config.js';
import { InteractiveError, normalizeInteractive } from '../messaging/interactive.js';
import { blockedWordIn } from '../tenancy.js';

/** Legacy limit vs policy cap, 0 = unlimited on both: the stricter (lower non-zero) wins. */
export function stricterCap(a, b) {
    const caps = [Number(a) || 0, Number(b) || 0].filter((n) => n > 0);
    return caps.length ? Math.min(...caps) : 0;
}

const HOST = /\b(https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(\/\S*)?/gi;
const SHORTENERS = ['bit.ly', 'tinyurl.com', 't.co', 'goo.gl', 'ow.ly', 'is.gd', 'buff.ly', 'cutt.ly', 'rb.gy', 'shorturl.at', 'tiny.cc', 'rebrand.ly'];
const TRIGGERS = ['free', 'winner', 'win', 'cash', 'prize', 'urgent', 'act now', 'limited time', 'guaranteed',
    'click here', 'buy now', 'last chance', 'hurry', 'lottery', 'congratulations', 'risk free', 'double your', 'earn money'];
const SKIP_KEYS = new Set(['id', 'type', 'kind', 'payload']);

/** Everything a recipient reads: body plus the interactive block's visible strings. */
function visibleText({ body = '', interactive = null } = {}) {
    const out = [String(body ?? '')];
    const walk = (value, key) => {
        if (typeof value === 'string') { if (!SKIP_KEYS.has(key)) out.push(value); return; }
        if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, k);
    };
    walk(interactive, '');
    return out.join('\n');
}

const matchesDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

/** Hosts named in the text, and how many of them read as links (scheme, www. or a path). */
function linksIn(text) {
    const hosts = [];
    let links = 0;
    for (const m of text.matchAll(HOST)) {
        const host = m[2].toLowerCase();
        hosts.push(host);
        if (m[1] || m[3] || host.startsWith('www.')) links += 1;
    }
    return { hosts, links };
}

/**
 * 0-100, higher = more spam-like. Deliberately a plain sum of named points so
 * the editor can show *why*.
 * ponytail: keyword heuristic, swap for a trained classifier if false positives hurt.
 */
export function spamScore(draft) {
    const text = visibleText(draft);
    const reasons = [];
    const add = (points, reason) => { if (points > 0) reasons.push({ points, reason }); };

    const letters = text.match(/\p{L}/gu) ?? [];
    const upper = text.match(/\p{Lu}/gu) ?? [];
    const ratio = letters.length >= 20 ? upper.length / letters.length : 0;
    add(ratio > 0.5 ? 30 : ratio > 0.3 ? 15 : 0, 'lots of CAPITAL letters');

    const bursts = (text.match(/[!?]{2,}/g) ?? []).length;
    const bangs = (text.match(/!/g) ?? []).length;
    add(Math.min(15, bursts * 5) + (bangs > 3 ? 5 : 0), 'excessive punctuation');

    const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
    add(emoji > 10 ? 20 : emoji > 5 ? 10 : 0, 'many emoji');

    const { hosts, links } = linksIn(text);
    if (hosts.some((h) => SHORTENERS.some((s) => matchesDomain(h, s)))) add(25, 'shortened link');
    add(links > 4 ? 20 : links > 2 ? 10 : 0, 'many links');

    const flat = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}%$]+/gu, ' ')} `;
    const hits = TRIGGERS.filter((w) => flat.includes(` ${w} `));
    add(Math.min(32, hits.length * 8), hits.length ? `money/urgency words (${hits.join(', ')})` : '');

    return { score: Math.min(100, reasons.reduce((n, r) => n + r.points, 0)), reasons };
}

const mediaKind = (mimetype = '') => (['image', 'video', 'audio'].find((k) => mimetype.startsWith(`${k}/`)) ?? 'document');
const BUTTON_LABEL = { quick_reply: 'Quick reply', url: 'Link', call: 'Call', copy: 'Copy code' };

/** [type] per button of a normalized interactive block. List menus carry rows, not buttons. */
function buttonTypes(interactive) {
    if (interactive?.type === 'buttons') return interactive.buttons.map(() => 'quick_reply');
    if (interactive?.type === 'cta') return interactive.cta.map((c) => c.kind);
    return [];
}

/**
 * The first content/media/button rule a (merged) template draft breaks, as
 * { rule, message }, or null. `media(id)` resolves a header upload.
 */
export function templateRuleProblem(draft, { policy = {}, limits = {}, media = () => null } = {}) {
    const text = visibleText(draft);
    // Legacy tenant blockedWords and the policy list are both enforced.
    const words = [String(limits.blockedWords ?? ''), ...(policy['templates.blockedWords'] ?? [])].join('\n');
    const word = blockedWordIn({ blockedWords: words }, `${draft.name ?? ''} ${text}`);
    if (word) return { rule: 'blockedWords', message: `This template uses "${word}", which is not allowed on this platform.` };

    const domains = (policy['templates.blockedDomains'] ?? []).map((d) => String(d).trim().toLowerCase().replace(/^\*?\./, '')).filter(Boolean);
    const { hosts } = linksIn(text);
    for (const host of hosts) {
        const hit = domains.find((d) => matchesDomain(host, d));
        if (hit) return { rule: 'blockedDomains', message: `Links to ${hit} are not allowed in templates on this platform.` };
    }

    const max = policy['templates.maxSpamScore'] ?? 100;
    if (max < 100) {
        const { score, reasons } = spamScore(draft);
        if (score > max) {
            return {
                rule: 'maxSpamScore',
                message: `This template scores ${score} for spam, above the platform limit of ${max} (${reasons.map((r) => r.reason).join('; ')}).`,
            };
        }
    }

    const file = draft.headerMediaId ? media(draft.headerMediaId) : null;
    if (file) {
        const kind = mediaKind(file.mimetype);
        const allowed = policy['templates.mediaTypes'] ?? ['image', 'video', 'document'];
        if (!allowed.includes(kind)) {
            return { rule: 'mediaTypes', message: `${kind[0].toUpperCase()}${kind.slice(1)} attachments are not allowed in templates on your plan.` };
        }
        // Policy MB (always set) vs legacy maxMediaMb (0 = none): the lower wins.
        const mb = stricterCap(policy['templates.maxMediaMb'], limits.maxMediaMb);
        if (mb && file.size > mb * 1024 * 1024) {
            return { rule: 'maxMediaMb', message: `Template attachments can be up to ${mb} MB on your plan.` };
        }
    }

    let interactive = null;
    try {
        interactive = normalizeInteractive(draft.interactive);
    } catch (err) {
        if (!(err instanceof InteractiveError)) throw err; // the store reports the shape error
    }
    const types = buttonTypes(interactive);
    const allowedButtons = policy['templates.buttonTypes'] ?? ['quick_reply', 'url', 'call'];
    const bad = types.find((t) => !allowedButtons.includes(t));
    if (bad) return { rule: 'buttonTypes', message: `${BUTTON_LABEL[bad] ?? bad} buttons are not allowed in templates on your plan.` };
    const maxButtons = policy['templates.maxButtons'] ?? 3;
    if (types.length > maxButtons) {
        return {
            rule: 'maxButtons',
            message: maxButtons ? `Templates can have up to ${maxButtons} buttons on your plan.` : 'Buttons are not allowed in templates on your plan.',
        };
    }
    return null;
}

/** Does this template go through the platform review queue under this policy? Meta reviews provider templates. */
export const needsReview = (policy, template) => (policy['templates.requireApproval'] ?? 'off') !== 'off'
    && template.templateType !== 'provider_template';

/**
 * Why this template may not be sent on this channel, or null. `baileys` mode
 * only gates sends through QR (Baileys) numbers.
 */
export function reviewBlock(template, policy, channel) {
    if (!needsReview(policy, template) || template.reviewStatus === 'approved') return null;
    const transport = channel?.provider ?? channel?.settings?.transport;
    if (policy['templates.requireApproval'] === 'baileys' && !QR_TRANSPORTS.includes(transport)) return null;
    if (template.reviewStatus === 'rejected') {
        return `Template "${template.name}" was rejected by the platform admin${template.reviewNote ? `: ${template.reviewNote}` : ''}. Edit it to send it for review again.`;
    }
    return `Template "${template.name}" is waiting for platform admin approval and cannot be sent yet.`;
}
