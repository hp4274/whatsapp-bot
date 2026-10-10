/**
 * Tenants, users, sessions and the audit trail.
 *
 * The tenant is the isolation boundary: every tenant-owned table carries
 * tenant_id and is only reached through `db.forTenant(id)`.  This module is the
 * control plane around that - it never touches tenant data.
 *
 * Roles are a fixed ladder, not a table (ponytail: a permissions table is
 * worth it once roles become customer-editable).
 */

import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { DEFAULTS, POLICY_KEYS, POLICY_SPEC } from './config.js';
import { utcNow } from './protocol.js';

const scrypt = promisify(crypto.scrypt);

export const ROLES = Object.freeze(['agent', 'admin', 'owner', 'super_admin']);
export const roleRank = (role) => ROLES.indexOf(role);

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
/** A session unused this long is dead, whatever its absolute expiry says. */
export const SESSION_IDLE_MS = 12 * 3600 * 1000;
/** last_seen_at is written at most this often, not on every request. */
const SESSION_TOUCH_MS = 60 * 1000;

export const TENANT_SERVICES = Object.freeze([
    'school_whatsapp_bot',
    'whatsapp_channels',
    'contacts',
    'templates',
    'inbox',
    'auto_replies',
    'bulk_messages',
    'campaigns',
    'payment_reminders',
    'workflows',
    'faq',
    'tickets',
    'appointments',
    'orders',
    'leads',
    'subscriptions',
    'events',
    'api',
    'analytics',
    'integrations',
    'ai',
]);

export const DEFAULT_TENANT_CONTROLS = Object.freeze({
    sendingEnabled: true,
    inboundEnabled: true,
    campaignsEnabled: true,
    automationsEnabled: true,
});

