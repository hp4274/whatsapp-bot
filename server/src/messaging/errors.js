/**
 * One vocabulary for "why did that send fail".
 *
 * Each transport throws its own thing: a `TransportError` with a provider
 * payload, a Cloud API error code, a Puppeteer stack.  Callers upstream should
 * never branch on which.  `normalizeError` turns all of it into a small fixed
 * set, so retry policy, the UI and (Phase 18) alerting all read one field.
 */

import { TransportConnectionError, TransportError } from '../transports/base.js';

export const ErrorCode = Object.freeze({
    /** The channel is not connected, or the session dropped mid-send. */
    DISCONNECTED: 'DISCONNECTED',
    /** Provider said slow down. Always worth retrying. */
    RATE_LIMITED: 'RATE_LIMITED',
    /** Credentials are wrong or expired. Retrying will not help. */
    AUTH: 'AUTH',
    /** The number is not on WhatsApp, or is not reachable. */
    INVALID_RECIPIENT: 'INVALID_RECIPIENT',
    /** Outside the 24h window, or the template is unapproved. */
    TEMPLATE_REQUIRED: 'TEMPLATE_REQUIRED',
    /** Provider is down or timed out. */
    PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
    /** We stopped it: operator pause, quota, shutdown. */
    CANCELLED: 'CANCELLED',
    /** Anything we have not taught this function yet. */
    UNKNOWN: 'UNKNOWN',
});

/** Codes that are worth another attempt. Everything else fails fast. */
const RETRYABLE = new Set([
    ErrorCode.DISCONNECTED,
    ErrorCode.RATE_LIMITED,
    ErrorCode.PROVIDER_UNAVAILABLE,
]);

// Meta Cloud API error codes worth recognising by number.
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const CLOUD_API_CODES = new Map([
    [4, ErrorCode.RATE_LIMITED],
    [80007, ErrorCode.RATE_LIMITED],
    [130429, ErrorCode.RATE_LIMITED],
    [131048, ErrorCode.RATE_LIMITED],
    [131056, ErrorCode.RATE_LIMITED],
    [190, ErrorCode.AUTH],
    [401, ErrorCode.AUTH],
    [131026, ErrorCode.INVALID_RECIPIENT],
    [131051, ErrorCode.INVALID_RECIPIENT],
    [131047, ErrorCode.TEMPLATE_REQUIRED],
    [132000, ErrorCode.TEMPLATE_REQUIRED],
    [132001, ErrorCode.TEMPLATE_REQUIRED],
    [131000, ErrorCode.PROVIDER_UNAVAILABLE],
    [500, ErrorCode.PROVIDER_UNAVAILABLE],
    [503, ErrorCode.PROVIDER_UNAVAILABLE],
]);

/**
 * @returns {{ code: string, retryable: boolean, detail: string, providerCode: number|null }}
 */
export function normalizeError(err) {
    if (!err) return { code: ErrorCode.UNKNOWN, retryable: false, detail: '', providerCode: null };

    const detail = String(err.message ?? err);
    const providerCode = pickProviderCode(err);

    if (err instanceof TransportConnectionError) {
        return finish(ErrorCode.DISCONNECTED, detail, providerCode, err.retryable);
    }

    if (providerCode !== null && CLOUD_API_CODES.has(providerCode)) {
        return finish(CLOUD_API_CODES.get(providerCode), detail, providerCode);
    }

    // The transports already classify retryability; keep their answer when the
    // code is one we do not recognise, rather than overriding it with a guess.
    const guess = fromText(detail);
    if (err instanceof TransportError) {
        return finish(guess, detail, providerCode, guess === ErrorCode.UNKNOWN ? err.retryable : undefined);
    }
    return finish(guess, detail, providerCode);
}

function finish(code, detail, providerCode, retryableOverride) {
    return {
        code,
        retryable: retryableOverride === undefined ? RETRYABLE.has(code) : Boolean(retryableOverride),
        detail,
        providerCode,
    };
}

function pickProviderCode(err) {
    const raw = err.providerCode ?? err.code ?? err.status ?? err.statusCode
        ?? err.response?.error?.code ?? err.body?.error?.code;
    // Number(null) is 0 and Number('') is 0, so guard before coercing: a
    // missing code must stay missing, not become error code 0.
    if (raw === null || raw === undefined || raw === '') return null;
    const num = Number(raw);
    return Number.isInteger(num) ? num : null;
}

/** Last resort: the message text is all some transports give us. */
function fromText(detail) {
    const text = detail.toLowerCase();
    if (/rate.?limit|too many requests|throttl/.test(text)) return ErrorCode.RATE_LIMITED;
    if (/unauthori|invalid.*(token|credential)|expired.*token|forbidden/.test(text)) return ErrorCode.AUTH;
    if (/not.*(on whatsapp|a valid whatsapp)|invalid.*(recipient|phone|number)/.test(text)) return ErrorCode.INVALID_RECIPIENT;
    if (/template|24.?hour window|outside.*window/.test(text)) return ErrorCode.TEMPLATE_REQUIRED;
    if (/timeout|timed out|econnreset|enotfound|socket hang up|unavailable|bad gateway/.test(text)) {
        return ErrorCode.PROVIDER_UNAVAILABLE;
    }
    if (/disconnect|not connected|session closed|session expired/.test(text)) return ErrorCode.DISCONNECTED;
    if (/stopped by operator|cancelled|canceled|shutting down/.test(text)) return ErrorCode.CANCELLED;
    return ErrorCode.UNKNOWN;
}
