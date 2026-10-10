/**
 * Contact importers: CSV (hand-rolled, so quoted fields and BOMs behave) and
 * XLSX via SheetJS.  Both normalise, validate and de-duplicate by number.
 *
 * Expected header (case-insensitive, extra columns become personalisation
 * variables):  name,phone
 */

import { PhoneError, normalizePhone } from './protocol.js';

const NAME_KEYS = ['name', 'full_name', 'fullname', 'contact', 'first_name'];
const PHONE_KEYS = ['phone', 'number', 'phone_number', 'mobile', 'msisdn', 'whatsapp'];

export function normalizeHeader(key) {
    return String(key ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

/** Split CSV text into rows, honouring quotes, escaped quotes and CRLF. */
export function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const source = text.replace(/^﻿/, '');

    for (let i = 0; i < source.length; i += 1) {
        const char = source[i];
        if (inQuotes) {
            if (char === '"') {
                if (source[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += char;
            }
            continue;
        }
        if (char === '"') inQuotes = true;
        else if (char === ',') {
            row.push(field);
            field = '';
        } else if (char === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (char !== '\r') {
            field += char;
        }
    }
    if (field.length || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}

function pick(row, keys) {
    for (const key of keys) {
        const value = row[key];
        if (value) return String(value).trim();
    }
    return '';
}

/**
 * Shared by both importers: normalise, validate, de-duplicate.
 * @returns {{contacts: Array, errors: string[], duplicates: number}}
 */
export function rowsToContacts(rows, defaultCountryCode = '') {
    const result = { contacts: [], errors: [], duplicates: 0, detectedVariables: [] };
    const seen = new Set();
    const variables = new Set();

    rows.forEach((rawRow, index) => {
        const lineNumber = index + 2; // row 1 is the header
        const row = {};
        for (const [key, value] of Object.entries(rawRow)) {
            if (key === null || key === undefined) continue;
            // "Full Name" and "Phone Number" are what spreadsheets actually
            // contain, so headers are matched in their snake_case form.
            const normalizedKey = normalizeHeader(key);
            if (!normalizedKey) continue;
            variables.add(normalizedKey);
            row[normalizedKey] = value === null || value === undefined
                ? '' : String(value).trim();
        }
        if (!Object.values(row).some((value) => value !== '')) return;

        const phoneRaw = pick(row, PHONE_KEYS);
        if (!phoneRaw) {
            result.errors.push(`Row ${lineNumber}: missing phone number`);
            return;
        }
        let phone;
        try {
            phone = normalizePhone(phoneRaw, defaultCountryCode);
        } catch (err) {
            if (!(err instanceof PhoneError)) throw err;
            result.errors.push(`Row ${lineNumber}: ${err.message}`);
            return;
        }
        if (seen.has(phone)) {
            result.duplicates += 1;
            return;
        }
        seen.add(phone);

        const extra = {};
        for (const [key, value] of Object.entries(row)) {
            if (!NAME_KEYS.includes(key) && !PHONE_KEYS.includes(key)) extra[key] = value;
        }
        result.contacts.push({ name: pick(row, NAME_KEYS), phone, extra });
    });

    result.detectedVariables = ['name', 'phone',
        ...[...variables].filter((key) => !NAME_KEYS.includes(key) && !PHONE_KEYS.includes(key))];
    return result;
}

export function importCsv(text, defaultCountryCode = '') {
    const rows = parseCsv(text);
    if (!rows.length) return { contacts: [], errors: ['file is empty'], duplicates: 0, detectedVariables: [] };
    const header = rows[0].map((h) => h.trim());
    const records = rows.slice(1).map((cells) =>
        Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ''])));
    return rowsToContacts(records, defaultCountryCode);
}

export async function importXlsx(buffer, defaultCountryCode = '') {
    const XLSX = await import('xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = book.SheetNames[0];
    if (!sheetName) return { contacts: [], errors: ['workbook has no sheets'], duplicates: 0, detectedVariables: [] };
    const records = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: '', raw: false });
    return rowsToContacts(records, defaultCountryCode);
}

/** Dispatch on the file name. */
export async function importContacts(filename, buffer, defaultCountryCode = '') {
    if (/\.xlsx?$|\.xlsm$/i.test(filename)) {
        return importXlsx(buffer, defaultCountryCode);
    }
    return importCsv(buffer.toString('utf8'), defaultCountryCode);
}

// ------------------------------------------------- mapped import wizard --
// The plain importer above guesses columns by header name; the contacts page
// lets the operator say which column is which. These helpers back that flow
// and never change what `importContacts` returns.

export const PREVIEW_ROWS = 10;
const EMAIL_KEYS = ['email', 'e_mail', 'email_address', 'mail'];
const TAG_KEYS = ['tags', 'tag', 'labels', 'label', 'groups', 'group'];

/** Raw header row + body rows (strings), from CSV or the first XLSX sheet. */
export async function parseTable(filename, buffer) {
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
    const rows = table.slice(1)
        .map((row) => headers.map((_, i) => row[i] ?? ''))
        .filter((row) => row.some(Boolean));
    return { headers, rows };
}

/** One target per column: phone | name | email | tags | custom:<key> | ignore. */
export function suggestMapping(headers) {
    const used = new Set();
    return headers.map((header) => {
        const key = normalizeHeader(header);
        if (!key) return 'ignore';
        const claim = (target, keys) => {
            if (used.has(target) || !keys.includes(key)) return null;
            used.add(target);
            return target;
        };
        return claim('phone', PHONE_KEYS) ?? claim('name', NAME_KEYS) ?? claim('email', EMAIL_KEYS)
            ?? claim('tags', TAG_KEYS) ?? `custom:${key}`;
    });
}

/**
 * Accept the mapping as an array aligned with the headers, or an object keyed
 * by header text. Returns the aligned array, or throws a message to show.
 */
export function resolveMapping(headers, mapping) {
    let list = mapping;
    if (typeof list === 'string') {
        try {
            list = JSON.parse(list);
        } catch {
            throw new Error('mapping is not valid JSON');
        }
    }
    if (list && !Array.isArray(list) && typeof list === 'object') {
        list = headers.map((header) => list[header] ?? 'ignore');
    }
    if (!Array.isArray(list)) throw new Error('mapping must be a list of column targets');
    const out = headers.map((_, i) => {
        const target = String(list[i] ?? 'ignore').trim();
        if (['phone', 'name', 'email', 'tags', 'ignore'].includes(target)) return target;
        if (target.startsWith('custom:') && target.slice(7).trim()) return `custom:${target.slice(7).trim()}`;
        throw new Error(`unknown target "${target}" for column ${i + 1}`);
    });
    for (const single of ['phone', 'name', 'email']) {
        if (out.filter((t) => t === single).length > 1) throw new Error(`only one column can be ${single}`);
    }
    if (!out.includes('phone')) throw new Error('map one column to phone');
    return out;
}

/** Rows to contacts under an explicit mapping: same validation as the importer. */
export function mappedRowsToContacts(rows, mapping, defaultCountryCode = '') {
    const result = { contacts: [], errors: [], duplicates: 0, detectedVariables: [] };
    const seen = new Set();
    rows.forEach((cells, index) => {
        const lineNumber = index + 2;
        const contact = { name: '', email: '', phone: '', tags: [], customFields: {} };
        let phoneRaw = '';
        mapping.forEach((target, i) => {
            const value = String(cells[i] ?? '').trim();
            if (target === 'phone') phoneRaw = value;
            else if (target === 'name') contact.name = value;
            else if (target === 'email') contact.email = value;
            else if (target === 'tags') contact.tags.push(...value.split(/[,;|]/).map((t) => t.trim()).filter(Boolean));
            else if (target.startsWith('custom:') && value) contact.customFields[target.slice(7)] = value;
        });
        if (!phoneRaw) {
            result.errors.push(`Row ${lineNumber}: missing phone number`);
            return;
        }
        try {
            contact.phone = normalizePhone(phoneRaw, defaultCountryCode);
        } catch (err) {
            if (!(err instanceof PhoneError)) throw err;
            result.errors.push(`Row ${lineNumber}: ${err.message}`);
            return;
        }
        if (seen.has(contact.phone)) {
            result.duplicates += 1;
            return;
        }
        seen.add(contact.phone);
        result.contacts.push(contact);
    });
    result.detectedVariables = ['name', 'phone',
        ...mapping.filter((t) => t.startsWith('custom:')).map((t) => t.slice(7))];
    return result;
}

// ------------------------------------------------------------- export --
/**
 * One CSV cell: quoted when it holds a quote, comma or newline, and defused
 * when a spreadsheet would read it as a formula (= + - @, tab, CR).
 */
export function csvCell(value) {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function contactsToCsv(contacts) {
    const keys = [...new Set(contacts.flatMap((c) => Object.keys(c.customFields ?? {})))].sort();
    const header = ['name', 'phone', 'email', 'tags', 'opt_in_status', 'opted_out', 'status', 'source',
        'created_at', ...keys];
    const lines = [header.map(csvCell).join(',')];
    for (const c of contacts) {
        lines.push([
            c.name, c.phone, c.email, (c.tags ?? []).join(', '), c.optInStatus, c.optedOut ? 'yes' : 'no',
            c.status, c.source, c.createdAt, ...keys.map((k) => c.customFields?.[k] ?? ''),
        ].map(csvCell).join(','));
    }
    // BOM so Excel opens UTF-8 names correctly.
    return `\uFEFF${lines.join('\r\n')}\r\n`;
}
