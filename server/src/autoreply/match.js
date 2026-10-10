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
 *   FUZZY       a keyword appears with a typo or two ("pirce" -> "price")
 *   REGEX       a JavaScript pattern, case-insensitive, tried on raw and folded text
 *   FALLBACK    never matched here; the engine uses it when nothing else fires
 *
 * The knowledge matcher's similarity is a bag-of-words Dice score, which is
 * blind to typos, so FUZZY uses an edit distance instead.
 */

export const MATCH_TYPES = Object.freeze(['EXACT', 'CONTAINS', 'STARTS_WITH', 'ANY_OF', 'FUZZY', 'REGEX', 'FALLBACK']);

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
            const edits = Math.min(dist, merged);
            if (edits <= allowed) best = Math.max(best, 1 - edits / Math.max(window.length, target.length));
        }
    }
    return best;
}

/** Does one rule match? Returns { keyword, score } or null. FALLBACK never matches here. */
export function matchOne(rule, text) {
    const type = String(rule.matchType ?? '').toUpperCase();
    if (type === 'FALLBACK' || !MATCH_TYPES.includes(type)) return null;
    const keywords = ruleKeywords(rule);
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

    const messageWords = type === 'ANY_OF' || type === 'FUZZY' ? words(text) : null;
    const padded = messageWords ? ` ${messageWords.join(' ')} ` : '';
    let fuzzy = null;
    for (const keyword of keywords) {
        const k = fold(keyword);
        if (!k) continue;
        if (type === 'EXACT' && folded === k) return { keyword, score: 1 };
        if (type === 'CONTAINS' && folded.includes(k)) return { keyword, score: 1 };
        if (type === 'STARTS_WITH' && (folded === k || folded.startsWith(k))) return { keyword, score: 1 };
        if (type === 'ANY_OF' && padded.includes(` ${words(k).join(' ')} `)) return { keyword, score: 1 };
        if (type === 'FUZZY') {
            const score = fuzzyScore(messageWords, k);
            if (score > 0 && (!fuzzy || score > fuzzy.score)) fuzzy = { keyword, score };
        }
    }
    return fuzzy;
}

/** Rules in evaluation order: priority ascending, then id. */
export const byPriority = (a, b) => (Number(a.priority ?? 0) - Number(b.priority ?? 0)) || (Number(a.id ?? 0) - Number(b.id ?? 0));

/** Every non-fallback rule this message hits, in priority order. */
export function matchRules(text, rules) {
    const out = [];
    for (const rule of [...rules].sort(byPriority)) {
        if (rule.isActive === false) continue;
        const hit = matchOne(rule, text);
        if (hit) out.push({ rule, ...hit });
    }
    return out;
}

/** True when the text names one of these words or phrases as a whole word. */
export function hasWord(text, keywords) {
    const padded = ` ${words(text).join(' ')} `;
    return keywords.some((k) => {
        const w = words(k).join(' ');
        return w && padded.includes(` ${w} `);
    });
}
