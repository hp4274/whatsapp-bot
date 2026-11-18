/**
 * One-time codes sent on WhatsApp (the OTP service). A business's own backend asks for a code through /v1/otp and
 * verifies what its customer typed; we keep the attempt, never the code: only sha256(id + code) is stored, so a
 * leaked database cannot be replayed.
 *
 * Codes are per business, not per number: one sent from any linked number verifies the same way.
 */

import crypto from 'node:crypto';

export const DEFAULT_TEMPLATE = '{code} is your {brand} verification code. It expires in {minutes} minutes. Do not share this code with anyone.';

export const DEFAULT_OTP = Object.freeze({
    brand: '',
    template: DEFAULT_TEMPLATE,
    length: 6,
    ttlMinutes: 10,
    maxAttempts: 5,
    resendSeconds: 30,
});

const TABLES = `
CREATE TABLE IF NOT EXISTS otp_config (
    tenant_id   INTEGER PRIMARY KEY,
    settings    TEXT NOT NULL DEFAULT '{}',
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_codes (
    id           TEXT PRIMARY KEY,
    tenant_id    INTEGER NOT NULL,
    phone        TEXT NOT NULL,
    code_hash    TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    purpose      TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    source       TEXT NOT NULL,
    error        TEXT,
    created_at   TEXT NOT NULL,
    expires_at   TEXT NOT NULL,
    verified_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_otp_phone ON otp_codes(tenant_id, phone, created_at);
CREATE INDEX IF NOT EXISTS idx_otp_created ON otp_codes(tenant_id, created_at);
`;

