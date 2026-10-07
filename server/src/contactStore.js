/**
 * The contact book: one row per number per tenant, with room for whatever the
 * business actually tracks.
 *
 * A clinic stores a patient id and an appointment date; a school stores a class
 * and a parent name; a shop stores the last order. None of that belongs in
 * columns, so it lives in `custom_fields` - a JSON object - and `tags`, a JSON
 * array. SQLite's JSON1 functions make both filterable, so a segment is a
 * stored filter rather than a materialised list that goes stale.
 *
 * Opt-out is deliberately not a column here. `opt_outs` stays the one authority
 * the send path consults; `opt_in_status` records the consent basis we hold,
 * which is a different fact. Reads report both.
 */

import { PhoneError, normalizePhone, utcNow } from './protocol.js';

export const CONTACT_STATUSES = Object.freeze(['active', 'archived']);
export const OPT_IN_STATUSES = Object.freeze(['unknown', 'opted_in', 'opted_out']);

export class ContactError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class ContactStore {
    /** @param {import('./db.js').Database} database a tenant-scoped handle */
    constructor(database, defaultCountryCode = '') {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.defaultCountryCode = defaultCountryCode;
    }

    // ------------------------------------------------------------- writes --
    /**
     * Create or update by phone. The number is the identity, so importing the
     * same sheet twice updates rather than duplicating.
     *
     * `merge` keeps existing tags and custom fields and layers the new ones on
     * top, which is what a second import of a partial sheet should do.
     */
    upsert({
        phone, name, email, tags, customFields,
        source, status, optInStatus, normalized: isNormalized = false,
    }, { merge = true } = {}) {
        // No destructuring defaults on the updatable fields: `undefined` has to
        // stay meaningful so an update that only sets tags does not blank the
        // name. The insert path below supplies the real defaults.
        const normalized = this.#phone(phone, isNormalized);
        const existing = this.getByPhone(normalized);
        const now = utcNow();

        if (!existing) {
            const info = this.db.prepare(
                `INSERT INTO contacts (tenant_id, phone, name, email, status, opt_in_status,
                                       custom_fields, tags, source, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(
                    this.tenantId, normalized, String(name ?? '').trim(), String(email ?? '').trim(),
                    pick(status, CONTACT_STATUSES, 'active'),
                    pick(optInStatus, OPT_IN_STATUSES, 'unknown'),
                    JSON.stringify(cleanFields(customFields)), JSON.stringify(cleanTags(tags)),
                    String(source ?? 'manual'), now, now,
                );
            return this.get(Number(info.lastInsertRowid));
        }

        const nextTags = tags === undefined ? existing.tags
            : (merge ? unique([...existing.tags, ...cleanTags(tags)]) : cleanTags(tags));
        const nextFields = customFields === undefined ? existing.customFields
            : (merge ? { ...existing.customFields, ...cleanFields(customFields) } : cleanFields(customFields));

        this.db.prepare(
            `UPDATE contacts SET name = ?, email = ?, status = ?, opt_in_status = ?,
                                 custom_fields = ?, tags = ?, source = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(
                name === undefined ? existing.name : String(name).trim(),
                email === undefined ? existing.email : String(email).trim(),
                pick(status, CONTACT_STATUSES, existing.status),
                pick(optInStatus, OPT_IN_STATUSES, existing.optInStatus),
                JSON.stringify(nextFields), JSON.stringify(nextTags),
                source === undefined ? existing.source : String(source),
                now, existing.id, this.tenantId,
            );
        return this.get(existing.id);
    }

    /** Bulk upsert, e.g. from an imported sheet. Returns a per-row tally. */
    importMany(contacts, { source = 'import', tags = [], merge = true, normalized = false } = {}) {
        const result = { created: 0, updated: 0, failed: [], ids: [] };
        for (const [index, raw] of contacts.entries()) {
            try {
                const before = this.getByPhone(this.#phone(raw.phone, normalized));
                const saved = this.upsert({
                    phone: raw.phone,
                    normalized,
                    name: raw.name,
                    email: raw.email,
                    // The importer calls the leftover columns `extra`; they are
                    // exactly what custom fields are for.
                    customFields: raw.customFields ?? raw.extra,
                    tags: tags.length ? tags : undefined,
                    source,
                }, { merge });
                result.ids.push(saved.id);
                if (before) result.updated += 1;
                else result.created += 1;
            } catch (err) {
                if (!(err instanceof ContactError) && !(err instanceof PhoneError)) throw err;
                result.failed.push({ row: index + 1, phone: raw.phone, error: err.message });
            }
        }
        return result;
    }

    addTags(id, tags) {
        const contact = this.#require(id);
        return this.#setTags(contact, unique([...contact.tags, ...cleanTags(tags)]));
    }

    removeTags(id, tags) {
        const contact = this.#require(id);
        const drop = new Set(cleanTags(tags));
        return this.#setTags(contact, contact.tags.filter((tag) => !drop.has(tag)));
    }

    remove(id) {
        const contact = this.#require(id);
        this.db.prepare('DELETE FROM contacts WHERE id = ? AND tenant_id = ?').run(contact.id, this.tenantId);
        return contact;
    }

    // -------------------------------------------------------------- reads --
    get(id) {
        const row = this.db.prepare('SELECT * FROM contacts WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? this.#decorate(toContact(row)) : null;
    }

    getByPhone(phone) {
        const row = this.db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND phone = ?')
            .get(this.tenantId, String(phone));
        return row ? this.#decorate(toContact(row)) : null;
    }

    /** Every distinct tag in use, with how many contacts carry it. */
    tags() {
        return this.db.prepare(
            `SELECT value AS tag, COUNT(*) AS n
             FROM contacts, json_each(contacts.tags)
             WHERE contacts.tenant_id = ?
             GROUP BY value ORDER BY n DESC, value`).all(this.tenantId)
            .map((row) => ({ tag: row.tag, count: row.n }));
    }

    /** Every custom field key in use, so a UI can offer them. */
    fieldKeys() {
        return this.db.prepare(
            `SELECT DISTINCT key FROM contacts, json_each(contacts.custom_fields)
             WHERE contacts.tenant_id = ? ORDER BY key`).all(this.tenantId).map((row) => row.key);
    }

    /**
     * Find contacts matching a filter. The same filter object is what a segment
     * stores and what a campaign audience resolves, so a segment never goes
     * stale: it is re-evaluated every time it is used.
     */
    find(filter = {}, { limit = 500, offset = 0 } = {}) {
        const { sql, args } = buildWhere(filter, this.tenantId);
        const rows = this.db.prepare(
            `SELECT * FROM contacts WHERE ${sql} ORDER BY id LIMIT ? OFFSET ?`)
            .all(...args, Math.min(Number(limit) || 500, 5000), Number(offset) || 0);
        return rows.map((row) => this.#decorate(toContact(row)));
    }

    count(filter = {}) {
        const { sql, args } = buildWhere(filter, this.tenantId);
        return this.db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE ${sql}`).get(...args).n;
    }

    /**
     * Everything that happened with this number, newest first: what we sent,
     * what they sent back. Derived from the message tables rather than kept in
     * a third one that could disagree with them.
     */
    timeline(id, { limit = 100 } = {}) {
        const contact = this.#require(id);
        const outbound = this.db.prepare(
            `SELECT message_id, message_type, message, status, created_at
             FROM messages WHERE tenant_id = ? AND recipient = ?
             ORDER BY created_at DESC LIMIT ?`).all(this.tenantId, contact.phone, limit);
        const inbound = this.db.prepare(
            `SELECT message_id, body, received_at FROM inbound_messages
             WHERE tenant_id = ? AND sender = ? ORDER BY received_at DESC LIMIT ?`)
            .all(this.tenantId, contact.phone, limit);

        return [
            ...outbound.map((row) => ({
                at: row.created_at, direction: 'outbound', kind: row.message_type ?? 'campaign',
                messageId: row.message_id, body: row.message, status: row.status,
            })),
            ...inbound.map((row) => ({
                at: row.received_at, direction: 'inbound', kind: 'message',
                messageId: row.message_id, body: row.body, status: null,
            })),
        ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
    }

    // ----------------------------------------------------------- segments --
    saveSegment({ id = null, name, filter = {} }) {
        const clean = String(name ?? '').trim();
        if (!clean) throw new ContactError('a segment needs a name');
        const now = utcNow();
        if (id) {
            const info = this.db.prepare(
                'UPDATE segments SET name = ?, filter = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
                .run(clean, JSON.stringify(filter), now, Number(id), this.tenantId);
            if (!info.changes) throw new ContactError('segment not found', 404);
            return this.getSegment(id);
        }
        const info = this.db.prepare(
            'INSERT INTO segments (tenant_id, name, filter, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
            .run(this.tenantId, clean, JSON.stringify(filter), now, now);
        return this.getSegment(Number(info.lastInsertRowid));
    }

    getSegment(id) {
        const row = this.db.prepare('SELECT * FROM segments WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toSegment(row) : null;
    }

    listSegments() {
        return this.db.prepare('SELECT * FROM segments WHERE tenant_id = ? ORDER BY id')
            .all(this.tenantId).map((row) => {
                const segment = toSegment(row);
                return { ...segment, count: this.count(segment.filter) };
            });
    }

    deleteSegment(id) {
        const info = this.db.prepare('DELETE FROM segments WHERE id = ? AND tenant_id = ?')
            .run(Number(id), this.tenantId);
        if (!info.changes) throw new ContactError('segment not found', 404);
        return true;
    }

    /** Resolve a segment to the contacts in it, right now. */
    segmentContacts(id, options = {}) {
        const segment = this.getSegment(id);
        if (!segment) throw new ContactError('segment not found', 404);
        return this.find(segment.filter, options);
    }

    // ------------------------------------------------------------ private --
    /**
     * `normalizePhone` takes what a human typed, so it is not idempotent: a
     * bare 919876543210 under country code 91 becomes 91919876543210, because
     * the function cannot know the number is already E.164 rather than a
     * national number that happens to start with the country code.
     *
     * Callers that already normalised - the sheet importer, mainly - say so
     * instead of leaving the store to guess from the digits.
     */
    #phone(value, alreadyNormalized = false) {
        try {
            return alreadyNormalized
                ? normalizePhone(`+${String(value).trim().replace(/^\+/, '')}`)
                : normalizePhone(value, this.defaultCountryCode);
        } catch (err) {
            if (err instanceof PhoneError) throw new ContactError(err.message);
            throw err;
        }
    }

    /** The stored form of a number, for callers that need to look one up. */
    normalize(phone, alreadyNormalized = false) {
        return this.#phone(phone, alreadyNormalized);
    }

    #require(id) {
        const contact = this.get(id);
        if (!contact) throw new ContactError('contact not found', 404);
        return contact;
    }

    #setTags(contact, tags) {
        this.db.prepare('UPDATE contacts SET tags = ?, updated_at = ? WHERE id = ? AND tenant_id = ?')
            .run(JSON.stringify(tags), utcNow(), contact.id, this.tenantId);
        return this.get(contact.id);
    }

    /** Opt-out is the send path's authority, so reads report it alongside. */
    #decorate(contact) {
        const optedOut = Boolean(this.db.prepare('SELECT 1 FROM opt_outs WHERE tenant_id = ? AND phone = ?')
            .get(this.tenantId, contact.phone));
        return { ...contact, optedOut, messageable: !optedOut && contact.status === 'active' };
    }
}

/**
 * Turn a filter object into SQL.
 *
 * Supported keys: `tags` (all of), `anyTags` (any of), `notTags`, `status`,
 * `optInStatus`, `optedOut`, `source`, `search` (name, phone or email),
 * `custom` ({ key: value }), `createdAfter`, `createdBefore`.
 */
export function buildWhere(filter = {}, tenantId) {
    const clauses = ['contacts.tenant_id = ?'];
    const args = [tenantId];

    const tagClause = (tag) => {
        clauses.push('EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)');
        args.push(String(tag));
    };

    for (const tag of cleanTags(filter.tags)) tagClause(tag);

    const anyTags = cleanTags(filter.anyTags);
    if (anyTags.length) {
        clauses.push(`EXISTS (SELECT 1 FROM json_each(contacts.tags)
                              WHERE value IN (${anyTags.map(() => '?').join(',')}))`);
        args.push(...anyTags);
    }

    for (const tag of cleanTags(filter.notTags)) {
        clauses.push('NOT EXISTS (SELECT 1 FROM json_each(contacts.tags) WHERE value = ?)');
        args.push(String(tag));
    }

    if (filter.status) {
        clauses.push('contacts.status = ?');
        args.push(String(filter.status));
    }
    if (filter.optInStatus) {
        clauses.push('contacts.opt_in_status = ?');
        args.push(String(filter.optInStatus));
    }
    if (filter.source) {
        clauses.push('contacts.source = ?');
        args.push(String(filter.source));
    }
    if (filter.optedOut !== undefined) {
        clauses.push(`${filter.optedOut ? '' : 'NOT '}EXISTS (
            SELECT 1 FROM opt_outs
            WHERE opt_outs.tenant_id = contacts.tenant_id AND opt_outs.phone = contacts.phone)`);
    }
    if (filter.search) {
        clauses.push('(contacts.name LIKE ? OR contacts.phone LIKE ? OR contacts.email LIKE ?)');
        const like = `%${filter.search}%`;
        args.push(like, like, like);
    }
    if (filter.createdAfter) {
        clauses.push('contacts.created_at >= ?');
        args.push(String(filter.createdAfter));
    }
    if (filter.createdBefore) {
        clauses.push('contacts.created_at < ?');
        args.push(String(filter.createdBefore));
    }

    for (const [key, value] of Object.entries(filter.custom ?? {})) {
        // json_extract with a bound path would not use the same plan, and the
        // key is an identifier we control the shape of, so it is escaped here.
        clauses.push("json_extract(contacts.custom_fields, '$.\"' || ? || '\"') = ?");
        args.push(String(key), value === null ? null : String(value));
    }

    return { sql: clauses.join(' AND '), args };
}

const unique = (list) => [...new Set(list)];

const cleanTags = (tags) => (Array.isArray(tags)
    ? unique(tags.map((tag) => String(tag).trim().toLowerCase()).filter(Boolean))
    : []);

/** Custom fields are a flat string map: nested objects are a schema in hiding. */
function cleanFields(fields) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {};
    const out = {};
    for (const [key, value] of Object.entries(fields)) {
        const clean = String(key).trim();
        if (!clean || value === null || value === undefined) continue;
        out[clean] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
    return out;
}

const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function toContact(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        phone: row.phone,
        name: row.name ?? '',
        email: row.email ?? '',
        status: row.status,
        optInStatus: row.opt_in_status,
        customFields: parse(row.custom_fields, {}),
        tags: parse(row.tags, []),
        source: row.source ?? '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toSegment(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        name: row.name,
        filter: parse(row.filter, {}),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function parse(value, fallback) {
    if (!value) return fallback;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}