export async function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(String(password), salt, 64);
    return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
    const [scheme, salt, hash] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const expected = Buffer.from(hash, 'base64');
    const actual = await scrypt(String(password), Buffer.from(salt, 'base64'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

/**
 * What a tenant agrees to before changing its own sending limits. Changing the
 * text means bumping the version: every tenant must accept again.
 */
export const CONSENT_VERSION = '2026-10-1';
export const CONSENT_TEXT = [
    'WhatsApp may restrict, suspend or permanently ban a phone number that sends fast, high-volume, repetitive or unsolicited messages.',
    'Changing these sending limits removes protections the platform set to reduce that risk.',
    'I accept full responsibility for any restriction, suspension or ban of our number(s), and for any lost messages, contacts or business that follow.',
    'The platform and its operators are not liable for any such outcome and cannot restore a banned number.',
    'I am authorised to accept this on behalf of my business.',
];
const CONSENT_HASH = sha256(CONSENT_TEXT.join('\n'));

export class TenancyError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class Tenancy {
    constructor(database) {
        this.db = database.db;
        // Compared against when an email is unknown, so timing does not leak it.
        this.dummyHash = null;
    }

    // ------------------------------------------------------------ tenants --
    createTenant(name, slug, { services, controls } = {}) {
        const { cleanName, cleanSlug } = cleanTenantInput(name, slug);
        try {
            const info = this.db.prepare(
                `INSERT INTO tenants (name, slug, status, services, controls, created_at)
                 VALUES (?, ?, 'active', ?, ?, ?)`)
                .run(
                    cleanName,
                    cleanSlug,
                    JSON.stringify(normalizeTenantServices(services)),
                    JSON.stringify(normalizeTenantControls(controls)),
                    utcNow(),
                );
            return this.getTenant(Number(info.lastInsertRowid));
        } catch (err) {
            if (/users/.test(err.message) && /UNIQUE/.test(err.message)) {
                throw new TenancyError('that email is already registered', 409);
            }
            if (/UNIQUE/.test(err.message)) throw new TenancyError('that tenant slug is taken', 409);
            throw err;
        }
    }

    async createTenantWithOwner({ name, slug, services, controls, owner = {} }) {
        const { cleanName, cleanSlug } = cleanTenantInput(name, slug);
        const cleanEmail = cleanUserEmail(owner.email);
        const cleanOwnerName = String(owner.name ?? '').trim();
        const password = String(owner.password ?? '');
        if (password.length < 8) throw new TenancyError('password must be at least 8 characters');
        if (this.db.prepare('SELECT 1 FROM users WHERE email = ?').get(cleanEmail)) {
            throw new TenancyError('that email is already registered', 409);
        }

        const hash = await hashPassword(password);
        try {
            this.db.exec('BEGIN');
            const tenantInfo = this.db.prepare(
                `INSERT INTO tenants (name, slug, status, services, controls, created_at)
                 VALUES (?, ?, 'active', ?, ?, ?)`)
                .run(
                    cleanName,
                    cleanSlug,
                    JSON.stringify(normalizeTenantServices(services)),
                    JSON.stringify(normalizeTenantControls(controls)),
                    utcNow(),
                );
            const tenantId = Number(tenantInfo.lastInsertRowid);
            const userInfo = this.db.prepare(
                `INSERT INTO users (tenant_id, email, name, password_hash, role, created_at)
                 VALUES (?, ?, ?, ?, 'owner', ?)`)
                .run(tenantId, cleanEmail, cleanOwnerName, hash, utcNow());
            this.db.exec('COMMIT');
            return { tenant: this.getTenant(tenantId), owner: this.getUser(Number(userInfo.lastInsertRowid)) };
        } catch (err) {
            try {
                this.db.exec('ROLLBACK');
            } catch {
                // already rolled back
            }
            if (/UNIQUE/.test(err.message)) throw new TenancyError('that tenant slug is taken', 409);
            throw err;
        }
    }

    getTenant(id) {
        const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(id));
        return row ? toTenant(row) : null;
    }

    listTenants({ includeArchived = false } = {}) {
        const sql = includeArchived
            ? 'SELECT * FROM tenants ORDER BY id'
            : "SELECT * FROM tenants WHERE status != 'archived' ORDER BY id";
        return this.db.prepare(sql).all().map(toTenant);
    }

    setTenantStatus(id, status) {
        if (!['active', 'suspended'].includes(status)) throw new TenancyError('status must be active or suspended');
        const info = this.db.prepare('UPDATE tenants SET status = ? WHERE id = ?').run(status, Number(id));
        if (!info.changes) throw new TenancyError('tenant not found', 404);
        if (status === 'suspended') {
            // A suspended tenant is locked out now, not at the next login.
            this.db.prepare(`DELETE FROM sessions WHERE user_id IN
                             (SELECT id FROM users WHERE tenant_id = ?)`).run(Number(id));
        }
        return this.getTenant(id);
    }

    archiveTenant(id) {
        const tenant = this.getTenant(id);
        if (!tenant) throw new TenancyError('tenant not found', 404);
        const info = this.db.prepare("UPDATE tenants SET status = 'archived' WHERE id = ?").run(Number(id));
        if (!info.changes) throw new TenancyError('tenant not found', 404);
        this.db.prepare(`DELETE FROM sessions WHERE user_id IN
                         (SELECT id FROM users WHERE tenant_id = ?)`).run(Number(id));
        return this.getTenant(id);
    }

    /** Anti-ban policy for a tenant: stored as overrides, shown merged over the defaults. */
    setLimits(id, patch = {}) {
        const before = this.getTenant(id);
        if (!before || before.status === 'archived') throw new TenancyError('tenant not found', 404);
        const next = normalizeLimits({ ...before.limits, ...patch }, true);
        this.db.prepare('UPDATE tenants SET limits = ? WHERE id = ?').run(JSON.stringify(next), Number(id));
        return this.getTenant(id);
    }

    setSafety(id, patch = {}) {
        const before = this.getTenant(id);
        if (!before || before.status === 'archived') throw new TenancyError('tenant not found', 404);
        const next = { ...before.safety, ...normalizeSafety(patch) };
        checkSafety({ ...DEFAULTS, ...next });
        this.db.prepare('UPDATE tenants SET safety = ? WHERE id = ?').run(JSON.stringify(next), Number(id));
        return this.getTenant(id);
    }

    // ------------------------------------------------ tenant-owned safety --
    // A tenant may override the platform's anti-ban policy only when the
    // platform admin allows it (limits.allowCustomSafety) AND someone at the
    // tenant accepted the current CONSENT_VERSION. Either missing: the stored
    // overrides are kept but ignored.

    /** The latest consent to the current text, or null. */
    currentConsent(tenantId) {
        const row = this.db.prepare(
            'SELECT * FROM safety_consents WHERE tenant_id = ? AND text_version = ? ORDER BY id DESC LIMIT 1')
            .get(Number(tenantId), CONSENT_VERSION);
        return row ? toConsent(row) : null;
    }

    listConsents(tenantId) {
        return this.db.prepare('SELECT * FROM safety_consents WHERE tenant_id = ? ORDER BY id DESC')
            .all(Number(tenantId)).map(toConsent);
    }

    recordConsent({ tenantId, user, fullName = '', ip = '', userAgent = '' }) {
        const info = this.db.prepare(
            `INSERT INTO safety_consents
             (tenant_id, user_id, user_email, full_name, accepted_at, ip, user_agent, text_version, text_hash)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(Number(tenantId), user.id, user.email, String(fullName).trim().slice(0, 200), utcNow(),
                String(ip).slice(0, 100), String(userAgent).slice(0, 500), CONSENT_VERSION, CONSENT_HASH);
        return toConsent(this.db.prepare('SELECT * FROM safety_consents WHERE id = ?').get(Number(info.lastInsertRowid)));
    }

    customSafetyActive(tenant) {
        return Boolean(tenant?.limits.allowCustomSafety && Object.keys(tenant.customSafety).length
            && this.currentConsent(tenant.id));
    }

    /** Platform policy: defaults < super admin overrides. */
    platformSafety(tenant) {
        return Object.fromEntries(POLICY_KEYS.map((key) => [key, tenant.safety[key] ?? DEFAULTS[key]]));
    }

    /** What actually runs: platform policy < the tenant's own overrides, when active. */
    effectiveSafety(tenant) {
        return { ...this.platformSafety(tenant), ...(this.customSafetyActive(tenant) ? tenant.customSafety : {}) };
    }

    /**
     * The values to force onto a channel's config. Only keys someone set, so a
     * channel's own unmanaged values stand; a key the tenant overrode falls back
     * to the platform value once the override stops applying.
     */
    enforcedSafety(tenant) {
        if (!tenant) return {};
        const platform = this.platformSafety(tenant);
        const touched = Object.fromEntries(Object.keys(tenant.customSafety).map((key) => [key, platform[key]]));
        return { ...touched, ...tenant.safety, ...(this.customSafetyActive(tenant) ? tenant.customSafety : {}) };
    }

    /** Merge a tenant's own overrides. Callers check allowance + consent first. */
    setCustomSafety(id, patch = {}) {
        const before = this.getTenant(id);
        if (!before || before.status === 'archived') throw new TenancyError('tenant not found', 404);
        const next = { ...before.customSafety, ...normalizeSafety(patch) };
        checkSafety({ ...this.platformSafety(before), ...next });
        this.db.prepare('UPDATE tenants SET custom_safety = ? WHERE id = ?').run(JSON.stringify(next), Number(id));
        return this.getTenant(id);
    }

    clearCustomSafety(id) {
        const info = this.db.prepare("UPDATE tenants SET custom_safety = '{}' WHERE id = ?").run(Number(id));
        if (!info.changes) throw new TenancyError('tenant not found', 404);
        return this.getTenant(id);
    }

    updateTenant(id, patch = {}) {
        const before = this.getTenant(id);
        if (!before) throw new TenancyError('tenant not found', 404);
        if (before.status === 'archived') throw new TenancyError('tenant not found', 404);
        const status = patch.status ?? before.status;
        if (!['active', 'suspended'].includes(status)) throw new TenancyError('status must be active or suspended');
        const services = patch.services === undefined
            ? before.services
            : normalizeTenantServices(patch.services);
        const controls = patch.controls === undefined
            ? before.controls
            : normalizeTenantControls({ ...before.controls, ...patch.controls });
        this.db.prepare('UPDATE tenants SET status = ?, services = ?, controls = ? WHERE id = ?')
            .run(status, JSON.stringify(services), JSON.stringify(controls), Number(id));
        if (status === 'suspended') {
            this.db.prepare(`DELETE FROM sessions WHERE user_id IN
                             (SELECT id FROM users WHERE tenant_id = ?)`).run(Number(id));
        }
        return this.getTenant(id);
    }

    // -------------------------------------------------------------- users --
    async createUser({ tenantId = null, email, name = '', password, role }) {
        const cleanEmail = cleanUserEmail(email);
        if (String(password ?? '').length < 8) throw new TenancyError('password must be at least 8 characters');
        if (!ROLES.includes(role)) throw new TenancyError(`role must be one of ${ROLES.join(', ')}`);
        if ((role === 'super_admin') !== (tenantId === null)) {
            throw new TenancyError('super_admin has no tenant; every other role needs one');
        }
        if (tenantId !== null && !this.getTenant(tenantId)) throw new TenancyError('tenant not found', 404);
        const hash = await hashPassword(password);
        try {
            const info = this.db.prepare(
                `INSERT INTO users (tenant_id, email, name, password_hash, role, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)`)
                .run(tenantId, cleanEmail, String(name).trim(), hash, role, utcNow());
            return this.getUser(Number(info.lastInsertRowid));
        } catch (err) {
            if (/UNIQUE/.test(err.message)) throw new TenancyError('that email is already registered', 409);
            throw err;
        }
    }

    getUser(id) {
        const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(Number(id));
        return row ? toUser(row) : null;
    }

    userCount() {
        return this.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    }

    /** Check credentials. Returns the user, or null for any failure. */
    async authenticate(email, password) {
        const row = this.db.prepare('SELECT * FROM users WHERE email = ?')
            .get(String(email ?? '').trim().toLowerCase());
        if (!this.dummyHash) this.dummyHash = await hashPassword(crypto.randomUUID());
        const ok = await verifyPassword(password, row?.password_hash ?? this.dummyHash);
        return ok && row && !row.disabled ? toUser(row) : null;
    }

    listUsers(tenantId) {
        return this.db.prepare('SELECT * FROM users WHERE tenant_id = ? ORDER BY id')
            .all(Number(tenantId)).map(toUser);
    }

    /** Scoped by tenant: an admin can only disable their own people. */
    setUserDisabled(tenantId, userId, disabled) {
        const info = this.db.prepare('UPDATE users SET disabled = ? WHERE id = ? AND tenant_id = ?')
            .run(disabled ? 1 : 0, Number(userId), Number(tenantId));
        if (!info.changes) throw new TenancyError('user not found', 404);
        if (disabled) this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId));
        return this.getUser(userId);
    }

    /**
     * Set a tenant user's password (super admin reset). Scoped by tenant so a
     * wrong pairing cannot touch another business's user, and every session is
     * revoked: a reset usually means the old password is no longer trusted.
     */
    async setPassword(tenantId, userId, password) {
        if (String(password ?? '').length < 8) throw new TenancyError('password must be at least 8 characters');
        const hash = await hashPassword(password);
        const info = this.db.prepare('UPDATE users SET password_hash = ? WHERE id = ? AND tenant_id = ?')
            .run(hash, Number(userId), Number(tenantId));
        if (!info.changes) throw new TenancyError('user not found', 404);
        this.revokeSessions(userId);
        return this.getUser(userId);
    }

    // ----------------------------------------------------------- sessions --
    createSession(userId) {
        const token = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date(now).toISOString());
        const at = new Date(now).toISOString();
        this.db.prepare(
            'INSERT INTO sessions (token_hash, user_id, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
            .run(sha256(token), userId, new Date(now + SESSION_TTL_MS).toISOString(), at, at);
        return token;
    }

    /** The live user + tenant behind a token, or null. Expires idle sessions. */
    resolveSession(token, now = Date.now()) {
        if (!token) return null;
        const hash = sha256(String(token));
        const row = this.db.prepare(
            `SELECT u.*, s.expires_at, s.created_at AS session_created, s.last_seen_at, t.status AS tenant_status
             FROM sessions s JOIN users u ON u.id = s.user_id
             LEFT JOIN tenants t ON t.id = u.tenant_id
             WHERE s.token_hash = ?`).get(hash);
        if (!row || row.disabled || row.expires_at < new Date(now).toISOString()) return null;
        if (row.tenant_id !== null && row.tenant_status !== 'active') return null;
        const seen = Date.parse(row.last_seen_at ?? row.session_created);
        if (now - seen > SESSION_IDLE_MS) {
            this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
            return null;
        }
        if (now - seen > SESSION_TOUCH_MS) {
            this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(new Date(now).toISOString(), hash);
        }
        return toUser(row);
    }

    /** Sign a user out everywhere (password change, compromise). */
    revokeSessions(userId) {
        return this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(Number(userId)).changes;
    }

    deleteSession(token) {
        this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    }

    // -------------------------------------------------------------- audit --
    audit({ tenantId = null, userId = null, action, target = '', detail = '' }) {
        this.db.prepare(
            'INSERT INTO audit_logs (tenant_id, user_id, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(tenantId, userId, action, String(target), typeof detail === 'string' ? detail : JSON.stringify(detail), utcNow());
    }

    /** tenantId null = every tenant (super admin only, enforced by the caller). */
    listAudit({ tenantId = null, limit = 200 } = {}) {
        const rows = tenantId === null
            ? this.db.prepare('SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?').all(limit)
            : this.db.prepare('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY id DESC LIMIT ?')
                .all(Number(tenantId), limit);
        return rows.map((r) => ({
            id: r.id, tenantId: r.tenant_id, userId: r.user_id, action: r.action,
            target: r.target, detail: r.detail, createdAt: r.created_at,
        }));
    }
}

function cleanTenantInput(name, slug) {
    const cleanName = String(name ?? '').trim();
    const cleanSlug = String(slug ?? cleanName).trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!cleanName) throw new TenancyError('name is required');
    if (!cleanSlug) throw new TenancyError('slug is required');
    return { cleanName, cleanSlug };
}

function cleanUserEmail(email) {
    const cleanEmail = String(email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cleanEmail)) throw new TenancyError('a valid email is required');
    return cleanEmail;
}

export function normalizeTenantServices(services) {
    if (!Array.isArray(services)) return [...TENANT_SERVICES];
    return TENANT_SERVICES.filter((service) => services.includes(service));
}

/**
 * Plan limits the platform admin sets per tenant. A number of 0 means "no limit";
 * the booleans default to allowed, so an existing tenant loses nothing.
 */
export const LIMIT_SPEC = Object.freeze({
    maxChannels: [0, 1000],
    maxUsers: [0, 10000],
    maxTemplates: [0, 100000],
    maxContactsPerCampaign: [0, 1000000],
    maxMediaMb: [0, 500],
    allowCloudApi: 'bool',
    allowWhatsappWeb: 'bool',
    blockedWords: 'text',
    allowCustomSafety: 'bool',
});
export const DEFAULT_LIMITS = Object.freeze({
    maxChannels: 0, maxUsers: 0, maxTemplates: 0, maxContactsPerCampaign: 0, maxMediaMb: 0,
    allowCloudApi: true, allowWhatsappWeb: true, blockedWords: '',
    // Off: only the platform admin sets anti-ban limits.
    allowCustomSafety: false,
});

export function normalizeLimits(input = {}, strict = false) {
    const out = { ...DEFAULT_LIMITS };
    for (const [key, spec] of Object.entries(LIMIT_SPEC)) {
        const value = input?.[key];
        if (value === undefined || value === null) continue;
        if (spec === 'bool') out[key] = Boolean(value);
        else if (spec === 'text') out[key] = String(value).slice(0, 2000);
        else {
            const n = Number(value);
            if (!Number.isFinite(n) || n < spec[0] || n > spec[1]) {
                if (strict) throw new TenancyError(`${key} must be between ${spec[0]} and ${spec[1]}`);
                continue;
            }
            out[key] = Math.floor(n);
        }
    }
    if (!out.allowCloudApi && !out.allowWhatsappWeb && strict) {
        throw new TenancyError('allow at least one transport');
    }
    return out;
}

/** The first banned word or phrase found in `text`, or null. Whole words, any case. */
export function blockedWordIn(limits, text) {
    const flat = (t) => ` ${String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
    const hay = flat(text);
    return String(limits?.blockedWords ?? '').split(/[,\n]/).map((w) => w.trim()).filter(Boolean)
        .find((w) => hay.includes(flat(w))) ?? null;
}

export function normalizeTenantControls(controls = {}) {
    return Object.fromEntries(Object.entries(DEFAULT_TENANT_CONTROLS)
        .map(([key, fallback]) => [key, controls[key] === undefined ? fallback : Boolean(controls[key])]));
}

/** Cross-field rules over a full policy view. */
function checkSafety(view) {
    if (view.maxDelaySeconds > 0 && view.maxDelaySeconds < view.minDelaySeconds) {
        throw new TenancyError('maximum delay must be at least the minimum delay');
    }
    if (view.restMaxMinutes < view.restMinMinutes) {
        throw new TenancyError('longest rest must be at least the shortest rest');
    }
}

/** Keep only known keys, each checked against POLICY_SPEC. */
function normalizeSafety(input) {
    const out = {};
    for (const [key, spec] of Object.entries(POLICY_SPEC)) {
        const value = input?.[key];
        if (value === undefined) continue;
        if (spec === 'bool') out[key] = Boolean(value);
        else if (Array.isArray(spec) && typeof spec[0] === 'string') {
            if (!spec.includes(value)) throw new TenancyError(`${key} must be one of ${spec.join(', ')}`);
            out[key] = value;
        } else {
            const n = Number(value);
            if (!Number.isFinite(n) || n < spec[0] || n > spec[1]) {
                throw new TenancyError(`${key} must be between ${spec[0]} and ${spec[1]}`);
            }
            out[key] = n;
        }
    }
    return out;
}

function parseJson(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

function toTenant(row) {
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        status: row.status,
        services: normalizeTenantServices(parseJson(row.services, null)),
        controls: normalizeTenantControls(parseJson(row.controls, {})),
        safety: parseJson(row.safety, {}),
        limits: normalizeLimits(parseJson(row.limits, {})),
        customSafety: parseJson(row.custom_safety, {}),
        createdAt: row.created_at,
    };
}

function toConsent(row) {
    return {
        id: row.id, tenantId: row.tenant_id, userId: row.user_id, email: row.user_email, fullName: row.full_name,
        acceptedAt: row.accepted_at, ip: row.ip, userAgent: row.user_agent,
        version: row.text_version, textHash: row.text_hash,
    };
}

/** Never includes the password hash. */
function toUser(row) {
    return {
        id: row.id, tenantId: row.tenant_id, email: row.email, name: row.name,
        role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at,
    };
}