export class OtpError extends Error {
    /** `code` is the v1 error name (invalid_phone, resend_too_soon...); `extra` is merged into the v1 body. */
    constructor(message, status = 400, code = 'invalid_request', extra = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

const hash = (id, code) => crypto.createHash('sha256').update(`${id}:${code}`).digest();
const monthStart = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

export class OtpStore {
    /** @param {import('../db.js').Database} database a tenant- or channel-scoped handle */
    constructor(database) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.db.exec(TABLES);
        // Where an API send came from (the key, the caller's IP, its app and site), added after the table shipped.
        const cols = this.db.prepare('PRAGMA table_info(otp_codes)').all().map((c) => c.name);
        for (const [col, type] of [['key_id', 'INTEGER'], ['client_ip', 'TEXT'], ['client_app', 'TEXT'], ['client_site', 'TEXT']]) {
            if (!cols.includes(col)) this.db.exec(`ALTER TABLE otp_codes ADD COLUMN ${col} ${type}`);
        }
    }

    settings() {
        const row = this.db.prepare('SELECT settings FROM otp_config WHERE tenant_id = ?').get(this.tenantId);
        return { ...DEFAULT_OTP, ...parse(row?.settings) };
    }

    saveSettings(patch = {}, { maxTtlMinutes = 30 } = {}) {
        const next = cleanSettings({ ...this.settings(), ...patch }, maxTtlMinutes);
        this.db.prepare(`INSERT INTO otp_config (tenant_id, settings, updated_at) VALUES (?, ?, ?)
                         ON CONFLICT(tenant_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at`)
            .run(this.tenantId, JSON.stringify(next), new Date().toISOString());
        return next;
    }

    /** A new pending code for `phone`; that phone's older pending codes stop working. Returns the raw row. */
    create({ phone, code, purpose = null, ttlMinutes, maxAttempts, source, client = null }, now = new Date()) {
        const id = `otp_${crypto.randomBytes(8).toString('hex')}`;
        this.db.prepare("UPDATE otp_codes SET status = 'expired' WHERE tenant_id = ? AND phone = ? AND status = 'pending'").run(this.tenantId, phone);
        this.db.prepare(`INSERT INTO otp_codes (id, tenant_id, phone, code_hash, purpose, max_attempts, source, created_at, expires_at,
                                                key_id, client_ip, client_app, client_site)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, this.tenantId, phone, hash(id, code).toString('hex'), purpose, maxAttempts, source,
                now.toISOString(), new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
                client?.keyId ?? null, client?.ip ?? null, client?.app ?? null, client?.site ?? null);
        return this.row(id);
    }

    markFailed(id, error) {
        this.db.prepare("UPDATE otp_codes SET status = 'failed', error = ? WHERE id = ? AND tenant_id = ?").run(error, id, this.tenantId);
        return this.row(id);
    }

    row(id) {
        return this.db.prepare('SELECT * FROM otp_codes WHERE id = ? AND tenant_id = ?').get(String(id ?? ''), this.tenantId) ?? null;
    }

    /** The phone's newest code that was sent (a refused send never counts towards a limit). */
    lastSent(phone) {
        return this.db.prepare("SELECT * FROM otp_codes WHERE tenant_id = ? AND phone = ? AND status != 'failed' ORDER BY created_at DESC, rowid DESC LIMIT 1")
            .get(this.tenantId, phone) ?? null;
    }

    sentSince({ phone = null, since }) {
        return this.db.prepare(`SELECT COUNT(*) AS n FROM otp_codes WHERE tenant_id = ? AND status != 'failed' AND created_at >= ?
                                ${phone ? 'AND phone = ?' : ''}`)
            .get(...[this.tenantId, since, ...(phone ? [phone] : [])]).n;
    }

    sentThisMonth(now = new Date()) {
        return this.sentSince({ since: monthStart(now) });
    }

    /**
     * Check `code` against the row `id`, or the phone's newest pending one. Returns { valid: true, id } or
     * { valid: false, reason, attemptsLeft? }. A wrong code spends an attempt; the last one blocks the code.
     */
    verify({ id = null, phone = null, code }, now = new Date()) {
        const row = id
            ? this.row(id)
            // The phone's newest sent code, whatever its state: a second check of a used code says "already_used".
            : this.db.prepare("SELECT * FROM otp_codes WHERE tenant_id = ? AND phone = ? AND status != 'failed' ORDER BY created_at DESC, rowid DESC LIMIT 1")
                .get(this.tenantId, phone) ?? null;
        if (!row || row.status === 'failed') return { valid: false, reason: 'not_found' };
        if (row.status === 'verified') return { valid: false, reason: 'already_used' };
        if (row.status === 'blocked') return { valid: false, reason: 'too_many_attempts', attemptsLeft: 0 };
        if (row.status === 'expired' || Date.parse(row.expires_at) <= now.getTime()) return { valid: false, reason: 'expired' };
        if (crypto.timingSafeEqual(hash(row.id, String(code)), Buffer.from(row.code_hash, 'hex'))) {
            this.db.prepare("UPDATE otp_codes SET status = 'verified', verified_at = ? WHERE id = ?").run(now.toISOString(), row.id);
            return { valid: true, id: row.id };
        }
        const attempts = row.attempts + 1;
        const blocked = attempts >= row.max_attempts;
        this.db.prepare('UPDATE otp_codes SET attempts = ?, status = ? WHERE id = ?').run(attempts, blocked ? 'blocked' : 'pending', row.id);
        return blocked
            ? { valid: false, reason: 'too_many_attempts', attemptsLeft: 0 }
            : { valid: false, reason: 'wrong_code', attemptsLeft: row.max_attempts - attempts };
    }

    recent(limit = 50, now = new Date()) {
        return this.db.prepare('SELECT * FROM otp_codes WHERE tenant_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
            .all(this.tenantId, limit).map((row) => toView(row, now));
    }

    stats(now = new Date()) {
        const since = monthStart(now);
        const count = (where, ...args) => this.db.prepare(`SELECT COUNT(*) AS n FROM otp_codes WHERE tenant_id = ? AND ${where}`).get(this.tenantId, ...args).n;
        return {
            sentMonth: this.sentThisMonth(now),
            verifiedMonth: count("status = 'verified' AND created_at >= ?", since),
            failedMonth: count("status = 'failed' AND created_at >= ?", since),
            pending: count("status = 'pending' AND expires_at > ?", now.toISOString()),
        };
    }
}

/** The status a caller sees: a pending code past its time reads as expired. */
export const statusOf = (row, now = new Date()) => (row.status === 'pending' && Date.parse(row.expires_at) <= now.getTime() ? 'expired' : row.status);

/** A row for the business's own dashboard: its customer's full number, and where an API send came from. */
export function toView(row, now = new Date()) {
    return {
        id: row.id, phone: row.phone, status: statusOf(row, now), purpose: row.purpose ?? null, attempts: row.attempts,
        createdAt: row.created_at, expiresAt: row.expires_at, verifiedAt: row.verified_at ?? null, source: row.source, error: row.error ?? null,
        client: row.source === 'api' ? { keyId: row.key_id ?? null, ip: row.client_ip ?? null, app: row.client_app ?? null, site: row.client_site ?? null } : null,
    };
}

/**
 * The places the API is called from over the last `days`: one line per key + IP + app + site, newest first, with how
 * many codes it sent and how many were verified.
 */
export function connections(store, days = 30, now = new Date()) {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    return store.db.prepare(`SELECT key_id AS keyId, client_ip AS ip, client_app AS app, client_site AS site,
            COUNT(*) AS sent, SUM(status = 'verified') AS verified, MIN(created_at) AS firstAt, MAX(created_at) AS lastAt
        FROM otp_codes WHERE tenant_id = ? AND source = 'api' AND created_at >= ?
        GROUP BY key_id, client_ip, client_app, client_site ORDER BY lastAt DESC LIMIT 20`).all(store.tenantId, since);
}

/** "python-requests/2.31", "curl/8.4", "Chrome", "node"... from a User-Agent; null when there is none. */
export function appOf(userAgent) {
    const ua = String(userAgent ?? '').trim();
    if (!ua) return null;
    if (/^Mozilla\//.test(ua)) {
        const browser = [['Edg/', 'Edge'], ['OPR/', 'Opera'], ['Firefox/', 'Firefox'], ['Chrome/', 'Chrome'], ['Safari/', 'Safari']]
            .find(([needle]) => ua.includes(needle));
        return `${browser ? browser[1] : 'A browser'} (from a web page)`;
    }
    return ua.split(/\s+/)[0].slice(0, 60);
}

/** The website's host from Origin or Referer (browsers send them; a server usually does not). */
export function siteOf(origin, referer) {
    for (const v of [origin, referer]) {
        try {
            if (v && v !== 'null') return new URL(v).host.slice(0, 120);
        } catch {
            // not a URL; try the next one
        }
    }
    return null;
}

const int = (v, lo, hi, name) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new OtpError(`${name} must be a whole number from ${lo} to ${hi}`);
    return n;
};

function cleanSettings(s, maxTtlMinutes) {
    const template = String(s.template ?? '').trim();
    if (!template) throw new OtpError('the message is required');
    if (template.length > 500) throw new OtpError('the message can be up to 500 characters');
    if (!template.includes('{code}')) throw new OtpError('the message must contain {code}');
    const brand = String(s.brand ?? '').trim();
    if (brand.length > 40) throw new OtpError('the brand name can be up to 40 characters');
    return {
        brand,
        template,
        length: int(s.length, 4, 8, 'code length'),
        ttlMinutes: Math.min(int(s.ttlMinutes, 1, 30, 'expiry (minutes)'), maxTtlMinutes),
        maxAttempts: int(s.maxAttempts, 1, 10, 'attempts'),
        resendSeconds: int(s.resendSeconds, 0, 600, 'resend wait (seconds)'),
    };
}

function parse(value) {
    try {
        return value ? JSON.parse(value) : {};
    } catch {
        return {};
    }
}
