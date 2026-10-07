/**
 * Which FAQ item answers this message?
 *
 * This is the successor to `AutoReplyEngine.matchRule`, and a strict superset
 * of it: EXACT, CONTAINS, REGEX and FALLBACK behave the same way, with
 * SIMILARITY inserted before the fallback and a business-hours override in
 * front. No database handle, no clock of its own, no network - so it is
 * testable on a literal array of items, which is how the hard cases get
 * covered.
 *
 * Two differences from `matchRule`, both deliberate:
 *
 *   - It tries the levels in order rather than walking the item list once, so
 *     an EXACT match always beats a CONTAINS match even when the CONTAINS item
 *     is listed first. `matchRule` let list order decide that, which is a
 *     surprise nobody wants to debug.
 *   - Within a level, higher `priority` wins, then lower id. Ties were
 *     previously settled by whatever order SQL happened to return.
 *
 * AI is not here and is not required. Phase 10 says basic FAQ operation must
 * not depend on it, so every level below is deterministic. The seam for a
 * later AI attempt is the `aiFallback` option: a nullable
 * `(normalisedText, items) => { item, score } | null` consulted only after
 * SIMILARITY has missed and before FALLBACK. Nothing in this repo supplies
 * one, nothing imports one, and the matcher is complete without it.
 */

import { withinSendingWindow } from '../channels.js';

export const MATCH_TYPES = Object.freeze(['EXACT', 'CONTAINS', 'REGEX', 'SIMILARITY', 'FALLBACK']);

/**
 * How close a token overlap has to be before we call it an answer.
 *
 * 0.6 of a Sørensen-Dice coefficient means roughly "most of the words agree".
 * Below it we return null, because answering confidently with the wrong answer
 * is worse than not answering: a miss gets logged and a human picks it up, a
 * wrong answer gets believed.
 */
export const SIMILARITY_THRESHOLD = 0.6;

/**
 * @param {string} text the inbound message
 * @param {Array<object>} items FAQ items (store shape: keywords array, matchType, ...)
 * @param {object} [options]
 * @param {Date} [options.now] clock, for the business-hours check
 * @param {object} [options.channel] channel row, for `withinSendingWindow`
 * @param {number} [options.threshold] similarity cut-off
 * @param {?Function} [options.aiFallback] the AI seam; see the module comment
 * @param {string} [options.locale] only consider items for this locale (plus
 *   the locale-less ones, which are the default answers)
 * @returns {{ item: object, level: string, score: number } | null}
 */
export function matchFaq(text, items, { now = new Date(), channel = null, threshold = SIMILARITY_THRESHOLD, aiFallback = null, locale = '' } = {}) {
    const norm = normalizeText(text);
    if (!norm) return null;

    const pool = (Array.isArray(items) ? items : [])
        .filter((item) => item && item.isActive !== false && item.is_active !== 0)
        .filter((item) => !locale || !itemLocale(item) || itemLocale(item) === String(locale).toLowerCase())
        .sort((a, b) => (Number(b.priority ?? 0) - Number(a.priority ?? 0)) || (Number(a.id ?? 0) - Number(b.id ?? 0)));

    // Outside the window the business is shut, and "we are closed, we reply at
    // 9" is the honest answer even to a question we could have answered. The
    // window itself is `withinSendingWindow` - the same one the send path uses,
    // not a second copy that can drift from it.
    if (channel && !withinSendingWindow(channel, now)) {
        const closed = pool.find((item) => isTrue(item.outOfHours ?? item.out_of_hours));
        if (closed) return { item: closed, level: 'fallback', score: 1 };
    }

    for (const item of pool) {
        if (type(item) !== 'EXACT') continue;
        if (phrases(item).some((p) => p === norm)) return { item, level: 'exact', score: 1 };
    }

    for (const item of pool) {
        if (type(item) !== 'CONTAINS') continue;
        if (phrases(item).some((p) => p && norm.includes(p))) return { item, level: 'contains', score: 1 };
    }

    for (const item of pool) {
        if (type(item) !== 'REGEX') continue;
        // Tested against the raw message as well as the normalised one: a
        // pattern written with punctuation in it - `price\?`, `\$\d+` - would
        // never match text we have just stripped the punctuation out of.
        const raw = String(text ?? '').trim();
        for (const pattern of patterns(item)) {
            try {
                const re = new RegExp(pattern, 'i');
                if (re.test(raw) || re.test(norm)) return { item, level: 'regex', score: 1 };
            } catch {
                continue; // a broken pattern is one dead item, not a dead engine
            }
        }
    }

    const asked = tokens(norm);
    let best = null;
    for (const item of pool) {
        if (type(item) !== 'SIMILARITY') continue;
        // The question itself is a phrase to compare against, not just the
        // keywords: whoever wrote "Do you deliver on Sundays?" already supplied
        // the best token set available.
        const score = Math.max(0, ...phrases(item).map((p) => dice(asked, tokens(p))));
        if (score >= threshold && (!best || score > best.score)) best = { item, level: 'similarity', score };
    }
    if (best) return best;

    // The AI seam. Nothing supplies a handler today; a later phase can pass
    // one here without any other level changing.
    if (typeof aiFallback === 'function') {
        const guess = aiFallback(norm, pool);
        if (guess?.item) return { item: guess.item, level: 'ai', score: Number(guess.score ?? 0) };
    }

    const fallback = pool.find((item) => type(item) === 'FALLBACK');
    if (fallback) return { item: fallback, level: 'fallback', score: 1 };

    // Nothing above the threshold. Escalation is the caller's decision, not an
    // answer we can invent, so this is null and the caller logs the miss.
    return null;
}

