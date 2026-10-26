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
 *   { key, service, group, label, hint?, type, default, min?, max?, options?, unlimitedAt?, nullLabel?, columns?, validate?, check? }
 *   type: 'int' | 'bool' | 'enum' | 'text' | 'list' | 'table'
 *   - `int` with `unlimitedAt: 0` reads 0 as "no limit". An `int` may default to null,
 *     shown as `nullLabel` (e.g. "Plan limit").
 *   - `list` is an array of strings (stored as JSON, edited as one per line).
 *   - `table` is an array of rows, as many as `default` has (row i keeps its
 *     place). `columns`: [{ key, type, label, min?, max?, fixed? }] with type
 *     'int' | 'num' | 'bool' | 'text' | 'range' ([lo, hi]) | 'need' ({ days, delivered, bulk }).
 *     A `fixed` column, and a cell whose default is null, keeps the default;
 *     keys outside `columns` are dropped. `validate(rows)` returns a problem or null.
 *   - `check(values)`: a cross-field rule run on save against the scope's values
 *     (stored + patch, over the layers beneath it). Returns a problem or null.
 */

import { BillingStore } from '../billing/store.js';
import { AUTOREPLY_POLICY } from './autoreplies.js';
import { BILLING_POLICY } from './billing.js';
import { BULK_POLICY, PLAN_SPEEDS } from './bulk.js';
import { CAMPAIGN_POLICY } from './campaigns.js';
import { CHANNEL_POLICY, PLAN_DAILY_CAPS } from './channels.js';
import { LEVELS_POLICY } from './levels.js';
import { SECURITY_POLICY } from './security.js';
import { TEMPLATE_POLICY } from './templates.js';

export { POLICY_SCHEMA } from './schema.js';

export const POLICY_FIELDS = Object.freeze([
    ...CHANNEL_POLICY,
    ...LEVELS_POLICY,
    ...TEMPLATE_POLICY,
    ...AUTOREPLY_POLICY,
    ...BULK_POLICY,
    ...CAMPAIGN_POLICY,
    ...BILLING_POLICY,
    ...SECURITY_POLICY,
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
        case 'table':
            return cleanTable(field, value);
        case 'list': {
            const items = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/);
            return [...new Set(items.map((v) => String(v).trim()).filter(Boolean))].slice(0, 500);
        }
        default:
            return String(value ?? '').slice(0, 4000);
    }
}

/** One table cell, by its column's type. */
function cleanCell(field, col, value, row) {
    const where = `${field.label}, row ${row + 1}, ${col.label ?? col.key}`;
    const num = (v, int = col.type === 'int') => {
        const n = Number(v);
        const min = col.min ?? 0;
        const max = col.max ?? Number.MAX_SAFE_INTEGER;
        if (v === null || v === '' || typeof v === 'boolean' || !Number.isFinite(n) || n < min || n > max) {
            throw new PolicyError(`${where} must be between ${min} and ${max}`);
        }
        return int ? Math.floor(n) : n;
    };
    switch (col.type) {
        case 'bool':
            if (value === true || value === 'true' || value === '1') return true;
            if (value === false || value === 'false' || value === '0') return false;
            throw new PolicyError(`${where} must be true or false`);
        case 'text': {
            const text = String(value ?? '').trim().slice(0, 60);
            if (!text) throw new PolicyError(`${where} is required`);
            return text;
        }
        case 'range': {
            if (!Array.isArray(value) || value.length !== 2) throw new PolicyError(`${where} must be a [from, to] pair`);
            const [lo, hi] = value.map((v) => num(v));
            if (lo > hi) throw new PolicyError(`${where}: from is above to`);
            return [lo, hi];
        }
        case 'need': {
            const v = value && typeof value === 'object' ? value : {};
            return { days: num(v.days, true), delivered: num(v.delivered, true), bulk: num(v.bulk, true) };
        }
        default:
            return num(value);
    }
}

