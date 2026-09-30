/**
 * Shared domain vocabulary: message status, phone rules, personalisation.
 *
 * Kept small so the transports, the campaign engine, the importers and the
 * tests all agree on the same words.  Ported 1:1 from the Python application's
 * protocol module, with campaign spintax applied before variable substitution.
 */

import { parseSpintax } from './campaign/spintax.js';

/**
 * Transport states.  SENT/DELIVERED/READ are only ever written when a
 * transport actually reports them.  SANDBOX is a separate state used by the
 * local test transport, so a fake send can never be read as a real one.
 */
export const Status = Object.freeze({
    QUEUED: 'QUEUED',
    SENDING: 'SENDING',
    SENT: 'SENT',
    DELIVERED: 'DELIVERED',
    READ: 'READ',
    FAILED: 'FAILED',
    SANDBOX: 'SANDBOX',
});

/** Ranking that stops a late receipt from downgrading a message. */
export const STATUS_RANK = Object.freeze({
    QUEUED: 0,
    SENDING: 1,
    SANDBOX: 2,
    SENT: 2,
    DELIVERED: 3,
    READ: 4,
    FAILED: 5,
});

export const SUCCESS_STATUSES = Object.freeze([Status.SENT, Status.DELIVERED, Status.READ]);
export const TERMINAL_STATUSES = Object.freeze([Status.DELIVERED, Status.READ, Status.FAILED]);

export function utcNow() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export function newMessageId() {
    return crypto.randomUUID().replace(/-/g, '');
}

// --------------------------------------------------------------- phones --
export class PhoneError extends Error {}

const NON_DIGITS = /[^\d+]/g;
// E.164: leading digit 1-9, 7..15 digits total.  WhatsApp wants the number
// without the leading '+', which is also what the Cloud API's `to` expects.
const E164 = /^[1-9]\d{6,14}$/;

/**
 * Return a bare E.164 number (digits only, no '+', no separators).
 * Accepts '+91 98765-43210', '0091 9876543210', '(987) 654-3210'.
 */
export function normalizePhone(raw, defaultCountryCode = '') {
    if (raw === null || raw === undefined) throw new PhoneError('empty phone number');
    let text = String(raw).trim().replace(NON_DIGITS, '');
    if (!text) throw new PhoneError('empty phone number');

    if (text.startsWith('+')) {
        text = text.slice(1);
    } else if (text.startsWith('00')) {
        text = text.slice(2);
    } else {
        const cc = String(defaultCountryCode || '').replace(NON_DIGITS, '').replace(/^\+/, '');
        if (cc) {
            // National number: strip a single national trunk '0', then prefix.
            const national = text.startsWith('0') ? text.slice(1) : text;
            text = cc + national;
        }
    }

    text = text.replace(/^0+/, '');
    if (!/^\d+$/.test(text)) throw new PhoneError(`not a number: ${raw}`);
    if (!E164.test(text)) throw new PhoneError(`not a valid E.164 number: ${raw} -> ${text}`);
    return text;
}

export function isValidPhone(raw, defaultCountryCode = '') {
    try {
        normalizePhone(raw, defaultCountryCode);
        return true;
    } catch {
        return false;
    }
}

// ------------------------------------------------- contacts + templates --
/**
 * Substitute {name}-style variables.  Unknown placeholders are preserved
 * verbatim rather than blowing up a whole campaign.
 */
export function personalize(template, context = {}) {
    if (!template) return '';
    const fallbackResolved = String(template).replace(/\{(\w+)\|([^{}]*)\}/g, (match, key, fallback) => {
        if (!Object.prototype.hasOwnProperty.call(context, key)) return match;
        const value = context[key];
        if (value === undefined || value === null || String(value) === '') return fallback;
        return String(value);
    });
    return parseSpintax(fallbackResolved).replace(/\{(\w+)\}/g, (match, key) => {
        const value = context[key];
        if (value === undefined || value === null) return match;
        return String(value);
    }).trim();
}

export function contactContext(contact) {
    return { name: contact.name ?? '', phone: contact.phone ?? '', ...(contact.extra ?? {}) };
}

/** Key used for duplicate protection inside one campaign run. */
export function dedupeKey(recipient, message) {
    return `${recipient}|${message}`;
}
