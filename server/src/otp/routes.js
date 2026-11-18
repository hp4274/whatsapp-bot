/**
 * HTTP for WhatsApp OTP: the dashboard page (/otp, mounted per channel runtime, gated on the `otp` service by app.js)
 * and the public /v1/otp routes, mounted by publicapi/routes.js behind its API key, scope and idempotency checks.
 *
 * A code goes out as an urgent transactional message, so it jumps any campaign queued on the same number.
 */

import crypto from 'node:crypto';

import express from 'express';

import { ruleCap } from '../policy/modules.js';
import { PhoneError, normalizePhone } from '../protocol.js';
import { ApiKeyError } from '../publicapi/keys.js';
import { deliver } from '../school/routes.js';
import { OtpError, OtpStore, appOf, connections, siteOf, statusOf, toView } from './store.js';

const SCOPE = 'otp:send';

/** The platform's OTP rules (policy/modules.js), as the page and the send need them. */
export function otpRules(state) {
    const p = state.platformPolicy?.() ?? {};
    const maxTtl = Number(p['otp.maxTtlMinutes']);
    return {
        maxPerPhoneHour: ruleCap(p, 'otp.maxPerPhoneHour'),
        maxPerMonth: ruleCap(p, 'otp.maxPerMonth'),
        allowCustomCode: p['otp.allowCustomCode'] !== false,
        maxTtlMinutes: Number.isInteger(maxTtl) && maxTtl > 0 ? maxTtl : 30,
    };
}

const clamp = (value, lo, hi, fallback, name) => {
    if (value === undefined || value === null || value === '') return fallback;
    const n = Number(value);
    if (!Number.isInteger(n)) throw new OtpError(`${name} must be a whole number`);
    return Math.min(Math.max(n, lo), hi);
};

/**
 * Send one code. Throws OtpError (with its v1 `code`) when it is refused before sending; a send the message service
 * turns away is saved as failed and also thrown. Returns the stored row.
 */
export function sendOtp(state, input = {}, source = 'api', now = new Date(), client = null) {
    const store = new OtpStore(state.db);
    const rules = otpRules(state);
    const settings = store.settings();
    let phone;
    try {
        phone = normalizePhone(input.phone, state.config.defaultCountryCode);
    } catch (err) {
        if (!(err instanceof PhoneError)) throw err;
        throw new OtpError(err.message, 400, 'invalid_phone');
    }
    let code;
    if (input.code !== undefined && input.code !== null && input.code !== '') {
        if (!rules.allowCustomCode) throw new OtpError('Your plan does not allow sending your own code; leave "code" out.', 403, 'custom_code_not_allowed');
        code = String(input.code).trim();
        if (!/^\d{4,8}$/.test(code)) throw new OtpError('code must be 4 to 8 digits', 400, 'invalid_code');
    } else {
        const length = clamp(input.length, 4, 8, settings.length, 'length');
        code = String(crypto.randomInt(0, 10 ** length)).padStart(length, '0');
    }
    const ttlMinutes = clamp(input.ttlMinutes, 1, rules.maxTtlMinutes, Math.min(settings.ttlMinutes, rules.maxTtlMinutes), 'ttlMinutes');
    const purpose = input.purpose == null || input.purpose === '' ? null : String(input.purpose).trim().slice(0, 60) || null;

    if (!state.transport?.isConnected?.()) throw new OtpError('The WhatsApp number is not connected.', 503, 'whatsapp_not_connected');
    const last = store.lastSent(phone);
    const wait = last ? Math.ceil((Date.parse(last.created_at) + settings.resendSeconds * 1000 - now.getTime()) / 1000) : 0;
    if (wait > 0) throw new OtpError(`Wait ${wait} seconds before sending another code to this number.`, 429, 'resend_too_soon', { retryAfter: wait });
    if (rules.maxPerPhoneHour !== null
        && store.sentSince({ phone, since: new Date(now.getTime() - 3_600_000).toISOString() }) >= rules.maxPerPhoneHour) {
        throw new OtpError(`This number has had ${rules.maxPerPhoneHour} codes in the last hour. Try again later.`, 429, 'phone_rate_limited');
    }
    if (rules.maxPerMonth !== null && store.sentThisMonth(now) >= rules.maxPerMonth) {
        throw new OtpError(`Your plan allows ${rules.maxPerMonth} codes a month, and you have reached it.`, 429, 'monthly_limit');
    }

    const row = store.create({ phone, code, purpose, ttlMinutes, maxAttempts: settings.maxAttempts, source, client }, now);
    const brand = settings.brand || state.tenancy?.getTenant(state.db.tenantId)?.name || '';
    const text = settings.template.replaceAll('{code}', code).replaceAll('{brand}', brand).replaceAll('{minutes}', String(ttlMinutes));
    const outcome = deliver(state, { recipient: phone, text, key: `otp.${row.id}`, messageType: 'transactional', urgent: true });
    if (outcome !== 'sent') {
        const error = outcome === 'failed' ? 'The message could not be built.' : 'WhatsApp sending refused it (the number may have opted out).';
        const failed = store.markFailed(row.id, error);
        state.broadcast?.({ type: 'changed', topic: 'otp' });
        throw new OtpError(error, 422, 'send_failed', { id: failed.id });
    }
    state.broadcast?.({ type: 'changed', topic: 'otp' });
    return row;
}

