/**
 * API keys: the credential a customer's own software authenticates with.
 *
 * An API key is a session token with a longer life, so it is treated exactly
 * like one (`tenancy.js`): sha256 at rest, handed back in plaintext once at
 * creation and never again, revocable, expiring. If `list()` could ever return
 * something usable, a read-only dashboard bug would be a breach.
 *
 * `verify()` deliberately does NOT filter by tenant, for the same reason
 * `Tenancy.resolveSession` does not: the credential is what selects the
 * tenant. Everything else on this store is scoped to `db.tenantId`, so one
 * tenant's owner cannot list or revoke another's keys.
 *
 * Throttling is not here: app.js applies `v1Limit` (security/signature.js
 * rateLimit, one bucket per key) and the plan's api_requests quota to every
 * /api/v1 call. `touch()` only records `last_used_at`.
 */

import crypto from 'node:crypto';

import { utcNow } from '../protocol.js';

/**
 * Small and real: each one is checked by at least one route, and no route
 * accepts a scope it does not need. A key that can create orders cannot read
 * the contact book.
 */
export const API_SCOPES = Object.freeze([
    'events:write',
    'contacts:read',
    'contacts:write',
    'objects:read',
    'objects:write',
    'tickets:write',
]);

/** Every key starts with this, so one is recognisable in a log or a paste. */
export const KEY_PREFIX = 'wsk_';
const PREFIX_LENGTH = KEY_PREFIX.length + 8;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const DAY_MS = 86_400_000;
/** A key this close to its expiry is flagged `expiringSoon` in the developer screen. */
export const EXPIRY_WARNING_DAYS = 14;

export class ApiKeyError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class ApiKeyStore {
    /** @param {import('../db.js').Database} database a tenant- or channel-scoped handle */
    /**
     * @param {object} [opts]
     * @param {(tenantId?: number) => number} [opts.maxAgeDays] the key's tenant's `security.apiKeyMaxAgeDays`
     *   (0 = no limit): new keys must expire within it, and a key older than it stops working whatever its
     *   own expiry says. Called with the key row's tenant, so an unscoped store (the /api/v1 check) works too.
     */
    constructor(database, { now = () => utcNow(), maxAgeDays = () => 0 } = {}) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.now = now;
        this.maxAgeDays = (tenantId = this.tenantId) => Math.max(0, Number(maxAgeDays(tenantId)) || 0);
    }

    /** When a row stops working: its own expiry or created + max age, whichever is first. ms, or null. */
    #expiryMs(row) {
        const own = row.expires_at ? Date.parse(row.expires_at) : null;
        const max = this.maxAgeDays(row.tenant_id);
        const aged = max ? Date.parse(row.created_at) + max * DAY_MS : null;
        if (own == null) return aged;
        return aged == null ? own : Math.min(own, aged);
    }

    #view(row) {
        const expiry = this.#expiryMs(row);
        const left = expiry == null ? null : expiry - Date.parse(this.now());
        return {
            ...toKey(row),
            expiresAt: expiry == null ? null : new Date(expiry).toISOString(),
            expiringSoon: !row.revoked_at && left != null && left > 0 && left <= EXPIRY_WARNING_DAYS * DAY_MS,
        };
    }

    /**
     * Mint a key. The returned `key` is the only time the plaintext exists
     * outside the customer's config - there is no "show key again" by design.
     */
    createKey({ name = '', scopes = [], expiresAt = null } = {}) {
        const clean = cleanScopes(scopes);
        if (!clean.length) throw new ApiKeyError(`scopes must include at least one of ${API_SCOPES.join(', ')}`);
        const now = this.now();
        let expires = expiresAt == null || expiresAt === '' ? null : isoOrThrow(expiresAt);
        const max = this.maxAgeDays();
        if (max) {
            const latest = new Date(Date.parse(now) + max * DAY_MS).toISOString();
            if (!expires) expires = latest;
            else if (Date.parse(expires) > Date.parse(latest)) {
                throw new ApiKeyError(`expiresAt must be within ${max} days: that is the longest a key may live here`);
            }
        }
        const key = KEY_PREFIX + crypto.randomBytes(24).toString('base64url');
        const info = this.db.prepare(
            `INSERT INTO api_keys (tenant_id, name, key_hash, prefix, scopes, expires_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, String(name ?? '').trim(), sha256(key),
                key.slice(0, PREFIX_LENGTH), JSON.stringify(clean), expires, now);
        return { ...this.get(Number(info.lastInsertRowid)), key };
    }

    /**
     * The tenant and scopes behind a presented key, or null for anything that
     * is not currently usable - unknown, revoked or expired.
     */
    verify(key) {
        if (!key || typeof key !== 'string') return null;
        const row = this.db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(sha256(key));
        if (!row || row.revoked_at) return null;
        // Parsed, not string-compared: `utcNow()` writes "+00:00" where
        // toISOString() writes "Z", and those two do not sort against each other.
        const expiry = this.#expiryMs(row);
        if (expiry != null && expiry <= Date.parse(this.now())) return null;
        return { id: row.id, tenantId: row.tenant_id, scopes: parseScopes(row.scopes) };
    }

    /** Never includes the key or its hash: there is nothing here to steal. */
    list() {
        return this.db.prepare('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY id DESC')
            .all(this.tenantId).map((row) => this.#view(row));
    }

    get(id) {
        const row = this.db.prepare('SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? this.#view(row) : null;
    }

    /** Irreversible, and takes effect on the next request rather than at expiry. */
    revoke(id) {
        const info = this.db.prepare(
            'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND tenant_id = ? AND revoked_at IS NULL')
            .run(this.now(), Number(id), this.tenantId);
        if (!info.changes && !this.get(id)) throw new ApiKeyError('api key not found', 404);
        return this.get(id);
    }

    /** Revoke every live key of this tenant (super admin). Returns how many were revoked. */
    revokeAll() {
        return this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND revoked_at IS NULL')
            .run(this.now(), this.tenantId).changes;
    }

    /**
     * Record use. Not tenant-scoped on purpose: the caller has already proved
     * ownership by presenting the key, and the request may be mid-dispatch
     * before any tenant handle exists.
     */
    touch(id) {
        this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(this.now(), Number(id));
    }
}

/** Reject unknown scopes rather than dropping them: a typo must not silently narrow a key. */
export function cleanScopes(scopes) {
    const list = Array.isArray(scopes) ? scopes : String(scopes ?? '').split(/[,\s]+/);
    const out = [];
    for (const raw of list) {
        const scope = String(raw ?? '').trim();
        if (!scope) continue;
        if (!API_SCOPES.includes(scope)) throw new ApiKeyError(`unknown scope "${scope}"`);
        if (!out.includes(scope)) out.push(scope);
    }
    return out;
}

function isoOrThrow(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new ApiKeyError('expiresAt must be a date-time');
    return date.toISOString();
}

function parseScopes(text) {
    try {
        const value = JSON.parse(text ?? '[]');
        return Array.isArray(value) ? value : [];
    } catch {
        return [];
    }
}

function toKey(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        prefix: row.prefix,
        scopes: parseScopes(row.scopes),
        lastUsedAt: row.last_used_at ?? null,
        expiresAt: row.expires_at ?? null,
        revokedAt: row.revoked_at ?? null,
        createdAt: row.created_at,
    };
}
