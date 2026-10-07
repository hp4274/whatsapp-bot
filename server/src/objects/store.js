/**
 * Business objects, scoped to one tenant.
 *
 * The store knows nothing about any particular type: every rule it enforces
 * comes from the registry in `types.js`. What it adds is the part the registry
 * cannot describe - durable writes, an append-only change log, and telling the
 * workflow engine that something happened.
 *
 * Emission is injected (`new ObjectStore(db, { emit })`) rather than imported,
 * like everything else in this repo, so the store can be tested without an
 * engine and the engine never has to import the thing that calls it.
 *
 * Emission is awaited, not fire-and-forget. The object is written first, so a
 * failed dispatch never loses data - but the caller is told, with a 502 that
 * carries the object, and the failure is written to the object's own event
 * trail. An order whose confirmation workflow silently did not start is a
 * support ticket nobody can diagnose; one with an `emit_failed` row is not.
 */

import { ObjectError, typeOf, validateData, validateStatus } from './types.js';

const LIST_MAX = 1000;

export class ObjectStore {
    /**
     * @param {import('../db.js').Database} database a tenant- (or channel-) scoped handle
     * @param {{ emit?: (event: object) => Promise<unknown>, now?: () => Date }} [options]
     */
    constructor(database, { emit = async () => {}, now = () => new Date() } = {}) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? null;
        this.emit = emit;
        this.now = () => iso(now());
    }

    // ------------------------------------------------------------- writes --
    async create(type, { reference, contactId = null, status, data = {}, metadata = {}, source = 'api' } = {}) {
        const entry = typeOf(type);
        const cleanData = validateData(type, data);
        const cleanStatus = validateStatus(type, status);
        const ref = String(reference ?? '').trim() || `${type}-${Math.random().toString(36).slice(2, 10)}`;
        if (this.getByReference(type, ref)) throw new ObjectError(`${type} "${ref}" already exists`, 409);
        const now = this.now();

        const info = this.db.prepare(
            `INSERT INTO business_objects (tenant_id, channel_id, type, reference, contact_id, status, data,
                                           metadata, occurs_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, this.channelId, type, ref, contactId == null ? null : Number(contactId),
                cleanStatus, JSON.stringify(cleanData), JSON.stringify(cleanMeta(metadata)),
                cleanData[entry.occursAt] ?? null, now, now);
        const id = Number(info.lastInsertRowid);
        this.#log(id, { change: 'created', field: 'status', to: cleanStatus, source, now });

        const object = this.get(id);
        await this.#emit(object, entry.events.created, { source, changes: {} });
        return object;
    }

    /**
     * Patch an object. Every field that actually changed gets a log row; a
     * status move emits the type's `statusChanged` event, any other change its
     * `updated` event (where the type declares one).
     *
     * A `null` in `data` removes that field.
     */
    async update(id, patch = {}, { source = 'api' } = {}) {
        const current = this.#require(id);
        const entry = typeOf(current.type);
        const now = this.now();
        const changes = {};

        const data = { ...current.data };
        if (patch.data !== undefined) {
            const incoming = validateData(current.type, patch.data, { partial: true });
            for (const key of Object.keys(patch.data)) {
                const next = incoming[key]; // undefined when the caller sent null/''
                if (next === data[key]) continue;
                changes[key] = { from: data[key] ?? null, to: next ?? null };
                if (next === undefined) delete data[key];
                else data[key] = next;
            }
        }
        for (const key of entry.required) {
            if (data[key] === undefined) throw new ObjectError(`${current.type} needs "${key}"`);
        }

        const status = patch.status === undefined ? current.status : validateStatus(current.type, patch.status);
        if (status !== current.status) changes.status = { from: current.status, to: status };

        const contactId = patch.contactId === undefined ? current.contactId
            : (patch.contactId == null ? null : Number(patch.contactId));
        if (contactId !== current.contactId) changes.contactId = { from: current.contactId, to: contactId };

        const metadata = patch.metadata === undefined ? current.metadata : cleanMeta(patch.metadata);
        if (JSON.stringify(metadata) !== JSON.stringify(current.metadata)) {
            changes.metadata = { from: current.metadata, to: metadata };
        }

        if (!Object.keys(changes).length) return current;

        this.db.prepare(
            `UPDATE business_objects SET contact_id = ?, status = ?, data = ?, metadata = ?, occurs_at = ?, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(contactId, status, JSON.stringify(data), JSON.stringify(metadata),
                data[entry.occursAt] ?? null, now, current.id, this.tenantId);
        for (const [field, { from, to }] of Object.entries(changes)) {
            this.#log(current.id, { change: field === 'status' ? 'status' : 'updated', field, from, to, source, now });
        }

        const object = this.get(current.id);
        const eventType = changes.status ? entry.events.statusChanged : entry.events.updated;
        if (eventType) {
            await this.#emit(object, eventType, { source, changes, previousStatus: current.status });
        }
        return object;
    }

    remove(id) {
        const object = this.#require(id);
        // The log row outlives the object on purpose: "who deleted order 42"
        // is exactly the question the trail exists to answer.
        this.#log(object.id, { change: 'deleted', field: 'status', from: object.status, to: null, now: this.now() });
        this.db.prepare('DELETE FROM business_objects WHERE id = ? AND tenant_id = ?').run(object.id, this.tenantId);
        return object;
    }

    /**
     * Emit the `due` event for every object of a type whose `occurs_at` is at
     * or before `before` - which is `now + 24h` for "remind a day ahead" and
     * `now` for "overdue". Each object is notified once: the `due` log row is
     * the idempotency record, so a sweeper can run as often as it likes.
     *
     * Failures do not abort the sweep; they are logged per object and reported.
     */
    async sweepDue({ type, before = this.now(), source = 'scheduler' }) {
        const entry = typeOf(type);
        if (!entry.events.due) return { emitted: [], failed: [] };
        const result = { emitted: [], failed: [] };
        for (const object of this.due({ type, before, unnotified: true })) {
            try {
                await this.#emit(object, entry.events.due, { source, changes: {} });
                this.#log(object.id, { change: 'due', field: entry.events.due, source, now: this.now() });
                result.emitted.push(object.id);
            } catch (err) {
                result.failed.push({ id: object.id, error: err.message });
            }
        }
        return result;
    }

    // -------------------------------------------------------------- reads --
    get(id) {
        const row = this.db.prepare('SELECT * FROM business_objects WHERE id = ? AND tenant_id = ?')
            .get(Number(id), this.tenantId);
        return row ? toObject(row) : null;
    }

    getByReference(type, reference) {
        const row = this.db.prepare('SELECT * FROM business_objects WHERE tenant_id = ? AND type = ? AND reference = ?')
            .get(this.tenantId, String(type), String(reference));
        return row ? toObject(row) : null;
    }

    /**
     * Find objects. `filter` is `{ field: value }` over `data`, the way a
     * contact filter's `custom` works; `from`/`to` bound `occurs_at`.
     */
    list({ type, status, contactId, from, to, filter, limit = 100, offset = 0 } = {}) {
        const { sql, args } = buildWhere({ type, status, contactId, from, to, filter }, this.tenantId);
        return this.db.prepare(
            `SELECT * FROM business_objects WHERE ${sql} ORDER BY id DESC LIMIT ? OFFSET ?`)
            .all(...args, Math.min(Number(limit) || 100, LIST_MAX), Number(offset) || 0).map(toObject);
    }

    count({ type, status, contactId, from, to, filter } = {}) {
        const { sql, args } = buildWhere({ type, status, contactId, from, to, filter }, this.tenantId);
        return this.db.prepare(`SELECT COUNT(*) AS n FROM business_objects WHERE ${sql}`).get(...args).n;
    }

    /**
     * Objects of a type whose `occurs_at` is at or before `before`, still in an
     * open status, soonest first. `unnotified` drops those a sweep already
     * emitted for.
     */
    due({ type, before = this.now(), unnotified = false, limit = LIST_MAX } = {}) {
        const entry = typeOf(type);
        const closed = entry.closed ?? [];
        const notified = entry.events.due && unnotified
            ? ' AND NOT EXISTS (SELECT 1 FROM object_events e WHERE e.object_id = business_objects.id AND e.change = \'due\')'
            : '';
        return this.db.prepare(
            `SELECT * FROM business_objects
             WHERE tenant_id = ? AND type = ? AND occurs_at IS NOT NULL AND occurs_at <= ?
               ${closed.length ? `AND status NOT IN (${closed.map(() => '?').join(',')})` : ''}${notified}
             ORDER BY occurs_at LIMIT ?`)
            .all(this.tenantId, type, iso(before), ...closed, Math.min(Number(limit) || LIST_MAX, LIST_MAX))
            .map(toObject);
    }

    /** The change trail of one object, oldest first. Survives deletion. */
    events(id, { limit = 500 } = {}) {
        return this.db.prepare(
            `SELECT * FROM object_events WHERE tenant_id = ? AND object_id = ? ORDER BY id LIMIT ?`)
            .all(this.tenantId, Number(id), Math.min(Number(limit) || 500, 5000)).map(toEvent);
    }

    /** Counts by type and status, for a dashboard tile. */
    stats() {
        const rows = this.db.prepare(
            `SELECT type, status, COUNT(*) AS n FROM business_objects WHERE tenant_id = ?
             GROUP BY type, status`).all(this.tenantId);
        const byType = {};
        let total = 0;
        for (const { type, status, n } of rows) {
            byType[type] ??= { total: 0, byStatus: {} };
            byType[type].total += n;
            byType[type].byStatus[status] = n;
            total += n;
        }
        return { total, byType };
    }

    // ------------------------------------------------------------ private --
    #require(id) {
        const object = this.get(id);
        if (!object) throw new ObjectError('object not found', 404);
        return object;
    }

    #log(objectId, { change, field = null, from = null, to = null, source = 'api', now }) {
        this.db.prepare(
            `INSERT INTO object_events (tenant_id, object_id, change, field, from_value, to_value, source, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, objectId, change, field, encode(from), encode(to), source, now);
    }

    /**
     * Build the §6 event and hand it to the engine. The object's own fields are
     * spread onto `data` so a workflow can write `{amount}` or `{scheduledAt}`
     * without knowing the object envelope; `contactId` is what lets the engine
     * find who the run is about.
     */
    async #emit(object, type, { source, changes, previousStatus = null }) {
        const event = {
            type,
            tenantId: this.tenantId,
            channelId: this.channelId,
            occurredAt: this.now(),
            subject: { kind: object.type, id: String(object.id) },
            data: {
                ...object.data,
                objectId: object.id,
                objectType: object.type,
                reference: object.reference,
                status: object.status,
                previousStatus,
                contactId: object.contactId,
                occursAt: object.occursAt,
                metadata: object.metadata,
                changes,
            },
            source,
        };
        try {
            await this.emit(event);
        } catch (err) {
            this.#log(object.id, { change: 'emit_failed', field: type, to: err.message, source, now: this.now() });
            const wrapped = new ObjectError(`${object.type} ${object.id} saved, but "${type}" could not be dispatched: ${err.message}`, 502);
            wrapped.object = object;
            wrapped.cause = err;
            throw wrapped;
        }
    }
}

/** Turn a list filter into SQL, the same job `buildWhere` does for contacts. */
export function buildWhere({ type, status, contactId, from, to, filter } = {}, tenantId) {
    const clauses = ['business_objects.tenant_id = ?'];
    const args = [tenantId];
    if (type) { clauses.push('business_objects.type = ?'); args.push(String(type)); }
    if (status) { clauses.push('business_objects.status = ?'); args.push(String(status)); }
    if (contactId != null && contactId !== '') { clauses.push('business_objects.contact_id = ?'); args.push(Number(contactId)); }
    if (from) { clauses.push('business_objects.occurs_at >= ?'); args.push(iso(from)); }
    if (to) { clauses.push('business_objects.occurs_at < ?'); args.push(iso(to)); }
    for (const [key, value] of Object.entries(filter ?? {})) {
        // Same trick as contacts: the key is bound, not interpolated, so a
        // caller cannot break out of the JSON path. Compared as text because
        // a query string says '10' where the JSON holds 10.
        clauses.push('CAST(json_extract(business_objects.data, \'$."\' || ? || \'"\') AS TEXT) = ?');
        args.push(String(key), typeof value === 'boolean' ? (value ? '1' : '0') : String(value));
    }
    return { sql: clauses.join(' AND '), args };
}

const iso = (value) => (value instanceof Date ? value : new Date(value)).toISOString();

const encode = (value) => (value === null || value === undefined ? null
    : (typeof value === 'object' ? JSON.stringify(value) : String(value)));

/** Metadata is free-form, but it still has to be an object: an array has no keys to filter on. */
function cleanMeta(metadata) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
    return metadata;
}

function toObject(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        channelId: row.channel_id ?? null,
        type: row.type,
        reference: row.reference,
        contactId: row.contact_id ?? null,
        status: row.status,
        data: parse(row.data, {}),
        metadata: parse(row.metadata, {}),
        occursAt: row.occurs_at ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toEvent(row) {
    return {
        id: row.id,
        objectId: row.object_id,
        change: row.change,
        field: row.field,
        from: row.from_value,
        to: row.to_value,
        source: row.source,
        at: row.created_at,
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
