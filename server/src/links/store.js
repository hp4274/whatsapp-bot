/**
 * Tracked links: a campaign message's http(s) URLs become short codes on our
 * own domain, so a tap can be counted before the browser goes on to the real
 * page. Opt-in per campaign (`options.trackLinks`) and only when the server
 * knows its public address (`PUBLIC_BASE_URL`); otherwise text is untouched.
 *
 * ponytail: one platform-wide base URL. A tenant's own short-link domain is a
 * setting to add when someone needs it.
 */

import crypto from 'node:crypto';

import { utcNow } from '../protocol.js';

/** http(s) URLs in free text. Trailing punctuation belongs to the sentence, not the link. */
const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;
const TRAILING = /[.,;:!?)\]}*_~]+$/;
const MAX_URL = 2048;

/** 72 random bits, URL-safe: nobody walks the code space to find someone else's links. */
export const newLinkCode = () => crypto.randomBytes(9).toString('base64url');

/** The shape `newLinkCode` produces (and nothing else reaches the database). */
export const isLinkCode = (code) => /^[A-Za-z0-9_-]{8,32}$/.test(String(code ?? ''));

/**
 * Replace each http(s) URL in `text` with `${baseUrl}/l/<code>`. Pure: the
 * codes come back in `links` and are saved once the message has an id.
 * The same URL twice in one message shares a code; our own links are left alone.
 *
 * @returns {{ text: string, links: {code: string, url: string}[] }}
 */
export function rewriteLinks(text, { baseUrl, makeCode = newLinkCode } = {}) {
    const base = String(baseUrl ?? '').replace(/\/+$/, '');
    const source = String(text ?? '');
    if (!base) return { text: source, links: [] };
    const byUrl = new Map();
    const out = source.replace(URL_RE, (match) => {
        let trail = match.match(TRAILING)?.[0] ?? '';
        let url = match.slice(0, match.length - trail.length);
        // A ')' that closes a '(' inside the URL is part of it (wiki-style links).
        if (trail.startsWith(')') && (url.match(/\(/g) ?? []).length > (url.match(/\)/g) ?? []).length) {
            url += ')';
            trail = trail.slice(1);
        }
        const rest = trail;
        if (url.length > MAX_URL || url.startsWith(`${base}/`)) return match;
        let code = byUrl.get(url);
        if (!code) {
            code = makeCode();
            byUrl.set(url, code);
        }
        return `${base}/l/${code}${rest}`;
    });
    return { text: out, links: [...byUrl].map(([url, code]) => ({ code, url })) };
}

export class LinkStore {
    /**
     * @param {import('../db.js').Database} database a tenant (and channel) scoped handle
     * @param {string} baseUrl the public origin `/l/<code>` is served from
     */
    constructor(database, baseUrl) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.baseUrl = String(baseUrl ?? '').replace(/\/+$/, '');
    }

    rewrite(text) {
        return rewriteLinks(text, { baseUrl: this.baseUrl });
    }

    /** Remember where each code goes, for the message that carries it. */
    save(links, { campaignId = '', messageId = '', recipient = '' } = {}) {
        const insert = this.db.prepare(
            `INSERT OR IGNORE INTO link_codes (code, tenant_id, campaign_id, message_id, recipient, url, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const now = utcNow();
        for (const { code, url } of links ?? []) {
            insert.run(code, this.tenantId, String(campaignId ?? ''), String(messageId ?? ''), String(recipient ?? ''), url, now);
        }
    }
}

/**
 * The public side: where `code` goes, counting the visit when `count` is set.
 * Takes the raw connection - a code is global and selects no tenant. Only a
 * stored http(s) URL is ever returned, so this can never redirect anywhere a
 * campaign did not link to.
 */
export function followLink(db, code, { count = true, now = utcNow() } = {}) {
    if (!isLinkCode(code)) return null;
    const row = db.prepare('SELECT url FROM link_codes WHERE code = ?').get(code);
    if (!row || !/^https?:\/\//i.test(row.url)) return null;
    if (count) {
        db.prepare(`UPDATE link_codes SET clicks = clicks + 1, first_at = COALESCE(first_at, ?), last_at = ?
                    WHERE code = ?`).run(now, now, code);
    }
    return row.url;
}

/** Taps per recipient (digits only) for one campaign key. */
export function linkClicksByRecipient(db, tenantId, campaignId) {
    const rows = db.prepare(
        `SELECT recipient, SUM(clicks) AS n FROM link_codes
         WHERE tenant_id = ? AND campaign_id = ? GROUP BY recipient`).all(tenantId, campaignId);
    return new Map(rows.filter((r) => r.n > 0).map((r) => [String(r.recipient).replace(/\D/g, ''), r.n]));
}
