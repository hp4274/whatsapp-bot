/**
 * Campaign import wizard: parse any sheet, let the operator map columns,
 * audit every row before a single message goes out, and fill blanks with
 * per-variable fallbacks so a campaign never sends a literal "{name}".
 *
 * Pure functions: the HTTP layer keeps the parsed sheet in memory under an
 * importId (see app.js `/campaign/import/*`), and `buildContacts` turns a
 * mapping into the explicit audience list a campaign row stores.
 */

import { normalizeHeader, parseCsv } from '../contacts.js';
import { PhoneError, contactContext, normalizePhone, personalize } from '../protocol.js';

export const MAX_ROWS = 50_000;

const PHONE_HINT = /phone|mobile|whatsapp|msisdn|number|contact|cell|tel/;
const NAME_HINT = /name|customer|client|student|parent|person/;
const LOOKS_LIKE_PHONE = /^\+?[\d\s\-().]{7,20}$/;

/** `+91` / `91` / `0091` -> `91`; null when it is not a country code. */
export function cleanCountryCode(value) {
    const cc = String(value ?? '').trim().replace(/^\+|^00/, '');
    return /^\d{1,4}$/.test(cc) ? cc.replace(/^0+/, '') || null : null;
}

// ------------------------------------------------------------- parsing --
/**
 * Headers + rows from a CSV or XLSX buffer, without assuming any header
 * names. Fully empty rows are dropped; rows are capped at MAX_ROWS.
 * @returns {Promise<{ headers: string[], columns: {header:string, slug:string}[], rows: string[][], total: number, truncated: boolean }>}
 */
export async function parseSheet(filename, buffer) {
    let table;
    if (/\.xlsx?$|\.xlsm$/i.test(filename)) {
        const XLSX = await import('xlsx');
        const book = XLSX.read(buffer, { type: 'buffer' });
        const sheet = book.Sheets[book.SheetNames[0]];
        table = sheet ? XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false }) : [];
    } else {
        table = parseCsv(buffer.toString('utf8'));
    }
    table = table.map((row) => (Array.isArray(row) ? row : []).map((cell) => String(cell ?? '').trim()));
    const headers = (table[0] ?? []).map((h) => h.trim());
    while (headers.length && !headers.at(-1)) headers.pop();
    const body = table.slice(1)
        .map((row) => headers.map((_, i) => row[i] ?? ''))
        .filter((row) => row.some(Boolean));
    return {
        headers,
        columns: uniqueColumns(headers),
        rows: body.slice(0, MAX_ROWS),
        total: body.length,
        truncated: body.length > MAX_ROWS,
    };
}

/** Every header becomes a {slug} variable; collisions get _2, _3. */
export function uniqueColumns(headers) {
    const taken = new Set();
    return headers.map((header, i) => {
        let slug = normalizeHeader(header) || `column_${i + 1}`;
        if (/^\d/.test(slug)) slug = `col_${slug}`;
        const base = slug;
        for (let n = 2; taken.has(slug); n += 1) slug = `${base}_${n}`;
        taken.add(slug);
        return { header, slug };
    });
}

/** Which column holds the phone and which the name: header words first, then the data. */
export function guessMapping(columns, rows = []) {
    const exact = (keys) => columns.find((c) => keys.includes(c.slug))?.slug ?? null;
    const hint = (re) => columns.find((c) => re.test(c.slug))?.slug ?? null;
    let phone = exact(['phone', 'phone_number', 'mobile', 'whatsapp', 'number', 'msisdn']) ?? hint(PHONE_HINT);
    if (!phone) {
        // No helpful header: the column where most sample cells look like numbers.
        const sample = rows.slice(0, 50);
        const scored = columns.map((c, i) => ({
            slug: c.slug,
            hits: sample.filter((r) => LOOKS_LIKE_PHONE.test(r[i] ?? '') && (r[i] ?? '').replace(/\D/g, '').length >= 7).length,
        })).sort((a, b) => b.hits - a.hits)[0];
        phone = scored && scored.hits > sample.length / 2 ? scored.slug : null;
    }
    const name = exact(['name', 'full_name', 'fullname', 'contact', 'first_name', 'customer_name'])
        ?? columns.find((c) => c.slug !== phone && NAME_HINT.test(c.slug))?.slug ?? null;
    return { phone, name: name === phone ? null : name };
}

// --------------------------------------------------------------- phones --
/** Strip spaces, dashes, brackets, dots and stray letters; keep one leading '+'. */
export function cleanPhone(raw) {
    const text = String(raw ?? '').trim();
    const plus = text.startsWith('+') ? '+' : '';
    return plus + text.replace(/\D/g, '');
}

/**
 * Classify one raw phone. `autoClean` first applies `cleanPhone`; otherwise a
 * cell with letters is reported rather than silently fixed.
 * @returns {{ phone: string|null, reason: string|null, detail: string }}
 */