export function createOtpRouter({ db, state }) {
    const app = express.Router();
    const store = () => new OtpStore(db);
    const changed = () => state.broadcast?.({ type: 'changed', topic: 'otp' });
    const fail = (res, err) => {
        if (err instanceof OtpError || err instanceof ApiKeyError) return res.status(err.status).json({ errors: [err.message] });
        throw err;
    };
    const otpKeys = () => (state.apiKeys?.list() ?? []).filter((k) => k.scopes.includes(SCOPE));

    app.get('/otp', (req, res) => {
        const s = store();
        res.json({
            settings: s.settings(),
            stats: s.stats(),
            recent: s.recent(50),
            connections: connections(s),
            keys: otpKeys(),
            connected: Boolean(state.transport?.isConnected?.()),
            rules: otpRules(state),
        });
    });

    app.put('/otp/settings', (req, res) => {
        try {
            const settings = store().saveSettings(req.body ?? {}, { maxTtlMinutes: otpRules(state).maxTtlMinutes });
            changed();
            res.json({ settings });
        } catch (err) {
            fail(res, err);
        }
    });

    app.post('/otp/keys', (req, res) => {
        try {
            const key = state.apiKeys.createKey({ name: req.body?.name ?? '', scopes: [SCOPE] });
            changed();
            res.status(201).json({ key });
        } catch (err) {
            fail(res, err);
        }
    });

    app.delete('/otp/keys/:id', (req, res) => {
        try {
            if (!otpKeys().some((k) => k.id === Number(req.params.id))) return res.status(404).json({ errors: ['api key not found'] });
            const key = state.apiKeys.revoke(req.params.id);
            changed();
            res.json({ key });
        } catch (err) {
            fail(res, err);
        }
    });

    app.post('/otp/test', (req, res) => {
        try {
            const row = sendOtp(state, { phone: req.body?.phone, purpose: 'test' }, 'test');
            res.status(201).json({ otp: toView(row) });
        } catch (err) {
            fail(res, err);
        }
    });

    /** Check a test code from the page: the same check the API's /v1/otp/verify makes, plus the row as it now stands. */
    app.post('/otp/test/verify', (req, res) => {
        const { id, code } = req.body ?? {};
        if (!id || !String(code ?? '').trim()) return res.status(400).json({ errors: ['Type the code from WhatsApp.'] });
        const store = new OtpStore(state.db);
        const result = store.verify({ id: String(id), code: String(code).trim() });
        if (result.valid || result.reason === 'wrong_code' || result.reason === 'too_many_attempts') state.broadcast?.({ type: 'changed', topic: 'otp' });
        const row = store.row(String(id));
        return res.json({ result, otp: row ? toView(row) : null });
    });

    return app;
}

/** The /v1/otp routes on the public API's v1 router; `scope` is its scope check. */
export function mountOtpApi(v1, { state, scope }) {
    const fail = (res, err) => {
        if (!(err instanceof OtpError)) throw err;
        return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
    };

    v1.post('/otp/send', scope(SCOPE), (req, res) => {
        try {
            const { phone, purpose, code, length, ttlMinutes } = req.body ?? {};
            // Where the call came from, for the business's "Where your API is used" panel.
            const client = { keyId: req.apiKey?.id ?? null, ip: req.ip ?? null, app: appOf(req.get('user-agent')), site: siteOf(req.get('origin'), req.get('referer')) };
            const row = sendOtp(state, { phone, purpose, code, length, ttlMinutes }, 'api', new Date(), client);
            const resendSeconds = new OtpStore(state.db).settings().resendSeconds;
            return res.status(201).json({
                id: row.id, phone: row.phone, status: 'sent', expiresAt: row.expires_at,
                resendAfter: new Date(Date.parse(row.created_at) + resendSeconds * 1000).toISOString(),
            });
        } catch (err) {
            return fail(res, err);
        }
    });

    v1.post('/otp/verify', scope(SCOPE), (req, res) => {
        try {
            const { id, phone, code } = req.body ?? {};
            if (code === undefined || code === null || String(code).trim() === '') throw new OtpError('code is required', 400, 'invalid_code');
            let normalized = null;
            if (!id) {
                try {
                    normalized = normalizePhone(phone, state.config.defaultCountryCode);
                } catch (err) {
                    if (!(err instanceof PhoneError)) throw err;
                    throw new OtpError('Give the id from the send, or the phone.', 400, 'invalid_phone');
                }
            }
            const result = new OtpStore(state.db).verify({ id: id ? String(id) : null, phone: normalized, code: String(code).trim() });
            if (result.valid || result.reason === 'wrong_code' || result.reason === 'too_many_attempts') state.broadcast?.({ type: 'changed', topic: 'otp' });
            return res.json(result);
        } catch (err) {
            return fail(res, err);
        }
    });

    v1.get('/otp/:id', scope(SCOPE), (req, res) => {
        const row = new OtpStore(state.db).row(req.params.id);
        if (!row) return res.status(404).json({ error: 'not_found', message: 'otp not found' });
        return res.json({ id: row.id, status: statusOf(row), expiresAt: row.expires_at, verifiedAt: row.verified_at ?? null, attempts: row.attempts });
    });
}