/**
 * The closest item regardless of the threshold, or null.
 *
 * This is what gives `faq_items.miss_count` a meaning: the answer that nearly
 * fired and was declined. An item with a high miss count and a low hit count
 * is one whose keywords need widening, which is a different fix from the one
 * `faq_misses` asks for.
 */
export function nearestFaq(text, items) {
    const asked = tokens(text);
    if (!asked.size) return null;
    let best = null;
    for (const item of (Array.isArray(items) ? items : [])) {
        if (!item) continue;
        const score = Math.max(0, ...phrases(item).map((p) => dice(asked, tokens(p))));
        if (score > 0 && (!best || score > best.score)) best = { item, score };
    }
    return best;
}

/** lowercase, punctuation out, whitespace collapsed. The one normalisation. */
export function normalizeText(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Sørensen-Dice over token sets: 2|A∩B| / (|A|+|B|).
 *
 * Dice rather than Jaccard because it is kinder to the length mismatch you
 * actually get here - a three-word message against a ten-word stored question -
 * and neither needs a dependency.
 *
 * ponytail: bag of words, so word order and typos are invisible. If misses
 * pile up on near-spellings, upgrade to character bigrams (same formula, swap
 * `tokens` for a bigram set) before reaching for an AI call.
 */
export function dice(a, b) {
    if (!a.size || !b.size) return 0;
    let shared = 0;
    for (const token of a) if (b.has(token)) shared += 1;
    return (2 * shared) / (a.size + b.size);
}

const tokens = (text) => new Set(normalizeText(text).split(' ').filter(Boolean));

const type = (item) => String(item.matchType ?? item.match_type ?? '').toUpperCase();

const itemLocale = (item) => String(item.locale ?? '').trim().toLowerCase();

const isTrue = (value) => value === true || value === 1 || value === '1';

/** What EXACT, CONTAINS and SIMILARITY compare against: keywords plus question. */
function phrases(item) {
    const list = keywordList(item).map(normalizeText);
    const question = normalizeText(item.question);
    if (question) list.push(question);
    return list.filter(Boolean);
}

/** Regex patterns are kept verbatim - normalising one would break it. */
function patterns(item) {
    const list = keywordList(item).map((k) => String(k).trim()).filter(Boolean);
    return list.length ? list : [String(item.question ?? '').trim()].filter(Boolean);
}

function keywordList(item) {
    if (Array.isArray(item.keywords)) return item.keywords;
    // Tolerates a raw row handed straight from SQL, where keywords is JSON.
    try {
        const parsed = JSON.parse(item.keywords ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}