/** A whole table: same row count as the default, each row cleaned column by column, then the field's own check. */
function cleanTable(field, value) {
    if (!Array.isArray(value) || value.length !== field.default.length) {
        throw new PolicyError(`${field.label} must have exactly ${field.default.length} rows`);
    }
    const rows = field.default.map((base, i) => {
        const given = value[i] && typeof value[i] === 'object' ? value[i] : {};
        return Object.fromEntries(field.columns.map((col) => [col.key,
            col.fixed || base[col.key] === null ? base[col.key] : cleanCell(field, col, given[col.key], i)]));
    });
    const problem = field.validate?.(rows);
    if (problem) throw new PolicyError(`${field.label}: ${problem}`);
    return rows;
}

/**
 * Policy values for the admin editor: a table saved before it grew gets the missing default rows appended,
 * so saving it back sends the full row count cleanTable wants. Sending still sees the stored rows (levels.js).
 */
export function fillTables(values = {}) {
    const out = { ...values };
    for (const [key, value] of Object.entries(values)) {
        const field = FIELD.get(key);
        if (field?.type === 'table' && Array.isArray(value) && value.length < field.default.length) {
            out[key] = [...value, ...field.default.slice(value.length)];
        }
    }
    return out;
}

export class PolicyStore {
    /** @param {import('../db.js').Database} database the unscoped handle */
    constructor(database, { now = () => new Date() } = {}) {
        this.database = database;
        this.db = database.db;
        this.now = now;
        // Each built-in plan starts with its own sending speed and per-number day; an admin's value is never overwritten.
        // shortcut: an override the admin removes comes back at the next start; add a seeded flag if that matters.
        const seed = this.db.prepare(
            'INSERT OR IGNORE INTO platform_policy (scope, key, value, updated_at) VALUES (?, ?, ?, ?)');
        for (const [key, perPlan] of [['bulk.maxSpeed', PLAN_SPEEDS], ['channels.dailyCap', PLAN_DAILY_CAPS]]) {
            for (const [plan, value] of Object.entries(perPlan)) seed.run(`plan:${plan}`, key, JSON.stringify(value), now().toISOString());
        }
    }

    /** The overrides stored at one scope, keyed by field key. Unknown keys are dropped. */
    values(scope) {
        const out = {};
        for (const row of this.db.prepare('SELECT key, value FROM platform_policy WHERE scope = ?').all(parseScope(scope))) {
            if (FIELD.has(row.key)) out[row.key] = JSON.parse(row.value);
        }
        return out;
    }

    /**
     * Stored tables whose row count no longer matches the field (saved before the table grew),
     * as `[{ scope, key, rows, expected }]`. Sending holds numbers at their old top (levels.js sendingTables) until saved again.
     */
    staleTables() {
        const tables = POLICY_FIELDS.filter((f) => f.type === 'table');
        return this.db.prepare(`SELECT scope, key, value FROM platform_policy WHERE key IN (${tables.map(() => '?').join(', ')})`)
            .all(...tables.map((f) => f.key))
            .map((r) => ({ scope: r.scope, key: r.key, rows: JSON.parse(r.value)?.length ?? 0, expected: FIELD.get(r.key).default.length }))
            .filter((r) => r.rows !== r.expected);
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
        // Cross-field rules, against this scope as it will be, over the layers beneath it.
        const base = Object.fromEntries(POLICY_FIELDS.map((f) => [f.key, f.default]));
        if (s !== 'global') Object.assign(base, this.values('global'));
        const planKey = s.startsWith('plan:') ? s.slice(5) : s.startsWith('tenant:') ? this.planKeyFor(Number(s.slice(7))) : null;
        if (planKey) Object.assign(base, this.values(`plan:${planKey}`));
        const merged = { ...base, ...this.values(s) };
        for (const [key, value] of writes) merged[key] = value ?? base[key];
        for (const field of POLICY_FIELDS) {
            const problem = field.check?.(merged);
            if (problem) throw new PolicyError(problem);
        }
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
