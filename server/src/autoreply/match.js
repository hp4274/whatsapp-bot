/**
 * Which rules does this message hit?
 *
 * Pure: rules in, matches out, no database and no clock. Everything is
 * compared case- and diacritics-insensitive ("Café", "CAFE" and "cafe" are the
 * same word), with surrounding quotes and trailing punctuation dropped.
 *
 *   EXACT       the whole message is one of the keywords
 *   CONTAINS    a keyword appears anywhere, even inside a word
 *   STARTS_WITH the message begins with a keyword
 *   ANY_OF      a keyword appears as a whole word or phrase ("hi" does not hit "this")
 *   ALL_OF      every keyword appears as a whole word or phrase, in any order ("price" and "delivery")
 *   FUZZY       a keyword appears with a typo or two ("pirce" -> "price")
 *   MESSAGE_TYPE the message is a photo, video, voice note/audio, document, sticker, location or contact
 *   INTENT      the message means one of the built-in intents (intents.js): "cost?", "rate kya hai", "कितना" are all price
 *   REGEX       a JavaScript pattern, case-insensitive, tried on raw and folded text
 *   FALLBACK    never matched here; the engine uses it when nothing else fires
 *
 * The knowledge matcher's similarity is a bag-of-words Dice score, which is
 * blind to typos, so FUZZY uses an edit distance instead.
 *
 * Spelling mistakes ("prise", "delivry", "thankx") are forgiven on EXACT, CONTAINS, ANY_OF and ALL_OF too,
 * as FUZZY scores them, unless the rule sets `typos: false` (exact spelling only).
 * A rule with `synonyms` on also matches the rest of a keyword's intent group ("price" hits "cost" and
 * "rate") for ANY_OF, ALL_OF, CONTAINS and FUZZY; `noSynonyms` (the plan leaves intents out) drops the groups.
 */

import { INTENTS } from './intents.js';

/** What a MESSAGE_TYPE rule can fire on (the transport's mediaType values). */
export const MESSAGE_TYPES = Object.freeze(['image', 'video', 'audio', 'document', 'sticker', 'location', 'contact', 'order']);

export const MATCH_TYPES = Object.freeze(['EXACT', 'CONTAINS', 'STARTS_WITH', 'ANY_OF', 'ALL_OF', 'FUZZY', 'INTENT', 'MESSAGE_TYPE', 'REGEX', 'FALLBACK']);

/** lowercase, accents off, quotes and trailing punctuation off, spaces collapsed. */
export function fold(text) {
    return String(text ?? '')
        .normalize('NFD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, '')
        .replace(/[.!?,;:]+$/g, '')
        .trim();
}

/** Words only: punctuation becomes a space. Used for whole-word and fuzzy matching. */
const words = (text) => fold(text).replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/).filter(Boolean);

/** Keywords of a rule: the array if present, else the legacy single keyword (comma list for ANY_OF). */
export function ruleKeywords(rule) {
    if (Array.isArray(rule.keywords) && rule.keywords.length) return rule.keywords.map(String).filter((k) => k.trim());
    const raw = String(rule.keyword ?? '');
    if (!raw.trim()) return [];
    return String(rule.matchType).toUpperCase() === 'REGEX' ? [raw] : raw.split(',').map((k) => k.trim()).filter(Boolean);
}

/**
 * Optimal string alignment distance: Levenshtein plus adjacent transpositions,
 * so the commonest typo ("pirce") costs one edit, not two.
 */
export function editDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
    for (let i = 1; i <= a.length; i += 1) {
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}

/** One letter for every run of the same letter. */
const squeeze = (s) => s.replace(/(.)\1+/gu, '$1');

/** Edits a keyword of this length tolerates: none for short words, then one per four letters, at most three. */
const allowedEdits = (length) => (length < 4 ? 0 : Math.min(3, Math.floor(length / 4)));

/** Best fuzzy score (0..1) of a keyword against the message's word windows, or 0 if too far. */
export function fuzzyScore(messageWords, keyword) {
    const kw = words(keyword);
    if (!kw.length || !messageWords.length) return 0;
    const target = kw.join(' ');
    const allowed = allowedEdits(target.length);
    let best = 0;
    // Compare against every run of the same number of words (and one either side,
    // so a split or merged word - "good morning" / "goodmorning" - still lands).
    for (const size of new Set([kw.length, kw.length - 1, kw.length + 1])) {
        if (size < 1 || size > messageWords.length) continue;
        for (let i = 0; i + size <= messageWords.length; i += 1) {
            const window = messageWords.slice(i, i + size).join(' ');
            const dist = editDistance(window, target);
            const merged = size !== kw.length ? editDistance(window.replace(/ /g, ''), target.replace(/ /g, '')) : dist;
            // Stretched letters are emphasis, not typos: "hellooo", "hiii" and "timmings" read as the word.
            const squeezed = editDistance(squeeze(window), squeeze(target));
            const edits = Math.min(dist, merged, squeezed);
            // People rarely mistype the first letter; requiring it keeps "rice" from answering "price", "look" "book".
            if (edits > 0 && window[0] !== target[0]) continue;
            if (edits <= allowed) best = Math.max(best, 1 - edits / Math.max(window.length, target.length));
        }
    }
    return best;
}

