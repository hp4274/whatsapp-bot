/**
 * The object type registry: what each business object looks like and what it
 * tells the workflow engine when it changes.
 *
 * This file is the whole answer to "is a new industry configuration or code".
 * Adding Invoice is one entry here - fields, statuses, event names - and the
 * store, routes and tests pick it up without a branch anywhere. If you find
 * yourself writing `if (type === 'order')` outside this file, put whatever
 * the branch knows into the entry instead.
 *
 * `ticket` is deliberately absent: tickets have SLA, assignment and their own
 * event trail, which is behaviour, not shape, so they get their own table.
 *
 * Entry shape:
 *   fields       { name: 'string' | 'number' | 'boolean' | 'datetime' }
 *   required     field names that must be present on create
 *   statuses     the allowed enum; the first one is the default
 *   closed       statuses after which `due` has nothing to say (a paid payment is not overdue)
 *   occursAt     which field mirrors into the `occurs_at` column (optional)
 *   events       { created, updated?, statusChanged, due? }
 *                  created       emitted once on create
 *                  statusChanged emitted when status moves
 *                  updated       emitted when something other than status moves
 *                  due           emitted by `sweepDue` once `occurs_at` passes
 *
 * Event names come from phases/README.md "Phase 6 -> Trigger Types -> Event"
 * where that list names one; the rest follow the `<type>.<verb>` convention.
 */

export const FIELD_TYPES = Object.freeze(['string', 'number', 'boolean', 'datetime']);

