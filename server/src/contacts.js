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