/** Does one rule match? Returns { keyword, score } or null. FALLBACK never matches here. */
export function matchOne(rule, text, mediaType = null) {
    const type = String(rule.matchType ?? '').toUpperCase();
    if (type === 'FALLBACK' || !MATCH_TYPES.includes(type)) return null;
    const keywords = ruleKeywords(rule);
    if (type === 'MESSAGE_TYPE') return mediaType && keywords.includes(mediaType) ? { keyword: mediaType, score: 1 } : null;
    const folded = fold(text);
    if (!folded) return null;

    if (type === 'REGEX') {
        const raw = String(text ?? '').trim();
        for (const pattern of keywords) {
            try {
                const re = new RegExp(pattern, 'i');
                if (re.test(raw) || re.test(folded)) return { keyword: pattern, score: 1 };
            } catch {
                // a broken pattern is one dead rule, not a dead engine
            }
        }
        return null;
    }

    // Spelling mistakes count on the word-based types too, unless the rule asks for exact spelling.
    const typos = rule.typos !== false && ['EXACT', 'CONTAINS', 'ANY_OF', 'ALL_OF'].includes(type);
    const messageWords = typos || rule.synonyms || ['ANY_OF', 'ALL_OF', 'FUZZY', 'INTENT'].includes(type) ? words(text) : null;
    const padded = messageWords ? ` ${messageWords.join(' ')} ` : '';
    const has = (k) => {
        const w = words(k).join(' ');
        return Boolean(w) && padded.includes(` ${w} `);
    };
    if (type === 'INTENT') {
        for (const id of keywords) {
            const group = INTENTS[id]?.words ?? [];
            const exact = group.find(has);
            if (exact) return { keyword: `${id}: ${exact}`, score: 1 };
            // Typos only on longer words: "hii" must not fuzz into "hi", but "prise" may into "price".
            const near = group.filter((w) => fold(w).length >= 5)
                .map((w) => ({ w, score: fuzzyScore(messageWords, fold(w)) })).sort((a, b) => b.score - a.score)[0];
            if (near?.score > 0) return { keyword: `${id}: ${near.w}`, score: near.score };
        }
        return null;
    }
    // Each keyword stands for itself, or with synonyms on for its whole intent group.
    const alts = (k) => (rule.synonyms && !rule.noSynonyms ? synonymsOf(k) : [k]);
    const near = (k) => typos && fuzzyScore(messageWords, fold(k)) > 0;
    if (type === 'ALL_OF') {
        const all = keywords.filter((k) => words(k).length);
        return all.length && all.every((k) => (alts(k).some(has) || near(k))) ? { keyword: keywords.join(' + '), score: 1 } : null;
    }
    let fuzzy = null;
    const candidates = ['ANY_OF', 'FUZZY', 'CONTAINS'].includes(type) ? keywords.flatMap(alts) : keywords;
    for (const keyword of candidates) {
        const k = fold(keyword);
        if (!k) continue;
        if (type === 'EXACT' && folded === k) return { keyword, score: 1 };
        // Contains: the business's own keyword anywhere; a synonym ("preco" for "price") as a whole word.
        if (type === 'CONTAINS' && (keywords.includes(keyword) ? folded.includes(k) : has(k))) return { keyword, score: 1 };
        if (type === 'STARTS_WITH' && (folded === k || folded.startsWith(k))) return { keyword, score: 1 };
        if (type === 'ANY_OF' && has(k)) return { keyword, score: 1 };
        if (type === 'FUZZY') {
            // Typos on the business's own keywords; a synonym has to be written as it is.
            const score = keywords.includes(keyword) ? fuzzyScore(messageWords, k) : (has(k) ? 1 : 0);
            if (score > 0 && (!fuzzy || score > fuzzy.score)) fuzzy = { keyword, score };
        }
    }
    if (fuzzy || !typos) return fuzzy;
    // Nothing exact: the closest of the business's own keywords within the typo allowance (not their synonyms:
    // a typo of a synonym is two steps from what the business wrote, and "bhai" is one letter from "bhav").
    for (const keyword of keywords) {
        // EXACT stays the whole message: a near spelling of it, not a keyword somewhere inside a sentence.
        if (type === 'EXACT' && Math.abs(messageWords.length - words(keyword).length) > 0) continue;
        const score = fuzzyScore(messageWords, fold(keyword));
        if (score > 0 && (!fuzzy || score > fuzzy.score)) fuzzy = { keyword, score };
    }
    return fuzzy;
}

/** The keyword and, when it belongs to a built-in intent, every other word of that intent. */
export function synonymsOf(keyword) {
    const k = words(keyword).join(' ');
    const group = Object.values(INTENTS).find((g) => g.words.some((w) => words(w).join(' ') === k));
    return group ? [keyword, ...group.words.filter((w) => words(w).join(' ') !== k)] : [keyword];
}

/** Rules in evaluation order: priority ascending, then id. */
export const byPriority = (a, b) => (Number(a.priority ?? 0) - Number(b.priority ?? 0)) || (Number(a.id ?? 0) - Number(b.id ?? 0));

/** Every non-fallback rule this message hits: exact hits first, then typo matches, each in priority order. */
export function matchRules(text, rules, mediaType = null) {
    const out = [];
    for (const rule of [...rules].sort(byPriority)) {
        if (rule.isActive === false) continue;
        const hit = matchOne(rule, text, mediaType);
        if (hit) out.push({ rule, ...hit });
    }
    // A keyword written as it is beats a guessed spelling, whatever the priority: "help" must reach the HELP
    // rule, not a higher "hello" rule one letter away. Within each group the priority order stands.
    return [...out.filter((h) => h.score >= 1), ...out.filter((h) => h.score < 1)];
}

/** True when the text names one of these words or phrases as a whole word. */
export function hasWord(text, keywords) {
    const padded = ` ${words(text).join(' ')} `;
    return keywords.some((k) => {
        const w = words(k).join(' ');
        return w && padded.includes(` ${w} `);
    });
}
