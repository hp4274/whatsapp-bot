/**
 * Resolve spinning syntax like "{Hi|Hello}" on a per-message basis.
 *
 * The parser works from innermost expressions outward, so nested clauses such
 * as "{Hi|{Hello|Greetings}}" resolve before the outer choice is picked.
 */

const ESCAPED_OPEN = '\u0000OPEN\u0000';
const ESCAPED_CLOSE = '\u0000CLOSE\u0000';
const ESCAPED_PIPE = '\u0000PIPE\u0000';

export function parseSpintax(text, rng = Math.random) {
    if (!text || typeof text !== 'string') return '';
    let source = protectEscapes(text);

    for (;;) {
        const group = findInnermostGroup(source);
        if (!group) break;
        const choices = splitChoices(source.slice(group.start + 1, group.end));
        const index = Math.min(choices.length - 1, Math.floor(Math.max(0, rng()) * choices.length));
        const chosen = (choices[index] ?? '').trim();
        source = source.slice(0, group.start) + chosen + source.slice(group.end + 1);
    }

    return restoreEscapes(source).trim();
}

function protectEscapes(text) {
    return text
        .replace(/\\\{/g, ESCAPED_OPEN)
        .replace(/\\\}/g, ESCAPED_CLOSE)
        .replace(/\\\|/g, ESCAPED_PIPE);
}

function restoreEscapes(text) {
    return text
        .replaceAll(ESCAPED_OPEN, '{')
        .replaceAll(ESCAPED_CLOSE, '}')
        .replaceAll(ESCAPED_PIPE, '|');
}

function findInnermostGroup(text) {
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
        if (text[i] === '{') start = i;
        else if (text[i] === '}' && start !== -1) {
            if (text.slice(start + 1, i).includes('|')) return { start, end: i };
            start = -1;
        }
    }
    return null;
}

function splitChoices(text) {
    return text.split('|');
}
