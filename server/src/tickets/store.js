/**
 * Tickets, scoped to one tenant.
 *
 * The one rule that is not negotiable: every field that changes on a ticket
 * writes a `ticket_events` row. That is the product - a complaint engine with
 * no "who changed this to RESOLVED and when" is a spreadsheet - so `update()`
 * is the only writer, and the convenience methods (`setStatus`, `assign`,
 * `setPriority`) all funnel through it rather than touching SQL themselves.
 *
 * The store does not send messages. Notifying a customer is a decision about
 * someone's phone, so it lives in the route layer where a caller can opt in;
 * see `routes.js`.
 */

import { utcNow } from '../protocol.js';

export const TICKET_STATUSES = Object.freeze(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED']);
export const TICKET_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
export const TICKET_SOURCES = Object.freeze(['manual', 'workflow', 'keyword', 'api']);
export const TICKET_EVENT_KINDS = Object.freeze(['created', 'status', 'assigned', 'note', 'priority', 'message']);

/** Statuses that mean nobody is waiting on us any more. */
export const CLOSED_STATUSES = Object.freeze(['RESOLVED', 'CLOSED']);

/**
 * How long a ticket of each priority may sit before it is a breach, in hours.
 * One constant, because an SLA scattered across three call sites is an SLA
 * nobody can answer a question about.
 */
export const SLA_HOURS = Object.freeze({ low: 72, normal: 24, high: 8, urgent: 2 });

/** Field -> the event kind its change is recorded as. */
const EVENT_KIND = Object.freeze({ status: 'status', assignedTo: 'assigned', priority: 'priority' });

/** patch key -> column. Anything not here is not updatable. */
const COLUMNS = Object.freeze({
    contactId: 'contact_id',
    conversationId: 'conversation_id',
    category: 'category',
    priority: 'priority',
    status: 'status',
    assignedTo: 'assigned_to',
    subject: 'subject',
    metadata: 'metadata',
    slaDueAt: 'sla_due_at',
    firstResponseAt: 'first_response_at',
    resolvedAt: 'resolved_at',
    satisfactionScore: 'satisfaction_score',
    satisfactionComment: 'satisfaction_comment',
});

export class TicketError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

export class TicketStore {
    /** @param {import('../db.js').Database} database a tenant-scoped handle */
    constructor(database, { now = () => utcNow() } = {}) {
        this.db = database.db;
        this.tenantId = database.tenantId;
        this.channelId = database.channelId ?? null;
        this.now = () => iso(now());
    }

    // ------------------------------------------------------------- writes --
    create({
        contactId = null, conversationId = null, channelId = this.channelId,
        category = '', priority = 'normal', status = 'OPEN', assignedTo = null,
        source = 'manual', subject = '', metadata = null, userId = null,
    } = {}) {
        const now = this.now();
        const prio = pick(priority, TICKET_PRIORITIES, 'normal');
        const info = this.db.prepare(
            `INSERT INTO tickets (tenant_id, channel_id, contact_id, conversation_id, reference,
                                  category, priority, status, assigned_to, source, subject,
                                  metadata, sla_due_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(
                this.tenantId, intOrNull(channelId), intOrNull(contactId), intOrNull(conversationId),
                this.#nextReference(), String(category ?? '').trim(), prio,
                pick(status, TICKET_STATUSES, 'OPEN'), intOrNull(assignedTo),
                pick(source, TICKET_SOURCES, 'manual'), String(subject ?? '').trim(),
                JSON.stringify(metadata ?? {}), slaDueAt(now, prio), now, now,
            );
        const id = Number(info.lastInsertRowid);
        this.#event(id, { kind: 'created', userId, toValue: pick(status, TICKET_STATUSES, 'OPEN'), body: subject });
        return this.get(id);
    }

    /**
     * Apply a patch and record each field that actually moved. A patch that
     * changes nothing writes nothing - no event, no `updated_at` churn - so
     * the history is a list of changes rather than a list of saves.
     */
    update(id, patch = {}, { userId = null, note = null } = {}) {
        const before = this.#require(id);
        const changes = [];

        for (const [key, column] of Object.entries(COLUMNS)) {
            if (!(key in patch) || patch[key] === undefined) continue;
            const next = normalize(key, patch[key], before[key]);
            if (String(next ?? '') === String(before[key] ?? '')) continue;
            changes.push({ key, column, from: before[key], to: next });
        }
        if (!changes.length) return before;

        // Priority drives the SLA, so moving one without the other leaves a
        // clock that no longer matches the promise.
        if (changes.some((c) => c.key === 'priority') && !('slaDueAt' in patch)) {
            const prio = changes.find((c) => c.key === 'priority').to;
            changes.push({ key: 'slaDueAt', column: 'sla_due_at', from: before.slaDueAt, to: slaDueAt(before.createdAt, prio) });
        }
        const status = changes.find((c) => c.key === 'status');
        if (status?.to === 'RESOLVED' && !before.resolvedAt && !('resolvedAt' in patch)) {
            changes.push({ key: 'resolvedAt', column: 'resolved_at', from: null, to: this.now() });
        }

        const now = this.now();
        this.db.prepare(
            `UPDATE tickets SET ${changes.map((c) => `${c.column} = ?`).join(', ')}, updated_at = ?
             WHERE id = ? AND tenant_id = ?`)
            .run(...changes.map((c) => c.to), now, before.id, this.tenantId);

        for (const change of changes) {
            this.#event(before.id, {
                kind: EVENT_KIND[change.key] ?? 'note',
                userId,
                fromValue: change.from,
                toValue: change.to,
                body: EVENT_KIND[change.key] ? note : `${change.key} changed`,
            }, now);
        }
        return this.get(before.id);
    }

    setStatus(id, status, options = {}) {
        if (!TICKET_STATUSES.includes(status)) throw new TicketError(`status must be one of ${TICKET_STATUSES.join(', ')}`);
        return this.update(id, { status }, options);
    }

    assign(id, assignedTo, options = {}) {
        return this.update(id, { assignedTo }, options);
    }

    setPriority(id, priority, options = {}) {
        if (!TICKET_PRIORITIES.includes(priority)) {
            throw new TicketError(`priority must be one of ${TICKET_PRIORITIES.join(', ')}`);
        }
        return this.update(id, { priority }, options);
    }

    /** A free-text note. Nothing on the ticket changes; the history grows. */
    addNote(id, body, { userId = null, kind = 'note' } = {}) {
        const ticket = this.#require(id);
        const text = String(body ?? '').trim();
        if (!text) throw new TicketError('a note needs a body');
        if (!TICKET_EVENT_KINDS.includes(kind)) throw new TicketError(`unknown event kind "${kind}"`);
        return this.#event(ticket.id, { kind, userId, body: text });
    }

    /** First time an agent answered - the number an SLA report is actually about. */
    recordFirstResponse(id, { userId = null, at = null } = {}) {
        const ticket = this.#require(id);
        if (ticket.firstResponseAt) return ticket;
        return this.update(id, { firstResponseAt: at ?? this.now() }, { userId });
    }

    resolve(id, options = {}) {
        return this.setStatus(id, 'RESOLVED', options);
    }

    close(id, options = {}) {
        return this.setStatus(id, 'CLOSED', options);
    }

    /**
     * Record a CSAT answer. The question itself is a workflow's job (Phase 6);
     * this is the column it writes into.
     */
    recordSatisfaction(id, score, comment = '', { userId = null } = {}) {
        const value = Number(score);
        if (!Number.isInteger(value) || value < 1 || value > 5) {
            throw new TicketError('satisfaction score must be an integer from 1 to 5');
        }
        return this.update(id, {
            satisfactionScore: value,
            satisfactionComment: String(comment ?? '').trim(),
        }, { userId });
    }

    // -------------------------------------------------------------- reads --
    get(id) {
        const row = this.db.prepare('SELECT * FROM tickets WHERE id = ? AND tenant_id = ?')
            .get(Number(id) || 0, this.tenantId);
        return row ? toTicket(row) : null;
    }

    getByReference(reference) {
        const row = this.db.prepare('SELECT * FROM tickets WHERE tenant_id = ? AND reference = ?')
            .get(this.tenantId, String(reference ?? ''));
        return row ? toTicket(row) : null;
    }

    list({ status, assignedTo, priority, contactId, conversationId, overdue, limit = 200, offset = 0 } = {}) {
        const clauses = ['tenant_id = ?'];
        const args = [this.tenantId];
        if (status) {
            const many = Array.isArray(status) ? status : [status];
            clauses.push(`status IN (${many.map(() => '?').join(',')})`);
            args.push(...many.map(String));
        }
        if (priority) {
            clauses.push('priority = ?');
            args.push(String(priority));
        }
        if (assignedTo !== undefined && assignedTo !== null && assignedTo !== '') {
            // 'unassigned' is the queue an agent actually wants to see.
            if (assignedTo === 'unassigned') clauses.push('assigned_to IS NULL');
            else {
                clauses.push('assigned_to = ?');
                args.push(Number(assignedTo));
            }
        }
        if (contactId != null && contactId !== '') {
            clauses.push('contact_id = ?');
            args.push(Number(contactId));
        }
        if (conversationId != null && conversationId !== '') {
            clauses.push('conversation_id = ?');
            args.push(Number(conversationId));
        }
        if (overdue) {
            clauses.push(`sla_due_at IS NOT NULL AND sla_due_at < ?
                          AND status NOT IN (${CLOSED_STATUSES.map(() => '?').join(',')})`);
            args.push(typeof overdue === 'string' ? overdue : this.now(), ...CLOSED_STATUSES);
        }
        return this.db.prepare(
            `SELECT * FROM tickets WHERE ${clauses.join(' AND ')}
             ORDER BY id DESC LIMIT ? OFFSET ?`)
            .all(...args, Math.min(Number(limit) || 200, 1000), Number(offset) || 0)
            .map(toTicket);
    }

    /** The history, oldest first: it reads as a story that way. */
    events(id) {
        const ticket = this.#require(id);
        return this.db.prepare(
            'SELECT * FROM ticket_events WHERE tenant_id = ? AND ticket_id = ? ORDER BY id')
            .all(this.tenantId, ticket.id).map(toEvent);
    }

    overdue(now = null) {
        return this.list({ overdue: now ?? this.now(), limit: 1000 });
    }

    stats() {
        const group = (column) => Object.fromEntries(this.db.prepare(
            `SELECT ${column} AS k, COUNT(*) AS n FROM tickets WHERE tenant_id = ? GROUP BY ${column}`)
            .all(this.tenantId).map((row) => [row.k, row.n]));

        // Median, not mean: one ticket that sat open over a holiday weekend
        // would otherwise make the whole queue look broken.
        const spans = this.db.prepare(
            `SELECT created_at, resolved_at FROM tickets
             WHERE tenant_id = ? AND resolved_at IS NOT NULL`).all(this.tenantId)
            .map((row) => (Date.parse(row.resolved_at) - Date.parse(row.created_at)) / 1000)
            .filter((n) => Number.isFinite(n) && n >= 0)
            .sort((a, b) => a - b);

        return {
            total: this.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ?').get(this.tenantId).n,
            byStatus: { ...Object.fromEntries(TICKET_STATUSES.map((s) => [s, 0])), ...group('status') },
            byPriority: { ...Object.fromEntries(TICKET_PRIORITIES.map((p) => [p, 0])), ...group('priority') },
            overdue: this.overdue().length,
            resolved: spans.length,
            medianResolveSeconds: spans.length
                ? (spans.length % 2
                    ? spans[(spans.length - 1) / 2]
                    : (spans[spans.length / 2 - 1] + spans[spans.length / 2]) / 2)
                : null,
        };
    }

    // ------------------------------------------------------------ private --
    #require(id) {
        const ticket = this.get(id);
        if (!ticket) throw new TicketError('ticket not found', 404);
        return ticket;
    }

    /**
     * A per-tenant counter, so tenant 2's first complaint is TKT-0001 and the
     * reference tells nobody how many tickets anyone else filed.
     *
     * ponytail: COUNT(*)+1 with a retry on the unique index. node:sqlite's DatabaseSync is
     * synchronous so a single process cannot race itself; move this to a
     * `tenant_counters` row if the API ever runs more than one process.
     */
    #nextReference() {
        const used = this.db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE tenant_id = ?').get(this.tenantId).n;
        for (let seq = used + 1; seq < used + 1000; seq += 1) {
            const reference = `TKT-${String(seq).padStart(4, '0')}`;
            if (!this.getByReference(reference)) return reference;
        }
        throw new TicketError('could not allocate a ticket reference', 500);
    }

    #event(ticketId, { kind, userId = null, fromValue = null, toValue = null, body = null }, at = null) {
        const info = this.db.prepare(
            `INSERT INTO ticket_events (tenant_id, ticket_id, user_id, kind, from_value, to_value, body, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(this.tenantId, ticketId, intOrNull(userId), kind,
                str(fromValue), str(toValue), body == null ? null : String(body), at ?? this.now());
        return toEvent(this.db.prepare('SELECT * FROM ticket_events WHERE id = ?').get(Number(info.lastInsertRowid)));
    }
}

/** When a ticket opened at `from` with this priority breaches. */
export function slaDueAt(from, priority) {
    const hours = SLA_HOURS[priority] ?? SLA_HOURS.normal;
    const base = Date.parse(from);
    if (!Number.isFinite(base)) return null;
    return new Date(base + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

const iso = (value) => (value instanceof Date ? value.toISOString().replace(/\.\d{3}Z$/, 'Z') : String(value));
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const intOrNull = (value) => (value == null || value === '' ? null : Number(value));
const str = (value) => (value == null ? null : String(value));

/** Coerce a patch value to what its column stores, keeping the old on nonsense. */
function normalize(key, value, previous) {
    switch (key) {
        case 'status': return pick(value, TICKET_STATUSES, previous);
        case 'priority': return pick(value, TICKET_PRIORITIES, previous);
        case 'contactId':
        case 'conversationId':
        case 'assignedTo':
        case 'satisfactionScore': return intOrNull(value);
        case 'metadata': return typeof value === 'string' ? value : JSON.stringify(value ?? {});
        default: return value == null ? null : String(value);
    }
}

function toTicket(row) {
    return {
        id: row.id,
        tenantId: row.tenant_id,
        channelId: row.channel_id,
        contactId: row.contact_id,
        conversationId: row.conversation_id,
        reference: row.reference,
        category: row.category ?? '',
        priority: row.priority,
        status: row.status,
        assignedTo: row.assigned_to,
        source: row.source,
        subject: row.subject ?? '',
        metadata: parse(row.metadata, {}),
        slaDueAt: row.sla_due_at,
        firstResponseAt: row.first_response_at,
        resolvedAt: row.resolved_at,
        satisfactionScore: row.satisfaction_score,
        satisfactionComment: row.satisfaction_comment ?? '',
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

function toEvent(row) {
    return {
        id: row.id,
        ticketId: row.ticket_id,
        userId: row.user_id,
        kind: row.kind,
        from: row.from_value,
        to: row.to_value,
        body: row.body,
        createdAt: row.created_at,
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
