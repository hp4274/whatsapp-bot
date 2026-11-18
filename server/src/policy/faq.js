/**
 * Platform rules for how the FAQ matches. See `index.js` for the field shape. Both default to on, which is what the
 * FAQ did before it had them. faq.autoAnswer and faq.maxItems live in modules.js.
 */

export const FAQ_POLICY = Object.freeze([
    { key: 'faq.allowSynonyms', service: 'faq', group: 'Matching', type: 'bool', default: true,
      label: 'Match Hinglish and synonyms',
      hint: '"rate kya hai" finds the price answer, "kab khulta" the timings. Off: only the words the business wrote.' },
    { key: 'faq.allowRegex', service: 'faq', group: 'Matching', type: 'bool', default: true,
      label: 'Allow pattern (regex) answers',
      hint: 'Off: an answer can no longer be saved or imported with the regex match. Ones already saved keep working.' },
]);
