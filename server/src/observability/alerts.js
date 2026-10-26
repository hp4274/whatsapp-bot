/**
 * Ops alerts: one channel for the things an operator must hear about (a number logged out or banned, a
 * halting brake, a stalled queue, a failed backup or re-encryption).
 *
 * Every alert is written to `logger.error` and to the audit log (action `ops.alert`). When
 * `OPS_ALERT_WEBHOOK` is set it is also POSTed there as JSON, signed like the customer webhooks
 * (publicapi/webhooks.js signPayload): `X-Signature: t=<unix s>,v1=<hmac>` with `OPS_ALERT_SECRET`,
 * plus `,v0=<hmac>` with `OPS_ALERT_SECRET_PREVIOUS` while a secret is being changed (docs/OPS.md).
 *
 * Limits on what is POSTed (the log and the audit row always happen): 1 per kind per number per hour,
 * 30 per hour across the platform. Anything over is counted, and `tick()` sends one `held_back`
 * summary per hour with the counts by kind.
 *
 * ponytail: the limits live in this process's memory; a restart starts them afresh.
 */

import { signPayload } from '../publicapi/webhooks.js';
import { logger as rootLogger } from './logger.js';

const HOUR_MS = 3_600_000;
export const ALERT_LIMITS = Object.freeze({ perNumberPerHour: 1, platformPerHour: 30 });

/** `t=…,v1=<current>[,v0=<previous>]` over `<t>.<body>`. */
export function alertSignature(body, secret, previousSecret = '', timestampMs = Date.now()) {
    const header = signPayload(body, secret, timestampMs);
    return previousSecret ? `${header},v0=${signPayload(body, previousSecret, timestampMs).split(',v1=')[1]}` : header;
}

/**
 * @param {object} opts
 * @param {(entry: {tenantId, action, target, detail}) => void} [opts.audit] tenancy.audit
 * @returns {{ raise: (alert: object) => Promise<boolean>, tick: () => Promise<boolean>, heldBack: () => object }}
 *   `raise` resolves true when the alert was POSTed.
 */
export function createOpsAlerts({
    url = process.env.OPS_ALERT_WEBHOOK, secret = process.env.OPS_ALERT_SECRET,
    previousSecret = process.env.OPS_ALERT_SECRET_PREVIOUS, audit = () => {}, log = rootLogger,
    fetch = globalThis.fetch, now = () => Date.now(), timeoutMs = 10_000,
} = {}) {
    const lastByKey = new Map(); // `${kind}:${tenantId}:${channelId}` -> ms of the last POST
    let sent = []; // ms of each POST in the last hour (platform limit)
    let held = {}; // kind -> count held back since heldSince
    let heldSince = 0;

    const post = async (payload) => {
        if (!url) return false;
        const body = JSON.stringify(payload);
        const headers = { 'content-type': 'application/json' };
        if (secret) headers['x-signature'] = alertSignature(body, secret, previousSecret, now());
        try {
            const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) log.warn('ops alert webhook refused', { status: res.status, kind: payload.kind });
            return res.ok;
        } catch (err) {
            log.warn('ops alert webhook failed', { error: err.message, kind: payload.kind });
            return false;
        }
    };

    const record = (payload, outcome) => {
        // `summary`, not `text`: the logger redacts any field named text (message bodies never reach a log).
        const { text, ...rest } = payload;
        log.error(`ops alert: ${payload.kind}${payload.shadow ? ' (shadow)' : ''}`, { alert: { ...rest, summary: text }, outcome });
        try {
            audit({
                tenantId: payload.tenantId ?? null, action: 'ops.alert',
                target: payload.channelId == null ? payload.kind : `${payload.kind}:channel-${payload.channelId}`,
                detail: { ...payload, outcome },
            });
        } catch (err) {
            log.warn('ops alert audit failed', { error: err.message });
        }
    };

    /** One summary an hour of what the limits held back. Resolves true when it was sent. */
    const tick = async () => {
        if (!heldSince || now() - heldSince < HOUR_MS) return false;
        const byKind = held;
        const total = Object.values(byKind).reduce((a, b) => a + b, 0);
        held = {};
        heldSince = 0;
        const payload = {
            kind: 'held_back', tenantId: null, channelId: null, shadow: false, at: new Date(now()).toISOString(),
            text: `${total} alerts held back in the last hour`, total, byKind,
        };
        record(payload, 'sent');
        sent.push(now());
        return post(payload);
    };

    /**
     * @param {{ kind: string, tenantId?: number, channelId?: number, number?: string, shadow?: boolean,
     *   text?: string, detail?: string }} alert
     */
    const raise = async (alert) => {
        const t = now();
        const payload = {
            kind: String(alert.kind), tenantId: alert.tenantId ?? null, channelId: alert.channelId ?? null,
            number: alert.number ? `…${String(alert.number).replace(/\D/g, '').slice(-4)}` : null,
            shadow: Boolean(alert.shadow), at: new Date(t).toISOString(),
            text: alert.text ?? '', detail: alert.detail ?? '',
        };
        sent = sent.filter((at) => t - at < HOUR_MS);
        const key = `${payload.kind}:${payload.tenantId}:${payload.channelId}`;
        const limited = t - (lastByKey.get(key) ?? -Infinity) < HOUR_MS || sent.length >= ALERT_LIMITS.platformPerHour;
        record(payload, limited ? 'held_back' : 'sent');
        if (limited) {
            held[payload.kind] = (held[payload.kind] ?? 0) + 1;
            if (!heldSince) heldSince = t;
            await tick();
            return false;
        }
        lastByKey.set(key, t);
        sent.push(t);
        return post(payload);
    };

    return { raise, tick, heldBack: () => ({ ...held }) };
}