export const OBJECT_TYPES = Object.freeze({
    lead: {
        label: 'Lead',
        fields: { name: 'string', source: 'string', interest: 'string', value: 'number', assignedTo: 'string', notes: 'string' },
        required: [],
        statuses: ['new', 'contacted', 'qualified', 'converted', 'lost'],
        closed: ['converted', 'lost'],
        events: { created: 'lead.created', updated: 'lead.updated', statusChanged: 'lead.updated' },
    },
    appointment: {
        label: 'Appointment',
        fields: { service: 'string', scheduledAt: 'datetime', durationMinutes: 'number', staffId: 'string', location: 'string', notes: 'string' },
        required: ['service', 'scheduledAt'],
        statuses: ['scheduled', 'confirmed', 'rescheduled', 'completed', 'cancelled', 'no_show'],
        closed: ['completed', 'cancelled', 'no_show'],
        occursAt: 'scheduledAt',
        events: { created: 'appointment.created', updated: 'appointment.updated', statusChanged: 'appointment.updated', due: 'appointment.due' },
    },
    order: {
        label: 'Order',
        fields: { amount: 'number', currency: 'string', items: 'string', trackingId: 'string', deliveryAt: 'datetime', notes: 'string' },
        required: ['amount'],
        statuses: ['placed', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
        closed: ['delivered', 'cancelled', 'refunded'],
        occursAt: 'deliveryAt',
        events: { created: 'order.created', statusChanged: 'order.status_changed' },
    },
    payment: {
        label: 'Payment',
        fields: { amount: 'number', currency: 'string', dueAt: 'datetime', paidAt: 'datetime', method: 'string', invoiceId: 'string', notes: 'string' },
        required: ['amount', 'dueAt'],
        statuses: ['pending', 'paid', 'overdue', 'failed', 'refunded', 'cancelled'],
        closed: ['paid', 'refunded', 'cancelled'],
        occursAt: 'dueAt',
        events: { created: 'payment.created', statusChanged: 'payment.status_changed', due: 'payment.due' },
    },
    subscription: {
        label: 'Subscription',
        fields: { plan: 'string', amount: 'number', currency: 'string', startsAt: 'datetime', expiresAt: 'datetime', autoRenew: 'boolean', notes: 'string' },
        required: ['plan', 'expiresAt'],
        statuses: ['trial', 'active', 'past_due', 'expired', 'cancelled'],
        closed: ['expired', 'cancelled'],
        occursAt: 'expiresAt',
        events: { created: 'subscription.created', statusChanged: 'subscription.status_changed', due: 'subscription.expiring' },
    },
    event: {
        label: 'Event',
        fields: { title: 'string', startsAt: 'datetime', endsAt: 'datetime', venue: 'string', capacity: 'number', notes: 'string' },
        required: ['title', 'startsAt'],
        statuses: ['draft', 'published', 'full', 'completed', 'cancelled'],
        closed: ['completed', 'cancelled'],
        occursAt: 'startsAt',
        events: { created: 'event.created', statusChanged: 'event.status_changed', due: 'event.due' },
    },
    student: {
        label: 'Student',
        fields: {
            name: 'string', rollNumber: 'string', className: 'string', section: 'string', course: 'string', batch: 'string',
            parentName: 'string', fatherName: 'string', motherName: 'string', parentPhone: 'string', busRoute: 'string',
            hostel: 'boolean', enrolledAt: 'datetime', notes: 'string',
        },
        required: ['name'],
        statuses: ['enquiry', 'enrolled', 'active', 'on_hold', 'graduated', 'dropped'],
        closed: ['graduated', 'dropped'],
        events: { created: 'student.created', statusChanged: 'student.status_changed' },
    },
    attendance: {
        label: 'Attendance',
        fields: {
            studentId: 'number', rollNumber: 'string', studentName: 'string', className: 'string', section: 'string', date: 'datetime',
            arrivedAt: 'string', reason: 'string', markedBy: 'string', alertedAt: 'datetime', notes: 'string',
        },
        required: ['studentName', 'date'],
        statuses: ['present', 'absent', 'late', 'excused'],
        closed: [],
        occursAt: 'date',
        events: { created: 'attendance.created', statusChanged: 'attendance.status_changed', due: 'attendance.due' },
    },
    timetable: {
        label: 'Timetable',
        fields: {
            className: 'string', section: 'string', day: 'string', period: 'string', startTime: 'string', endTime: 'string',
            subject: 'string', teacher: 'string', room: 'string', startsAt: 'datetime', endsAt: 'datetime', notes: 'string',
        },
        required: ['className', 'day', 'subject'],
        statuses: ['scheduled', 'changed', 'cancelled'],
        closed: ['cancelled'],
        occursAt: 'startsAt',
        events: { created: 'timetable.created', updated: 'timetable.updated', statusChanged: 'timetable.status_changed', due: 'timetable.due' },
    },
    homework: {
        label: 'Homework',
        fields: {
            className: 'string', section: 'string', subject: 'string', title: 'string', instructions: 'string', assignedAt: 'datetime',
            dueAt: 'datetime', teacher: 'string', mediaId: 'string', campaignId: 'number', notes: 'string',
        },
        required: ['className', 'subject', 'title'],
        statuses: ['assigned', 'reminded', 'submitted', 'closed', 'cancelled'],
        closed: ['submitted', 'closed', 'cancelled'],
        occursAt: 'dueAt',
        events: { created: 'homework.created', updated: 'homework.updated', statusChanged: 'homework.status_changed', due: 'homework.due' },
    },
    exam_result: {
        label: 'Exam Result',
        fields: {
            studentId: 'number', rollNumber: 'string', studentName: 'string', className: 'string', section: 'string', examName: 'string',
            subject: 'string', marks: 'number', totalMarks: 'number', grade: 'string', breakdown: 'string', publishedAt: 'datetime',
            dispatchedAt: 'datetime', remarks: 'string',
        },
        required: ['studentName', 'examName'],
        statuses: ['draft', 'published', 'withheld', 'corrected'],
        closed: [],
        occursAt: 'publishedAt',
        events: { created: 'exam_result.created', updated: 'exam_result.updated', statusChanged: 'exam_result.status_changed', due: 'exam_result.due' },
    },
    fee: {
        label: 'Fee',
        fields: {
            studentId: 'number', studentName: 'string', className: 'string', section: 'string', term: 'string', amount: 'number',
            currency: 'string', dueAt: 'datetime', paidAt: 'datetime', method: 'string', payLink: 'string', receiptNo: 'string', notes: 'string',
        },
        required: ['amount', 'dueAt'],
        statuses: ['pending', 'paid', 'overdue', 'waived'],
        closed: ['paid', 'waived'],
        occursAt: 'dueAt',
        events: { created: 'fee.created', statusChanged: 'fee.status_changed', due: 'fee.due' },
    },
    // Circulars, calendar entries (holidays, events, exam date sheets) and broadcasts.
    notice: {
        label: 'Notice',
        fields: {
            kind: 'string', title: 'string', body: 'string', startsAt: 'datetime', endsAt: 'datetime', audience: 'string',
            mediaId: 'string', sentAt: 'datetime', campaignId: 'number', notes: 'string',
        },
        required: ['kind', 'title'],
        statuses: ['draft', 'published', 'archived'],
        closed: ['archived'],
        occursAt: 'startsAt',
        events: { created: 'notice.created', statusChanged: 'notice.status_changed' },
    },
});

export class ObjectError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

/** The registry entry for a type, or a 404 - an unknown type is a bad URL, not a bug. */
export function typeOf(type) {
    const entry = OBJECT_TYPES[String(type ?? '').toLowerCase()];
    if (!entry) throw new ObjectError(`unknown object type "${type}"`, 404);
    return entry;
}

/** Every event name any type can emit, for the workflow UI's trigger picker. */
export function eventTypes() {
    return [...new Set(Object.values(OBJECT_TYPES).flatMap((t) => Object.values(t.events)))].sort();
}

/**
 * Check `data` against a type's fields. Unknown keys are rejected rather than
 * dropped: a typo in `scheduledAt` would otherwise quietly leave an appointment
 * with no reminder. Free-form extras belong in `metadata`.
 *
 * `partial` skips the required check, for updates.
 */
export function validateData(type, data = {}, { partial = false } = {}) {
    const entry = typeOf(type);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ObjectError('data must be an object');
    const out = {};
    for (const [key, raw] of Object.entries(data)) {
        const kind = entry.fields[key];
        if (!kind) throw new ObjectError(`${type} has no field "${key}"`);
        if (raw === undefined || raw === null || raw === '') continue;
        out[key] = coerce(kind, raw, key);
    }
    if (!partial) {
        for (const key of entry.required) {
            if (out[key] === undefined) throw new ObjectError(`${type} needs "${key}"`);
        }
    }
    return out;
}

export function validateStatus(type, status) {
    const entry = typeOf(type);
    if (status === undefined || status === null || status === '') return entry.statuses[0];
    if (!entry.statuses.includes(status)) {
        throw new ObjectError(`${type} status must be one of ${entry.statuses.join(', ')}`);
    }
    return status;
}

function coerce(kind, value, key) {
    switch (kind) {
        case 'number': {
            const n = Number(value);
            if (!Number.isFinite(n)) throw new ObjectError(`"${key}" must be a number`);
            return n;
        }
        case 'boolean':
            if (typeof value === 'boolean') return value;
            if (value === 'true' || value === 1 || value === '1') return true;
            if (value === 'false' || value === 0 || value === '0') return false;
            throw new ObjectError(`"${key}" must be true or false`);
        case 'datetime': {
            const d = new Date(value);
            if (Number.isNaN(d.getTime())) throw new ObjectError(`"${key}" must be a date-time`);
            return d.toISOString();
        }
        default:
            return typeof value === 'object' ? JSON.stringify(value) : String(value);
    }
}
