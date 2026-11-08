/**
 * Staff roles for the platform admin: a role is a name and, per admin section, what it may do there: view, and the
 * actions that page really has (SECTION_ACTIONS), each tied to the routes it opens (WRITES).
 *
 * A staff member is a platform user (role `super_admin`, no tenant) with `users.admin_role_id` set. Without one they
 * are a full super admin, as every admin before roles was; only a full super admin manages roles and staff
 * (Settings). A role in use cannot be deleted, so nobody silently becomes a full admin.
 *
 * Platform-wide like referrals: the root connection, never a tenant handle.
 */

import { utcNow } from './protocol.js';

export const ADMIN_ROLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS admin_roles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    sections    TEXT NOT NULL DEFAULT '{}',  -- { section: [actions] }; the first roles held a plain list
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
`;

/**
 * What each section can be given, in sidebar order: 'view' first, then only what that page really lets someone do
 * (the web's admin-sections.ts names each one). Usage, Health, Payments and Audit logs are read-only pages.
 */
export const SECTION_ACTIONS = Object.freeze({
    tenants: ['view', 'add', 'edit', 'delete'],
    leads: ['view', 'answer'],
    plans: ['view', 'edit', 'delete'],
    payments: ['view'],
    referrals: ['view', 'add', 'edit', 'pay'],
    wapzo: ['view', 'edit', 'send'],
    usage: ['view'],
    health: ['view'],
    number_collections: ['view', 'delete'],
    audit: ['view'],
    channels: ['view', 'edit'],
    services: ['view', 'rules', 'templates', 'campaigns', 'numbers'],
});
export const ADMIN_SECTIONS = Object.freeze(Object.keys(SECTION_ACTIONS));

/**
 * Who may read each /api/admin/<segment>: its own section, and the pages that show it too (Tenants shows the plan list
 * and recent activity, Channels the plans). A segment not listed (staff, roles) is full admins' only.
 */
const READERS = {
    tenants: ['tenants'],
    school: ['tenants', 'services'],
    leads: ['leads'],
    billing: ['plans', 'tenants', 'payments'],
    plans: ['plans', 'usage', 'health', 'channels', 'services'],
    payments: ['payments'],
    referrals: ['referrals'],
    wapzo: ['wapzo'],
    'usage-summary': ['usage'],
    'health-detail': ['health', 'channels', 'services'],
    'shadow-review': ['health', 'services'],
    'number-collections': ['number_collections', 'tenants'],
    'audit-logs': ['audit', 'tenants', 'plans'],
    logs: ['audit'],
    numbers: ['channels', 'health', 'services'],
    policy: ['services', 'tenants'],
    campaigns: ['services'],
    bulk: ['services'],
    recipes: ['services'],
    'template-review': ['services'],
    'template-library': ['services'],
};

/**
 * Every admin write, as "METHOD /path", and the [section, action] pairs that allow it (any one is enough). The first
 * rule that matches decides; a write no rule names is full admins' only.
 */
const WRITES = [
    [/^POST \/tenants\/?$/, [['tenants', 'add']]],
    [/^DELETE \/tenants\/\d+\/?$/, [['tenants', 'delete']]],
    // Everything else on one business: its plan, payments, limits, details, sign-ins, services, activation.
    [/^\w+ \/tenants\/\d+(\/|$)/, [['tenants', 'edit']]],
    [/^PUT \/policy\/tenant(:|%3a)\d+$/i, [['tenants', 'edit']]],
    [/^PUT \/policy\//, [['services', 'rules']]],
    [/^\w+ \/leads\/\d+(\/|$)/, [['leads', 'answer']]],
    [/^PUT \/billing\/plans\//, [['plans', 'edit']]],
    [/^DELETE \/billing\/plans\//, [['plans', 'delete']]],
    [/^POST \/referrals\/?$/, [['referrals', 'add']]],
    [/^POST \/referrals\/\d+\/payout$/, [['referrals', 'pay']]],
    [/^\w+ \/referrals\/\d+(\/|$)/, [['referrals', 'edit']]],
    [/^POST \/wapzo\/(test|broadcast|email\/send|email\/preview)$/, [['wapzo', 'send']]],
    [/^\w+ \/wapzo\//, [['wapzo', 'edit']]],
    [/^DELETE \/number-collections\/\d+$/, [['number_collections', 'delete']]],
    [/^\w+ \/numbers\//, [['channels', 'edit'], ['services', 'numbers']]],
    [/^\w+ \/(campaigns|bulk|recipes)(\/|$)/, [['services', 'campaigns']]],
    [/^\w+ \/template-(review|library)(\/|$)/, [['services', 'templates']]],
];

export const isRead = (method) => method === 'GET' || method === 'HEAD';

/**
 * Whether a staff member with `permissions` ({ section: actions }) may call this /api/admin path. The live feed and
 * the bell are everyone's; the tenant list is read by most pages (names beside payments, referrals, services).
 */
export function staffMayOpen(permissions, method, path) {
    const segment = path.split('/').filter(Boolean)[0] ?? '';
    if (segment === 'events' || segment === 'notifications') return true;
    if (isRead(method)) {
        if (path === '/tenants' || path === '/tenants/') return true;
        return (READERS[segment] ?? []).some((s) => permissions[s]?.includes('view'));
    }
    const rule = WRITES.find(([pattern]) => pattern.test(`${method} ${path}`));
    return Boolean(rule?.[1].some(([section, action]) => permissions[section]?.includes(action)));
}

export class AdminRoleError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class AdminRoles {
    /** @param {import('./db.js').Database} database the platform handle. */
    constructor(database) {
        this.db = database.db;
    }

    /** Every role, with how many staff hold it. */
    list() {
        return this.db.prepare(
            `SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.admin_role_id = r.id AND u.email NOT LIKE '%#deleted-%') AS staff
             FROM admin_roles r ORDER BY r.name`).all().map(toRole);
    }

    get(id) {
        const row = this.db.prepare('SELECT *, 0 AS staff FROM admin_roles WHERE id = ?').get(Number(id));
        return row ? toRole(row) : null;
    }

    /** What a role may do, per section; nothing for a role that is gone (fail closed). */
    permissionsOf(id) {
        return this.get(id)?.permissions ?? {};
    }

    create(input) {
        const { name, permissions } = clean(input);
        const at = utcNow();
        try {
            const info = this.db.prepare('INSERT INTO admin_roles (name, sections, created_at, updated_at) VALUES (?, ?, ?, ?)')
                .run(name, JSON.stringify(permissions), at, at);
            return this.get(Number(info.lastInsertRowid));
        } catch (err) {
            if (/UNIQUE/.test(err.message)) throw new AdminRoleError('a role with that name already exists', 409);
            throw err;
        }
    }

    update(id, input) {
        if (!this.get(id)) throw new AdminRoleError('role not found', 404);
        const { name, permissions } = clean(input);
        try {
            this.db.prepare('UPDATE admin_roles SET name = ?, sections = ?, updated_at = ? WHERE id = ?')
                .run(name, JSON.stringify(permissions), utcNow(), Number(id));
        } catch (err) {
            if (/UNIQUE/.test(err.message)) throw new AdminRoleError('a role with that name already exists', 409);
            throw err;
        }
        return this.get(id);
    }

    remove(id) {
        const role = this.get(id);
        if (!role) throw new AdminRoleError('role not found', 404);
        const held = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE admin_role_id = ? AND email NOT LIKE '%#deleted-%'")
            .get(Number(id)).n;
        if (held) throw new AdminRoleError(`${held} staff ${held === 1 ? 'has' : 'have'} this role: give them another first`, 409);
        this.db.prepare('DELETE FROM admin_roles WHERE id = ?').run(Number(id));
        return role;
    }
}

function clean({ name, permissions } = {}) {
    const cleanName = String(name ?? '').trim().slice(0, 60);
    if (!cleanName) throw new AdminRoleError('give the role a name');
    if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) {
        throw new AdminRoleError('permissions must be { section: [actions] }');
    }
    const out = {};
    for (const [section, actions] of Object.entries(permissions)) {
        if (!ADMIN_SECTIONS.includes(section)) throw new AdminRoleError(`unknown section: ${section}`);
        const allowed = SECTION_ACTIONS[section];
        if (!Array.isArray(actions) || actions.some((a) => !allowed.includes(a))) {
            throw new AdminRoleError(`${section} allows ${allowed.join(', ')}`);
        }
        if (actions.length) out[section] = allowed.filter((a) => a === 'view' || actions.includes(a));
    }
    if (!Object.keys(out).length) throw new AdminRoleError('choose at least one page the role opens');
    // Sidebar order, so two saves of the same choice store the same text.
    return { name: cleanName, permissions: Object.fromEntries(ADMIN_SECTIONS.filter((s) => out[s]).map((s) => [s, out[s]])) };
}

function toRole(row) {
    let permissions = {};
    try {
        const stored = JSON.parse(row.sections);
        // The first roles were a plain list of sections, each opened fully; an action a page no longer has is dropped.
        const entries = Array.isArray(stored) ? stored.map((s) => [s, SECTION_ACTIONS[s] ?? []]) : Object.entries(stored);
        permissions = Object.fromEntries(entries
            .map(([s, actions]) => [s, (SECTION_ACTIONS[s] ?? []).filter((a) => actions.includes(a))])
            .filter(([, actions]) => actions.includes('view')));
    } catch {
        // a hand-edited row: it opens nothing rather than everything
    }
    return { id: row.id, name: row.name, permissions, staff: row.staff, createdAt: row.created_at, updatedAt: row.updated_at };
}
