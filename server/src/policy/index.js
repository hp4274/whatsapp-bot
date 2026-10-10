/**
 * Platform policy: the rules a super admin sets for every tenant, per plan.
 *
 * One table, three layers. A value is looked up tenant override -> the
 * tenant's plan -> the platform default -> the field's built-in default, so a
 * tenant on no plan (billing not in use) still gets the platform default, and
 * an empty table changes nothing for anyone.
 *
 * Fields are data, declared per service in the sibling files and merged here,
 * so each service owns its own rules and adding one never touches this file's
 * logic. The admin UI renders its forms from `POLICY_FIELDS`, which is why a
 * field carries its label and hint.
 *
 * A field:
 *   { key, service, group, label, hint?, type, default, min?, max?, options?, unlimitedAt? }
 *   type: 'int' | 'bool' | 'enum' | 'text' | 'list'
 *   - `int` with `unlimitedAt: 0` reads 0 as "no limit".
 *   - `list` is an array of strings (stored as JSON, edited as one per line).
 */

import { BillingStore } from '../billing/store.js';
import { AUTOREPLY_POLICY } from './autoreplies.js';
import { BULK_POLICY } from './bulk.js';
import { CAMPAIGN_POLICY } from './campaigns.js';
import { CHANNEL_POLICY } from './channels.js';
import { TEMPLATE_POLICY } from './templates.js';

export { POLICY_SCHEMA } from './schema.js';

export const POLICY_FIELDS = Object.freeze([
    ...CHANNEL_POLICY,
    ...TEMPLATE_POLICY,
    ...AUTOREPLY_POLICY,
    ...BULK_POLICY,
    ...CAMPAIGN_POLICY,
]);

const FIELD = new Map(POLICY_FIELDS.map((field) => [field.key, field]));

export class PolicyError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** `global`, `plan:<key>` or `tenant:<id>`; anything else is refused. */
export function parseScope(scope) {
    const s = String(scope ?? '');
    if (s === 'global') return s;
    if (/^plan:[a-z0-9_-]{1,40}$/.test(s)) return s;
    if (/^tenant:\d+$/.test(s)) return s;
    throw new PolicyError(`unknown policy scope "${s}"`);
}

/** Coerce and range-check one value. Throws on anything the field cannot hold. */
export function cleanValue(field, value) {
    switch (field.type) {
        case 'bool':
            return Boolean(value);
        case 'int': {
            const n = Number(value);
            const min = field.min ?? 0;
            const max = field.max ?? Number.MAX_SAFE_INTEGER;
            if (!Number.isFinite(n) || n < min || n > max) {
                throw new PolicyError(`${field.label} must be between ${min} and ${max}`);
            }
            return Math.floor(n);
        }
        case 'enum':
            if (!field.options.some((o) => o.value === value)) {
                throw new PolicyError(`${field.label} must be one of ${field.options.map((o) => o.value).join(', ')}`);
            }
            return value;
        case 'list': {
            const items = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
            return [...new Set(items.map((v) => String(v).trim()).filter(Boolean))].slice(0, 500);
        }
        default:
            return String(value ?? '').slice(0, 4000);
    }
}

export class PolicyStore {
    /** @param {import('../db.js').Database} database the unscoped handle */
    constructor(database, { now = () => new Date() } = {}) {
        this.database = database;
        this.db = database.db;
        this.now = now;
    }

    /** The overrides stored at one scope, keyed by field key. Unknown keys are dropped. */
    values(scope) {
        const out = {};
        for (const row of this.db.prepare('SELECT key, value FROM platform_policy WHERE scope = ?').all(parseScope(scope))) {
            if (FIELD.has(row.key)) out[row.key] = JSON.parse(row.value);
        }
        return out;
    }

    /** Every plan scope that holds at least one override, keyed by plan key. */
    planValues() {
        const out = {};
        const rows = this.db.prepare("SELECT DISTINCT scope FROM platform_policy WHERE scope LIKE 'plan:%'").all();
        for (const { scope } of rows) out[scope.slice(5)] = this.values(scope);
        return out;
    }

    /**
     * Apply a patch at one scope. `null` removes the override so the layer
     * below shows through again. Validates everything before writing anything.
     */
    set(scope, patch = {}) {
        const s = parseScope(scope);
        const writes = Object.entries(patch ?? {}).map(([key, value]) => {
            const field = FIELD.get(key);
            if (!field) throw new PolicyError(`unknown policy field "${key}"`);
            return [key, value === null ? null : cleanValue(field, value)];
        });
        const at = this.now().toISOString();
        const put = this.db.prepare(
            `INSERT INTO platform_policy (scope, key, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`);
        const del = this.db.prepare('DELETE FROM platform_policy WHERE scope = ? AND key = ?');
        for (const [key, value] of writes) {
            if (value === null) del.run(s, key);
            else put.run(s, key, JSON.stringify(value), at);
        }
        return this.values(s);
    }

    /** The plan a tenant is on, or null when billing is not in use for it. */
    planKeyFor(tenantId) {
        try {
            return new BillingStore(this.database.forTenant(tenantId)).subscription()?.planKey ?? null;
        } catch {
            return null;
        }
    }

    /**
     * Every field's effective value for one tenant, plus where it came from.
     * Cheap enough to call per request: three small indexed reads.
     */
    resolve(tenantId) {
        const planKey = tenantId == null ? null : this.planKeyFor(tenantId);
        const layers = [
            ['tenant', tenantId == null ? {} : this.values(`tenant:${Number(tenantId)}`)],
            ['plan', planKey ? this.values(`plan:${planKey}`) : {}],
            ['global', this.values('global')],
        ];
        const values = {};
        const sources = {};
        for (const field of POLICY_FIELDS) {
            const hit = layers.find(([, layer]) => field.key in layer);
            values[field.key] = hit ? hit[1][field.key] : field.default;
            sources[field.key] = hit ? hit[0] : 'default';
        }
        return { planKey, values, sources };
    }

    /** Shorthand: one tenant's effective value for one field. */
    get(tenantId, key) {
        if (!FIELD.has(key)) throw new PolicyError(`unknown policy field "${key}"`);
        return this.resolve(tenantId).values[key];
    }
}

/** An int field's value, with its "no limit" sentinel turned into null. */
export function limitOf(field, value) {
    return field.unlimitedAt !== undefined && value === field.unlimitedAt ? null : value;
}