export function classifyPhone(raw, { countryCode = '', autoClean = false } = {}) {
    const text = String(raw ?? '').trim();
    if (!text) return { phone: null, reason: 'empty', detail: 'no phone number' };
    const loose = autoClean ? cleanPhone(text) : text.replace(/[\s\-().]/g, '');
    if (!/^\+?\d+$/.test(loose)) return { phone: null, reason: 'letters', detail: 'contains letters or symbols' };

    let digits = loose.replace(/^\+/, '');
    const international = loose.startsWith('+') || digits.startsWith('00');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (!international) {
        if (countryCode) {
            digits = countryCode + digits.replace(/^0/, '');
        } else if (digits.startsWith('0') || digits.length <= 10) {
            // ponytail: no '+' and no default prefix - a 10-digit number is
            // almost always national, so we ask for a prefix rather than guess one.
            return { phone: null, reason: 'bad_country_code', detail: 'no country code - set a default prefix' };
        }
    }
    digits = digits.replace(/^0+/, '');
    if (digits.length < 7) return { phone: null, reason: 'too_short', detail: `${digits.length} digits` };
    if (digits.length > 15) return { phone: null, reason: 'too_long', detail: `${digits.length} digits` };
    try {
        return { phone: normalizePhone(digits), reason: null, detail: '' };
    } catch (err) {
        if (!(err instanceof PhoneError)) throw err;
        return { phone: null, reason: 'invalid', detail: err.message };
    }
}

export const ISSUE_LABELS = Object.freeze({
    empty: 'No phone number',
    letters: 'Letters or symbols in the number',
    too_short: 'Too short',
    too_long: 'Too long',
    bad_country_code: 'Missing country code',
    invalid: 'Not a valid number',
    duplicate: 'Duplicate in this file',
    opted_out: 'Opted out',
    recent: 'Messaged recently',
});

// ---------------------------------------------------------------- audit --
/**
 * Row-level audit. `rows` are arrays in `columns` order; `mapping.phone` and
 * `mapping.name` are slugs. Returns the valid contacts (every other column in
 * `extra` under its slug) plus one issue per rejected row.
 */
export function auditRows(rows, columns, mapping, {
    countryCode = '', autoClean = false, optOuts = new Set(), recent = new Set(),
} = {}) {
    const index = Object.fromEntries(columns.map((c, i) => [c.slug, i]));
    const phoneAt = index[mapping?.phone];
    const nameAt = index[mapping?.name];
    if (phoneAt === undefined) throw new RangeError('pick the column that holds the phone number');
    const cc = cleanCountryCode(countryCode) ?? '';

    const seen = new Set();
    const contacts = [];
    const issues = [];
    const counts = { total: rows.length, valid: 0, invalid: 0, duplicate: 0, optedOut: 0, recent: 0 };
    rows.forEach((row, i) => {
        const raw = row[phoneAt] ?? '';
        const name = nameAt === undefined ? '' : String(row[nameAt] ?? '').trim();
        const { phone, reason, detail } = classifyPhone(raw, { countryCode: cc, autoClean });
        const reject = (why, note = '') => issues.push({ row: i, raw, phone, name, reason: why, detail: note || ISSUE_LABELS[why] });
        if (!phone) { counts.invalid += 1; reject(reason, detail); return; }
        if (seen.has(phone)) { counts.duplicate += 1; reject('duplicate'); return; }
        seen.add(phone);
        if (optOuts.has(phone)) { counts.optedOut += 1; reject('opted_out'); return; }
        if (recent.has(phone)) { counts.recent += 1; reject('recent'); return; }
        const extra = {};
        columns.forEach((c, j) => {
            if (j !== phoneAt && j !== nameAt) extra[c.slug] = String(row[j] ?? '');
        });
        contacts.push({ row: i, name, phone, extra });
        counts.valid += 1;
    });
    return { contacts, issues, counts };
}

/** The audience a campaign stores, from a parsed sheet and the operator's choices. */
export function buildContacts(sheet, { mapping, countryCode, autoClean, optOuts, recent }) {
    const audit = auditRows(sheet.rows, sheet.columns, mapping, { countryCode, autoClean, optOuts, recent });
    return {
        ...audit,
        contacts: audit.contacts.map(({ row, ...contact }) => contact),
    };
}

// --------------------------------------------------------- fallbacks --
/** `{(\w+)}` keys a template refers to (spintax groups excluded). */
export function placeholdersIn(text) {
    return [...new Set([...String(text ?? '').matchAll(/\{(\w+)(?:\|[^{}]*)?\}/g)].map((m) => m[1]))];
}

const blank = (v) => v === undefined || v === null || String(v).trim() === '';

/** A context where every empty value takes its fallback, when one is set. */
export function withFallbacks(context, fallbacks = {}) {
    const out = { ...context };
    for (const [key, value] of Object.entries(fallbacks ?? {})) {
        if (blank(out[key]) && !blank(value)) out[key] = String(value);
    }
    return out;
}

/**
 * The text one recipient receives: fallbacks applied, spintax resolved, and
 * any placeholder nothing filled removed - never a literal `{coupon}`.
 */
export function renderMessage(template, contact, fallbacks = {}) {
    const context = withFallbacks(contactContext(contact), fallbacks);
    return personalize(template, context)
        .replace(/\{(\w+)\}/g, (match, key) => (blank(fallbacks?.[key]) ? '' : String(fallbacks[key])))
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/** Placeholders in `template` that neither the contact nor a fallback fills. */
export function missingFor(template, contact, fallbacks = {}) {
    const context = withFallbacks(contactContext(contact), fallbacks);
    return placeholdersIn(template).filter((key) => blank(context[key]));
}

// ------------------------------------------------------------------ csv --
/** RFC 4180-ish: quote when needed, CRLF rows. */
export function toCsv(rows) {
    const cell = (v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
