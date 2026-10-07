import { normalizeHeader } from './contacts.js';
import { PhoneError, normalizePhone } from './protocol.js';

const NAME_KEYS = ['name', 'full_name', 'fullname', 'customer', 'customer_name', 'person'];
const PHONE_KEYS = ['phone', 'number', 'phone_number', 'mobile', 'mobile_number', 'whatsapp', 'msisdn'];
const AMOUNT_KEYS = [
    'remaining',
    'remaining_amount',
    'payment_due',
    'due_amount',
    'balance',
    'balance_due',
    'amount_due',
    'pending_amount',
    'outstanding',
];
const DUE_DATE_KEYS = ['due_date', 'date', 'payment_date', 'deadline'];
const MESSAGE_KEYS = ['message', 'custom_message', 'reminder_message', 'note', 'notes'];

export const PAYMENT_REMINDER_ALIASES = Object.freeze({
    name: NAME_KEYS,
    phone: PHONE_KEYS,
    remaining: AMOUNT_KEYS,
    dueDate: DUE_DATE_KEYS,
    message: MESSAGE_KEYS,
});

export const DEFAULT_PAYMENT_REMINDER_TEMPLATE =
    'Hi {name}, this is a reminder that your remaining payment amount is {remaining}.'
    + ' Please complete it at your earliest convenience.';

function pick(row, keys) {
    for (const key of keys) {
        const value = row[key];
        if (value !== undefined && value !== null && String(value).trim() !== '') {
            return String(value).trim();
        }
    }
    return '';
}

function normalizeAmount(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { value: '', display: '', error: 'missing remaining payment amount' };

    const compact = text.replace(/,/g, '');
    const matched = compact.match(/-?\d+(?:\.\d+)?/);
    if (!matched) return { value: '', display: text, error: `invalid remaining payment amount: ${text}` };

    const numeric = Number(matched[0]);
    if (!Number.isFinite(numeric)) {
        return { value: '', display: text, error: `invalid remaining payment amount: ${text}` };
    }
    if (numeric < 0) {
        return { value: '', display: text, error: `remaining payment amount cannot be negative: ${text}` };
    }
    return { value: numeric, display: text, error: '' };
}

function normalizeRow(rawRow) {
    const row = {};
    for (const [key, value] of Object.entries(rawRow)) {
        const normalizedKey = normalizeHeader(key);
        if (!normalizedKey) continue;
        row[normalizedKey] = value === null || value === undefined ? '' : String(value).trim();
    }
    return row;
}

function assertUsableHeaders(rows) {
    const headers = new Set();
    for (const rawRow of rows) {
        Object.keys(rawRow).forEach((key) => headers.add(normalizeHeader(key)));
    }
    const hasPhone = PHONE_KEYS.some((key) => headers.has(key));
    const hasAmount = AMOUNT_KEYS.some((key) => headers.has(key));
    const errors = [];
    if (!hasPhone) errors.push(`Missing phone column. Accepted: ${PHONE_KEYS.join(', ')}`);
    if (!hasAmount) errors.push(`Missing remaining amount column. Accepted: ${AMOUNT_KEYS.join(', ')}`);
    return errors;
}

export function rowsToPaymentReminders(rows, defaultCountryCode = '') {
    const headerErrors = assertUsableHeaders(rows);
    if (headerErrors.length) return { reminders: [], errors: headerErrors, duplicates: 0 };

    const result = { reminders: [], errors: [], duplicates: 0 };
    const seen = new Set();

    rows.forEach((rawRow, index) => {
        const lineNumber = index + 2;
        const row = normalizeRow(rawRow);
        if (!Object.values(row).some((value) => value !== '')) return;

        const phoneRaw = pick(row, PHONE_KEYS);
        const amount = normalizeAmount(pick(row, AMOUNT_KEYS));
        if (!phoneRaw) {
            result.errors.push(`Row ${lineNumber}: missing phone number`);
            return;
        }
        if (amount.error) {
            result.errors.push(`Row ${lineNumber}: ${amount.error}`);
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

        const name = pick(row, NAME_KEYS);
        const dueDate = pick(row, DUE_DATE_KEYS);
        const customMessage = pick(row, MESSAGE_KEYS);
        result.reminders.push({
            rowNumber: lineNumber,
            name,
            phone,
            remaining: amount.display,
            remainingValue: amount.value,
            dueDate,
            message: customMessage,
            finalMessage: buildPaymentReminderMessage({
                name,
                phone,
                remaining: amount.display,
                dueDate,
                message: customMessage,
            }),
        });
    });

    return result;
}

export async function importPaymentReminders(filename, buffer, defaultCountryCode = '') {
    if (!/\.xlsx?$|\.xlsm$/i.test(filename)) {
        throw new Error('Payment reminders must be imported from an Excel .xlsx, .xls, or .xlsm file');
    }
    const XLSX = await import('xlsx');
    const book = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = book.SheetNames[0];
    if (!sheetName) return { reminders: [], errors: ['workbook has no sheets'], duplicates: 0 };
    const records = XLSX.utils.sheet_to_json(book.Sheets[sheetName], { defval: '', raw: false });
    return rowsToPaymentReminders(records, defaultCountryCode);
}

export function buildPaymentReminderMessage(reminder) {
    const context = {
        name: reminder.name || 'there',
        phone: reminder.phone ?? '',
        remaining: reminder.remaining ?? '',
        due_date: reminder.dueDate ?? '',
        dueDate: reminder.dueDate ?? '',
    };
    const template = String(reminder.message ?? '').trim() || DEFAULT_PAYMENT_REMINDER_TEMPLATE;
    return template.replace(/\{(\w+)\}/g, (match, key) => {
        const value = context[key];
        return value === undefined || value === null || value === '' ? match : String(value);
    }).trim();
}

export function remindersToContacts(reminders) {
    return reminders.map((reminder) => ({
        name: reminder.name,
        phone: reminder.phone,
        extra: {
            remaining: reminder.remaining,
            due_date: reminder.dueDate,
            dueDate: reminder.dueDate,
            final_message: reminder.finalMessage ?? buildPaymentReminderMessage(reminder),
        },
    }));
}
