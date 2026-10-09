/**
 * School Assistant routes, mounted per channel runtime by `FEATURE_ROUTERS`.
 * The wire contract is `web/src/app/school/school-api.ts`; change both together.
 *
 * Nothing here owns a table except settings. Students, attendance, timetable,
 * homework, results, fees and notices are business objects (so installed
 * workflow recipes see their events), leave requests are tickets, PTM slots
 * are appointments, and every message to a parent goes through the message
 * service with a deterministic idempotency key - a double-clicked "notify"
 * is one message, not two.
 *
 * Class key: `${className}${section}` upper-cased, e.g. "10A". Parent
 * contacts carry `class-10a` / `route-<r>` / `hostel` tags so audiences
 * resolve by tag at send time.
 *
 * Bulk sends (homework, notices, broadcasts) are individual message-service
 * jobs rather than campaigns: a campaign start resets the channel queue and
 * skips anyone ever messaged before, which would drop today's absent alerts
 * and skip every parent who got yesterday's homework.
 */

import crypto from 'node:crypto';

import express from 'express';
import multer from 'multer';
import { checkImport } from '../security/filetype.js';

import { normalizeHeader, parseCsv } from '../contacts.js';
import { MessageJobError, messageJob } from '../messaging/job.js';
import { personalize } from '../protocol.js';
import { roleRank } from '../tenancy.js';
import { SCHOOL_TEMPLATES } from './templates.js';
import { getSettings, publicSettings, saveSettings } from './settings.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

export const SERVICE = 'school_whatsapp_bot';
export const DAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
const STATUSES = Object.freeze(['present', 'absent', 'late', 'excused']);
const NOTICE_KINDS = Object.freeze(['circular', 'holiday', 'event', 'exam']);
const BROADCAST_KINDS = Object.freeze(['emergency', 'bus', 'general']);
const TITLES = Object.freeze(['principal', 'class_teacher', 'accounts', 'front_desk']);
const ALL_AREAS = Object.freeze(['overview', 'attendance', 'timetable', 'homework', 'notices', 'students',
    'fees', 'leave', 'results', 'broadcast', 'ptm', 'staff', 'settings']);
/** What each staff title may open, and which of those it may only read. */
const TITLE_ACCESS = Object.freeze({
    principal: { areas: ALL_AREAS, readOnly: [] },
    class_teacher: {
        areas: ['overview', 'attendance', 'timetable', 'homework', 'notices', 'students', 'results', 'ptm', 'leave'],
        readOnly: ['notices', 'students'],
    },
    accounts: { areas: ['overview', 'fees'], readOnly: [] },
    front_desk: { areas: ['overview', 'leave', 'ptm', 'students'], readOnly: ['students'] },
});
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const PAGE = 1000;

export class SchoolError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// ---------------------------------------------------------------- helpers --

export const normKey = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase();
export const classKeyOf = (data) => normKey(`${data.className ?? ''}${data.section ?? ''}`);
const classTag = (key) => `class-${normKey(key).toLowerCase()}`;
const routeTag = (route) => `route-${String(route).trim().toLowerCase().replace(/\s+/g, '-')}`;
const byRoll = (a, b) => String(a.data.rollNumber ?? '').localeCompare(String(b.data.rollNumber ?? ''), undefined, { numeric: true });
const dateOnly = (value) => (value ? String(value).slice(0, 10) : null);
const dayStart = (date) => `${date}T00:00:00.000Z`;
const nextDay = (date) => new Date(Date.parse(dayStart(date)) + 86_400_000).toISOString();
const isDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '')) && !Number.isNaN(Date.parse(value));
const hash = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);

/** Wall-clock date, time and weekday in `timeZone`; a bad zone reads as UTC. */
export function localNow(timeZone, at = new Date()) {
    let parts;
    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
        }).formatToParts(at);
    } catch {
        return localNow('UTC', at);
    }
    const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, day: p.weekday, month: `${p.year}-${p.month}` };
}

/** The UTC instant of a wall-clock time in `timeZone`. ponytail: ignores the DST-gap hour. */
function zonedToUtc(date, time, timeZone) {
    const guess = new Date(`${date}T${time}:00Z`);
    const local = localNow(timeZone, guess);
    return new Date(guess.getTime() - (Date.parse(`${local.date}T${local.time}:00Z`) - guess.getTime()));
}

export const today = (state) => localNow(state.channel?.timezone);

/** Every object of a type matching `filter`, paging past the store's 1000-row cap. */
export function listAll(objects, query) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
        const page = objects.list({ ...query, limit: PAGE, offset });
        out.push(...page);
        if (page.length < PAGE) return out;
    }
}

/** The tenant's own template of that name when it has one, else the pack default. */
export function render(state, name, vars) {
    const body = state.templates?.getByName(name)?.body ?? SCHOOL_TEMPLATES[name];
    const clean = Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v ?? '']));
    return personalize(body, clean);
}

/**
 * One message through the service. Returns 'sent', 'skipped' (duplicate key,
 * opted out, bot paused) or 'failed' (channel refused). `urgent` takes the
 * top queue priority, but it is still the manager's queue - pacing and the
 * super admin's daily cap apply exactly as they do to everything else.
 */
export function deliver(state, { recipient, text, key, messageType = 'transactional', media = null, urgent = false }) {
    if (!recipient) return 'skipped';
    try {
        const input = { messageType, recipient, text, media, idempotencyKey: key };
        // The service accepts a pre-built job verbatim when it carries a priority.
        const outcome = state.messages.send(urgent
            ? { ...messageJob({ ...input, tenantId: state.db.tenantId, channelId: state.channel.id }), priority: 0 }
            : input);
        if (!outcome.accepted) return outcome.reason === 'duplicate' ? 'duplicate' : 'skipped';
        state.manager?.start();
        return 'sent';
    } catch (err) {
        if (err instanceof MessageJobError) return 'failed';
        throw err;
    }
}

const tally = () => ({ sent: 0, skipped: 0, failed: 0 });
const count = (result, outcome) => { result[outcome === 'duplicate' ? 'skipped' : outcome] += 1; };

/** Messageable parent contacts for an audience: `{all}`, `{classKeys}` or `{routes}`. */
export function audienceContacts(state, audience) {
    let filter;
    if (audience?.all === true) filter = { tags: ['school'] };
    else if (Array.isArray(audience?.classKeys) && audience.classKeys.length) filter = { anyTags: audience.classKeys.map(classTag) };
    else if (Array.isArray(audience?.routes) && audience.routes.length) filter = { anyTags: audience.routes.map(routeTag) };
    else throw new SchoolError('audience must be {all:true}, {classKeys:[...]} or {routes:[...]}');
    return state.contacts.find(filter, { limit: 10000 }).filter((c) => c.messageable);
}

function validAudience(audience) {
    const keys = Object.keys(audience ?? {});
    if (keys.length !== 1) return false;
    if (keys[0] === 'all') return audience.all === true;
    return ['classKeys', 'routes'].includes(keys[0]) && Array.isArray(audience[keys[0]]) && audience[keys[0]].length > 0;
}

/** Read a CSV/XLSX upload as rows keyed by snake_case header, each with its sheet row number. */
async function readSheet(file) {
    let records;
    if (/\.xls[xm]?$/i.test(file.originalname)) {
        const XLSX = await import('xlsx');
        const book = XLSX.read(file.buffer, { type: 'buffer' });
        const sheet = book.Sheets[book.SheetNames[0]];
        records = sheet ? XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false }) : [];
    } else {
        const rows = parseCsv(file.buffer.toString('utf8'));
        const header = rows[0] ?? [];
        records = rows.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
    }
    return records
        .map((record, index) => ({
            row: index + 2,
            raw: record,
            ...Object.fromEntries(Object.entries(record).map(([k, v]) => [normalizeHeader(k), String(v ?? '').trim()])),
        }))
        .filter((r) => Object.entries(r).some(([k, v]) => k !== 'row' && k !== 'raw' && v !== ''));
}

const yes = (value) => ['y', 'yes', 'true', '1'].includes(String(value ?? '').trim().toLowerCase());

/** CBSE-style grade from a percentage, used when a results sheet has no Grade column. */
function gradeFor(percent) {
    const scale = [[91, 'A1'], [81, 'A2'], [71, 'B1'], [61, 'B2'], [51, 'C1'], [41, 'C2'], [33, 'D']];
    return scale.find(([min]) => percent >= min)?.[1] ?? 'E';
}

/** "45" or "45/50" -> { marks, total }; total defaults to 100. */
function parseMarks(cell) {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?))?\s*$/.exec(String(cell ?? ''));
    return match ? { marks: Number(match[1]), total: match[2] ? Number(match[2]) : 100 } : null;
}

function parseJson(value, fallback) {
    try {
        return value ? JSON.parse(value) : fallback;
    } catch {
        return fallback;
    }
}

// ---------------------------------------------------------------- DTOs --

export function toStudent(o) {
    const d = o.data;
    return {
        id: o.id, rollNumber: d.rollNumber ?? '', name: d.name ?? '', className: d.className ?? '', section: d.section ?? '',
        classKey: classKeyOf(d), fatherName: d.fatherName ?? '', motherName: d.motherName ?? '',
        parentPhone: d.parentPhone ?? '', busRoute: d.busRoute ?? '', hostel: Boolean(d.hostel),
        status: o.status, contactId: o.contactId ?? null,
    };
}

const toEntry = (o) => ({
    id: o.id, day: o.data.day, period: o.data.period ?? '', startTime: o.data.startTime ?? '', endTime: o.data.endTime ?? '',
    subject: o.data.subject ?? '', teacher: o.data.teacher ?? '', room: o.data.room ?? '', status: o.status,
});

const toHomework = (o) => ({
    id: o.id, classKey: o.metadata.classKey ?? classKeyOf(o.data), subject: o.data.subject ?? '', title: o.data.title ?? '',
    instructions: o.data.instructions ?? '', dueAt: o.data.dueAt ?? null, mediaId: o.data.mediaId ?? null,
    sendAt: o.metadata.sendAt ?? null, status: o.status, createdAt: o.createdAt,
});

const toNotice = (o) => ({
    id: o.id, kind: o.data.kind, title: o.data.title ?? '', body: o.data.body ?? '', startsAt: o.data.startsAt ?? null,
    endsAt: o.data.endsAt ?? null, audience: parseJson(o.data.audience, { all: true }), mediaId: o.data.mediaId ?? null,
    sentAt: o.data.sentAt ?? null, status: o.status, createdAt: o.createdAt,
});

/** A pending fee whose due date has passed reads as overdue even before the sweep writes it. */
export function feeStatus(o, todayDate) {
    return o.status === 'pending' && dateOnly(o.data.dueAt) < todayDate ? 'overdue' : o.status;
}

export function payLinkFor(o, settings) {
    if (o.data.payLink) return o.data.payLink;
    if (!settings.upiId) return null;
    const e = encodeURIComponent;
    return `upi://pay?pa=${e(settings.upiId)}&pn=${e(settings.payeeName)}&am=${e(o.data.amount)}`
        + `&cu=${e(o.data.currency || settings.currency)}&tn=${e(o.data.term ?? '')}`;
}

export const toFee = (o, settings, todayDate) => ({
    id: o.id, studentId: o.data.studentId, studentName: o.data.studentName ?? '', classKey: classKeyOf(o.data),
    term: o.data.term ?? '', amount: o.data.amount, currency: o.data.currency || settings.currency, dueAt: o.data.dueAt,
    paidAt: o.data.paidAt ?? null, method: o.data.method ?? null, payLink: payLinkFor(o, settings),
    receiptNo: o.data.receiptNo ?? null, status: feeStatus(o, todayDate),
});

export const toResult = (o) => ({
    id: o.id, studentId: o.data.studentId, rollNumber: o.data.rollNumber ?? '', studentName: o.data.studentName ?? '',
    classKey: classKeyOf(o.data), examName: o.data.examName, breakdown: parseJson(o.data.breakdown, []),
    marks: o.data.marks ?? 0, totalMarks: o.data.totalMarks ?? 0, grade: o.data.grade ?? '', dispatchedAt: o.data.dispatchedAt ?? null,
});

export const toLeave = (t) => ({
    ticketId: t.id, reference: t.reference, studentName: t.metadata.studentName ?? '', classKey: t.metadata.classKey ?? '',
    parentPhone: t.metadata.parentPhone ?? '', reason: t.metadata.reason ?? t.subject, fromDate: t.metadata.fromDate ?? null,
    toDate: t.metadata.toDate ?? null, status: t.metadata.decision ?? 'pending', createdAt: t.createdAt,
});

export const isPtm = (o) => o.metadata?.kind === 'ptm_slot';
export function toSlot(o) {
    return {
        id: o.id, startsAt: o.data.scheduledAt, durationMinutes: o.data.durationMinutes ?? 10, teacher: o.data.staffId ?? '',
        classKey: o.metadata.classKey ?? '', status: o.status === 'cancelled' ? 'cancelled' : (o.contactId ? 'booked' : 'open'),
        studentName: o.metadata.studentName ?? null, parentPhone: o.metadata.parentPhone ?? null,
    };
}

export const isLeave = (t) => t.category === 'leave_request';

// ---------------------------------------------------------- shared reads --

export const students = (state) => listAll(state.objects, { type: 'student' }).sort(byRoll);

export function attendanceBetween(state, from, to, filter) {
    return listAll(state.objects, { type: 'attendance', from: dayStart(from), to: dayStart(to), filter });
}

/** One student's month: marked days, percentage of present+late over marked, absent dates. */
export function monthReport(state, studentId, month) {
    const [y, m] = month.split('-').map(Number);
    const end = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
    const rows = attendanceBetween(state, `${month}-01`, end, { studentId })
        .map((o) => ({ date: dateOnly(o.data.date), status: o.status }))
        .sort((a, b) => a.date.localeCompare(b.date));
    const attended = rows.filter((r) => r.status === 'present' || r.status === 'late').length;
    return {
        days: rows,
        percentage: rows.length ? Math.round((attended / rows.length) * 1000) / 10 : 0,
        absentDates: rows.filter((r) => r.status === 'absent').map((r) => r.date),
    };
}

/**
 * Send absent/late alerts for one date. Each attendance row is alerted once:
 * `alertedAt` is the record, and the idempotency key catches the race where
 * two clicks land before either writes it.
 */
export async function notifyAttendance(state, { date, classKey = null, kinds = ['absent'] }) {
    const settings = getSettings(state.db.db, state.db.tenantId);
    const result = tally();
    for (const row of attendanceBetween(state, date, dateOnly(nextDay(date)))) {
        if (!kinds.includes(row.status)) continue;
        if (classKey && classKeyOf(row.data) !== normKey(classKey)) continue;
        if (row.data.alertedAt) { result.skipped += 1; continue; }
        const contact = row.contactId ? state.contacts.get(row.contactId) : null;
        const text = render(state, row.status === 'late' ? 'school_late_alert' : 'school_absent_alert', {
            rollNumber: row.data.rollNumber, studentName: row.data.studentName, classKey: classKeyOf(row.data), date,
            arrivedAt: row.data.arrivedAt ?? '', gateCutoff: settings.gateCutoff,
        });
        const outcome = deliver(state, {
            recipient: contact?.phone, text, key: `school.${row.status}.${row.data.studentId}.${date}`,
        });
        count(result, outcome);
        if (outcome === 'sent' || outcome === 'duplicate') {
            await state.objects.update(row.id, { data: { alertedAt: new Date().toISOString() } }, { source: 'school' });
        }
    }
    return result;
}

/** Send one homework to its class's parents and stamp it sent. */
async function sendHomework(state, hw) {
    const result = tally();
    const dto = toHomework(hw);
    const media = dto.mediaId ? state.media?.get(dto.mediaId) ?? null : null;
    const text = render(state, 'school_homework', {
        classKey: dto.classKey, subject: dto.subject, title: dto.title, instructions: dto.instructions,
        dueAt: dto.dueAt ? dateOnly(dto.dueAt) : '-',
    });
    for (const contact of audienceContacts(state, { classKeys: [dto.classKey] })) {
        count(result, deliver(state, {
            recipient: contact.phone, text, media, messageType: 'reminder', key: `school.hw.${hw.id}.${contact.id}`,
        }));
    }
    await state.objects.update(hw.id, { metadata: { ...hw.metadata, sentAt: new Date().toISOString() } }, { source: 'school' });
    return result;
}

async function sendNotice(state, notice) {
    const result = tally();
    const dto = toNotice(notice);
    const settings = getSettings(state.db.db, state.db.tenantId);
    const media = dto.mediaId ? state.media?.get(dto.mediaId) ?? null : null;
    const text = render(state, 'school_notice', { schoolName: settings.schoolName, title: dto.title, body: dto.body });
    for (const contact of audienceContacts(state, dto.audience)) {
        count(result, deliver(state, {
            recipient: contact.phone, text, media, messageType: 'reminder', key: `school.notice.${notice.id}.${contact.id}`,
        }));
    }
    await state.objects.update(notice.id, {
        data: { sentAt: new Date().toISOString() }, metadata: { ...notice.metadata, sendAt: null },
    }, { source: 'school' });
    return result;
}

/** The staff profile behind a request: admins are principals, agents get what settings give them. */
export function profileFor(user, settings) {
    if (roleRank(user?.role) >= roleRank('admin')) return { title: 'principal', classes: [], ...TITLE_ACCESS.principal };
    const staff = settings.staff?.[user?.id];
    if (!staff || !TITLE_ACCESS[staff.title]) return { title: 'front_desk', classes: [], areas: ['overview'], readOnly: [] };
    return { title: staff.title, classes: (staff.classes ?? []).map(normKey), ...TITLE_ACCESS[staff.title] };
}

const inClasses = (profile, key) => !profile.classes.length || profile.classes.includes(normKey(key));

// ---------------------------------------------------------------- router --

export function createSchoolRouter({ db, state }) {
    const router = express.Router();
    const settings = () => getSettings(db.db, db.tenantId);
    const objects = () => state.objects;

    /** Area gate. Writes to a read-only area are refused the same as a closed one. */
    const gate = (area, { write = false } = {}) => (req, res, next) => {
        const profile = profileFor(req.user, settings());
        if (!profile.areas.includes(area) || (write && profile.readOnly.includes(area))) {
            return res.status(403).json({ errors: [`You do not have access to ${area}.`] });
        }
        req.school = profile;
        return next();
    };
    const requireClass = (req, key) => {
        if (!inClasses(req.school, key)) throw new SchoolError(`You do not have access to class ${normKey(key)}.`, 403);
    };
    const visible = (req, list, keyOf) => list.filter((item) => inClasses(req.school, keyOf(item)));
    const requireStudent = (id) => {
        const o = objects().get(id);
        if (!o || o.type !== 'student') throw new SchoolError('student not found', 404);
        return o;
    };
    const requireObject = (type, id, what = type) => {
        const o = objects().get(id);
        if (!o || o.type !== type) throw new SchoolError(`${what} not found`, 404);
        return o;
    };
    /** className/section for a class key, from the students who are in it. */
    const classParts = (key) => {
        const s = students(state).find((o) => classKeyOf(o.data) === normKey(key));
        return s ? { className: s.data.className, section: s.data.section ?? '' } : { className: normKey(key), section: '' };
    };

    // ------------------------------------------------------- settings & me --
    router.get('/school/settings', gate('overview'), (req, res) => res.json({ settings: publicSettings(settings()) }));

    router.put('/school/settings', gate('settings', { write: true }), (req, res) => {
        const body = req.body ?? {};
        const patch = {};
        for (const key of ['schoolName', 'upiId', 'payeeName', 'currency']) {
            if (body[key] !== undefined) patch[key] = String(body[key] ?? '').trim();
        }
        for (const key of ['gateCutoff', 'homeworkSendTime']) {
            if (body[key] === undefined) continue;
            if (!HHMM.test(body[key])) throw new SchoolError(`${key} must be HH:MM`);
            patch[key] = body[key];
        }
        if (body.absentAlertTime !== undefined) {
            if (body.absentAlertTime !== null && body.absentAlertTime !== '' && !HHMM.test(body.absentAlertTime)) {
                throw new SchoolError('absentAlertTime must be HH:MM or null');
            }
            patch.absentAlertTime = body.absentAlertTime || null;
        }
        for (const key of ['monthlySummary', 'commandsEnabled']) {
            if (body[key] !== undefined) patch[key] = Boolean(body[key]);
        }
        if (patch.currency === '') patch.currency = 'INR';
        return res.json({ settings: publicSettings(saveSettings(db.db, db.tenantId, patch)) });
    });

    router.get('/school/me', (req, res) => {
        const { title, classes, areas } = profileFor(req.user, settings());
        res.json({ title, classes, areas });
    });

    router.get('/school/overview', gate('overview'), (req, res) => {
        const now = today(state);
        const date = isDate(req.query.date) ? req.query.date : now.date;
        const roster = visible(req, students(state), (o) => classKeyOf(o.data));
        const marks = visible(req, attendanceBetween(state, date, dateOnly(nextDay(date))), (o) => classKeyOf(o.data));
        const by = (status) => marks.filter((o) => o.status === status);
        const present = by('present').length;
        const late = by('late').length;
        const absent = by('absent');
        const conf = settings();
        const month = date.slice(0, 7);
        const fees = listAll(objects(), { type: 'fee' });
        const sum = (list) => list.reduce((n, o) => n + (Number(o.data.amount) || 0), 0);
        res.json({
            date,
            students: roster.length,
            classes: new Set(roster.map((o) => classKeyOf(o.data))).size,
            attendance: {
                marked: marks.length, present, absent: absent.length, late,
                rate: marks.length ? Math.round(((present + late) / marks.length) * 1000) / 10 : 0,
            },
            alerts: { absentSent: absent.filter((o) => o.data.alertedAt).length, absentTotal: absent.length },
            inbox: { unread: state.conversations?.stats().unread ?? 0 },
            fees: {
                month,
                collected: sum(fees.filter((o) => o.status === 'paid' && String(o.data.paidAt ?? '').startsWith(month))),
                pending: sum(fees.filter((o) => feeStatus(o, now.date) === 'pending')),
                overdue: sum(fees.filter((o) => feeStatus(o, now.date) === 'overdue')),
                currency: conf.currency,
            },
            leave: { pending: state.tickets.list({ limit: 1000 }).filter((t) => isLeave(t) && !t.metadata.decision).length },
            homeworkToday: visible(req, listAll(objects(), { type: 'homework' }), (o) => toHomework(o).classKey)
                .filter((o) => localNow(state.channel?.timezone, new Date(o.createdAt)).date === date).length,
        });
    });

    router.get('/school/classes', gate('overview'), (req, res) => {
        const map = new Map();
        for (const o of students(state)) {
            const key = classKeyOf(o.data);
            const entry = map.get(key) ?? { key, className: o.data.className ?? '', section: o.data.section ?? '', students: 0 };
            entry.students += 1;
            map.set(key, entry);
        }
        const classes = visible(req, [...map.values()], (c) => c.key)
            .sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
        res.json({ classes });
    });

    // ------------------------------------------------------------ students --
    /**
     * Create or update a student and upsert the parent contact with the tags
     * audiences resolve by. A parent with two children is one contact with
     * both class tags.
     */
    const saveStudent = async (input, existing = null) => {
        const merged = { ...(existing ? toStudent(existing) : {}), ...input };
        const name = String(merged.name ?? '').trim();
        const rollNumber = String(merged.rollNumber ?? '').trim();
        const className = String(merged.className ?? '').trim();
        const section = String(merged.section ?? '').trim();
        if (!name) throw new SchoolError('student name is required');
        if (!rollNumber) throw new SchoolError('roll number is required');
        if (!className) throw new SchoolError('class is required');
        const digits = String(merged.parentPhone ?? '').replace(/\D/g, '');
        if (digits.length < 10) throw new SchoolError(`invalid parent phone: ${merged.parentPhone ?? ''}`);
        let phone;
        try {
            phone = state.contacts.normalize(merged.parentPhone);
        } catch (err) {
            throw new SchoolError(`invalid parent phone: ${err.message}`);
        }
        const key = classKeyOf({ className, section });
        const clash = students(state).find((o) => o.id !== existing?.id
            && classKeyOf(o.data) === key && String(o.data.rollNumber) === rollNumber);
        if (clash) throw new SchoolError(`roll number ${rollNumber} already exists in class ${key}`, 409);

        const busRoute = String(merged.busRoute ?? '').trim();
        const hostel = typeof merged.hostel === 'boolean' ? merged.hostel : yes(merged.hostel);
        const tags = ['student', 'school', classTag(key)];
        if (busRoute) tags.push(routeTag(busRoute));
        if (hostel) tags.push('hostel');
        const fatherName = String(merged.fatherName ?? '').trim();
        const motherName = String(merged.motherName ?? '').trim();
        const contact = state.contacts.upsert({
            phone,
            normalized: true,
            name: fatherName || motherName || undefined,
            tags,
            customFields: { studentName: name, rollNumber, classKey: key },
            source: 'school',
        });
        const data = { name, rollNumber, className, section, fatherName, motherName, parentPhone: contact.phone, busRoute, hostel };
        if (existing) {
            return objects().update(existing.id, {
                data, contactId: contact.id, ...(merged.status ? { status: merged.status } : {}),
            }, { source: 'school' });
        }
        return objects().create('student', { contactId: contact.id, status: merged.status || 'active', data, source: 'school' });
    };

    router.get('/school/students', gate('students'), (req, res) => {
        const q = String(req.query.q ?? '').trim().toLowerCase();
        const wanted = req.query.class ? normKey(req.query.class) : null;
        if (wanted) requireClass(req, wanted);
        const list = visible(req, students(state).map(toStudent), (s) => s.classKey)
            .filter((s) => !wanted || s.classKey === wanted)
            .filter((s) => !q || [s.name, s.rollNumber, s.parentPhone, s.fatherName, s.motherName]
                .some((v) => String(v).toLowerCase().includes(q)));
        res.json({ students: list });
    });

    router.post('/school/students', gate('students', { write: true }), async (req, res) => {
        const student = await saveStudent(req.body ?? {});
        res.status(201).json({ student: toStudent(student) });
    });

    router.put('/school/students/:id', gate('students', { write: true }), async (req, res) => {
        const student = await saveStudent(req.body ?? {}, requireStudent(req.params.id));
        res.json({ student: toStudent(student) });
    });

    router.delete('/school/students/:id', gate('students', { write: true }), (req, res) => {
        const student = requireStudent(req.params.id);
        objects().remove(student.id);
        res.json({ deleted: student.id });
    });

    router.post('/school/students/import', gate('students', { write: true }), upload.single('file'), checkImport, async (req, res) => {
        if (!req.file) throw new SchoolError('no file uploaded');
        const result = { imported: 0, updated: 0, errors: [] };
        const index = new Map(students(state).map((o) => [`${classKeyOf(o.data)}|${o.data.rollNumber}`, o]));
        for (const r of await readSheet(req.file)) {
            const input = {
                rollNumber: r.roll_no || r.roll_number || r.roll, name: r.student_name || r.name,
                className: r.class, section: r.section, fatherName: r.father_name, motherName: r.mother_name,
                parentPhone: r.parent_phone || r.phone || r.mobile, busRoute: r.bus_route, hostel: yes(r.hostel),
            };
            const existing = index.get(`${classKeyOf(input)}|${String(input.rollNumber ?? '').trim()}`) ?? null;
            try {
                const saved = await saveStudent(input, existing);
                index.set(`${classKeyOf(saved.data)}|${saved.data.rollNumber}`, saved);
                result[existing ? 'updated' : 'imported'] += 1;
            } catch (err) {
                if (!(err instanceof SchoolError) && !err.status) throw err;
                result.errors.push({ row: r.row, error: err.message });
            }
        }
        res.json(result);
    });

    // ---------------------------------------------------------- attendance --
    const sheet = (date, key) => {
        const rows = students(state).filter((o) => classKeyOf(o.data) === key).map((s) => {
            const mark = objects().getByReference('attendance', `att-${s.id}-${date}`);
            return {
                studentId: s.id, rollNumber: s.data.rollNumber ?? '', name: s.data.name,
                status: mark?.status ?? null, arrivedAt: mark?.data.arrivedAt ?? null, alertedAt: mark?.data.alertedAt ?? null,
            };
        });
        return { date, classKey: key, rows };
    };

    /** Upsert one mark. The reference is the idempotency: re-marking a day updates it. */
    const mark = async (student, date, status, arrivedAt, markedBy) => {
        if (!STATUSES.includes(status)) throw new SchoolError(`status must be one of ${STATUSES.join(', ')}`);
        const reference = `att-${student.id}-${date}`;
        const data = {
            studentId: student.id, rollNumber: student.data.rollNumber, studentName: student.data.name,
            className: student.data.className, section: student.data.section, date: dayStart(date),
            arrivedAt: arrivedAt || null, markedBy,
        };
        const existing = objects().getByReference('attendance', reference);
        if (existing) return { object: await objects().update(existing.id, { status, data, contactId: student.contactId }, { source: 'school' }), created: false };
        return {
            object: await objects().create('attendance', { reference, status, contactId: student.contactId, data, source: 'school' }),
            created: true,
        };
    };

    router.get('/school/attendance', gate('attendance'), (req, res) => {
        const key = normKey(req.query.class);
        if (!key) throw new SchoolError('class is required');
        requireClass(req, key);
        const date = isDate(req.query.date) ? req.query.date : today(state).date;
        res.json(sheet(date, key));
    });

    router.put('/school/attendance', gate('attendance', { write: true }), async (req, res) => {
        const { date, classKey, marks = [] } = req.body ?? {};
        if (!isDate(date)) throw new SchoolError('date must be YYYY-MM-DD');
        const key = normKey(classKey);
        if (!key) throw new SchoolError('classKey is required');
        requireClass(req, key);
        if (!Array.isArray(marks)) throw new SchoolError('marks must be an array');
        for (const m of marks) {
            const student = requireStudent(m?.studentId);
            if (classKeyOf(student.data) !== key) throw new SchoolError(`student ${student.id} is not in class ${key}`);
            await mark(student, date, m.status, m.arrivedAt, req.user?.email ?? '');
        }
        res.json(sheet(date, key));
    });

    router.post('/school/attendance/import', gate('attendance', { write: true }), upload.single('file'), checkImport, async (req, res) => {
        if (!req.file) throw new SchoolError('no file uploaded');
        const date = req.body?.date;
        if (!isDate(date)) throw new SchoolError('date must be YYYY-MM-DD');
        const codes = { p: 'present', a: 'absent', l: 'late', e: 'excused' };
        const index = new Map(students(state).map((o) => [`${classKeyOf(o.data)}|${o.data.rollNumber}`, o]));
        const result = { imported: 0, updated: 0, errors: [] };
        for (const r of await readSheet(req.file)) {
            const key = normKey(r.class_key || `${r.class ?? ''}${r.section ?? ''}`);
            const student = index.get(`${key}|${r.roll_no || r.roll_number || r.roll}`);
            const raw = String(r.status ?? '').trim().toLowerCase();
            const status = codes[raw] ?? raw;
            try {
                if (!student) throw new SchoolError(`no student with roll ${r.roll_no || r.roll_number || r.roll || '?'} in class ${key || '?'}`);
                if (!inClasses(req.school, key)) throw new SchoolError(`You do not have access to class ${key}.`);
                const { created } = await mark(student, date, status, r.arrived_at || r.arrival || null, req.user?.email ?? '');
                result[created ? 'imported' : 'updated'] += 1;
            } catch (err) {
                if (!(err instanceof SchoolError)) throw err;
                result.errors.push({ row: r.row, error: err.message });
            }
        }
        res.json(result);
    });

    router.post('/school/attendance/notify', gate('attendance', { write: true }), async (req, res) => {
        const { date, classKey = null, kinds = ['absent'] } = req.body ?? {};
        if (!isDate(date)) throw new SchoolError('date must be YYYY-MM-DD');
        if (!Array.isArray(kinds) || !kinds.length || kinds.some((k) => !['absent', 'late'].includes(k))) {
            throw new SchoolError('kinds must be a list of absent/late');
        }
        if (classKey) requireClass(req, classKey);
        else if (req.school.classes.length) {
            // A class teacher's "notify all" means all of their classes.
            const result = tally();
            for (const key of req.school.classes) {
                const part = await notifyAttendance(state, { date, classKey: key, kinds });
                for (const k of Object.keys(result)) result[k] += part[k];
            }
            return res.json(result);
        }
        return res.json(await notifyAttendance(state, { date, classKey, kinds }));
    });

    router.get('/school/attendance/student/:id', gate('attendance'), (req, res) => {
        const student = requireStudent(req.params.id);
        requireClass(req, classKeyOf(student.data));
        const month = /^\d{4}-\d{2}$/.test(String(req.query.month ?? '')) ? req.query.month : today(state).month;
        res.json({ student: toStudent(student), month, ...monthReport(state, student.id, month) });
    });

    // ----------------------------------------------------------- timetable --
    const dayRank = (d) => DAYS.indexOf(d);
    const classEntries = (key) => listAll(objects(), { type: 'timetable' })
        .filter((o) => classKeyOf(o.data) === key)
        .sort((a, b) => dayRank(a.data.day) - dayRank(b.data.day)
            || String(a.data.startTime ?? '').localeCompare(String(b.data.startTime ?? ''))
            || String(a.data.period ?? '').localeCompare(String(b.data.period ?? ''), undefined, { numeric: true }));

    router.get('/school/timetable', gate('timetable'), (req, res) => {
        const key = normKey(req.query.class);
        if (!key) throw new SchoolError('class is required');
        requireClass(req, key);
        res.json({ classKey: key, entries: classEntries(key).map(toEntry) });
    });

    router.put('/school/timetable', gate('timetable', { write: true }), async (req, res) => {
        const { classKey, entries = [] } = req.body ?? {};
        const key = normKey(classKey);
        if (!key) throw new SchoolError('classKey is required');
        requireClass(req, key);
        if (!Array.isArray(entries)) throw new SchoolError('entries must be an array');
        const seen = new Set();
        for (const e of entries) {
            if (!DAYS.includes(e?.day)) throw new SchoolError(`day must be one of ${DAYS.join(', ')}`);
            if (!String(e.subject ?? '').trim()) throw new SchoolError('every entry needs a subject');
            const id = `${e.day}-${String(e.period ?? '').trim()}`;
            if (seen.has(id)) throw new SchoolError(`duplicate period ${e.period} on ${e.day}`);
            seen.add(id);
        }
        // Replace, not merge: the editor sends the whole week.
        for (const o of classEntries(key)) objects().remove(o.id);
        const parts = classParts(key);
        for (const e of entries) {
            await objects().create('timetable', {
                reference: `tt-${key}-${e.day}-${String(e.period ?? '').trim()}`.toLowerCase(),
                status: ['scheduled', 'changed', 'cancelled'].includes(e.status) ? e.status : 'scheduled',
                data: {
                    ...parts, day: e.day, period: String(e.period ?? '').trim(), startTime: e.startTime, endTime: e.endTime,
                    subject: String(e.subject).trim(), teacher: e.teacher, room: e.room,
                },
                source: 'school',
            });
        }
        res.json({ classKey: key, entries: classEntries(key).map(toEntry) });
    });

    router.post('/school/timetable/change', gate('timetable', { write: true }), async (req, res) => {
        const { classKey, day, period, status, note = '', notify = false } = req.body ?? {};
        const key = normKey(classKey);
        requireClass(req, key);
        if (!['changed', 'cancelled'].includes(status)) throw new SchoolError('status must be changed or cancelled');
        const entry = classEntries(key).find((o) => o.data.day === day && String(o.data.period) === String(period));
        if (!entry) throw new SchoolError('timetable entry not found', 404);
        const updated = await objects().update(entry.id, { status, data: { notes: String(note ?? '') } }, { source: 'school' });
        const result = tally();
        if (notify) {
            const text = render(state, 'school_timetable_change', { classKey: key, day, period, status, note });
            for (const contact of audienceContacts(state, { classKeys: [key] })) {
                count(result, deliver(state, {
                    recipient: contact.phone, text, messageType: 'reminder',
                    key: `school.tt.${entry.id}.${hash(status, note, updated.updatedAt)}.${contact.id}`,
                }));
            }
        }
        res.json({ ...result, entry: toEntry(updated) });
    });

    // ------------------------------------------------------------ homework --
    router.get('/school/homework', gate('homework'), (req, res) => {
        const wanted = req.query.class ? normKey(req.query.class) : null;
        if (wanted) requireClass(req, wanted);
        const list = visible(req, listAll(objects(), { type: 'homework' }).map(toHomework), (h) => h.classKey)
            .filter((h) => !wanted || h.classKey === wanted);
        res.json({ homework: list });
    });

    router.post('/school/homework', gate('homework', { write: true }), async (req, res) => {
        const body = req.body ?? {};
        const key = normKey(body.classKey);
        if (!key) throw new SchoolError('classKey is required');
        requireClass(req, key);
        for (const field of ['subject', 'title']) {
            if (!String(body[field] ?? '').trim()) throw new SchoolError(`${field} is required`);
        }
        if (body.mediaId && !state.media?.get(body.mediaId)) throw new SchoolError('media not found', 404);
        // Omitted sendAt means "at the school's homework time today" (now, if
        // that has passed); an explicit null means now.
        let sendAt = body.sendAt ?? null;
        if (body.sendAt === undefined) {
            const now = today(state);
            const at = zonedToUtc(now.date, getSettings(db.db, db.tenantId).homeworkSendTime, state.channel?.timezone);
            sendAt = at > new Date() ? at.toISOString() : null;
        }
        if (sendAt && Number.isNaN(Date.parse(sendAt))) throw new SchoolError('sendAt must be a date-time');
        const scheduled = sendAt && Date.parse(sendAt) > Date.now();
        let hw = await objects().create('homework', {
            status: 'assigned',
            data: {
                ...classParts(key), subject: String(body.subject).trim(), title: String(body.title).trim(),
                instructions: String(body.instructions ?? ''), assignedAt: new Date().toISOString(), dueAt: body.dueAt || null,
                teacher: req.user?.name || req.user?.email || '', mediaId: body.mediaId || null,
            },
            metadata: { classKey: key, sendAt: scheduled ? new Date(sendAt).toISOString() : null, sentAt: null },
            source: 'school',
        });
        if (!scheduled) {
            await sendHomework(state, hw);
            hw = objects().get(hw.id);
        }
        res.status(201).json({ homework: toHomework(hw) });
    });

    router.delete('/school/homework/:id', gate('homework', { write: true }), (req, res) => {
        const hw = requireObject('homework', req.params.id);
        requireClass(req, toHomework(hw).classKey);
        objects().remove(hw.id);
        res.json({ deleted: hw.id });
    });

    // ------------------------------------------------------------- notices --
    router.get('/school/notices', gate('notices'), (req, res) => {
        const kind = req.query.kind || null;
        const list = listAll(objects(), { type: 'notice', ...(kind ? { filter: { kind } } : {}) }).map(toNotice);
        res.json({ notices: list });
    });

    router.post('/school/notices', gate('notices', { write: true }), async (req, res) => {
        const body = req.body ?? {};
        if (!NOTICE_KINDS.includes(body.kind)) throw new SchoolError(`kind must be one of ${NOTICE_KINDS.join(', ')}`);
        if (!String(body.title ?? '').trim()) throw new SchoolError('title is required');
        const audience = body.audience ?? { all: true };
        if (!validAudience(audience)) throw new SchoolError('audience must be {all:true}, {classKeys:[...]} or {routes:[...]}');
        if (body.mediaId && !state.media?.get(body.mediaId)) throw new SchoolError('media not found', 404);
        if (body.sendAt && Number.isNaN(Date.parse(body.sendAt))) throw new SchoolError('sendAt must be a date-time');
        const scheduled = Boolean(body.broadcast && body.sendAt && Date.parse(body.sendAt) > Date.now());
        let notice = await objects().create('notice', {
            status: 'published',
            data: {
                kind: body.kind, title: String(body.title).trim(), body: String(body.body ?? ''), startsAt: body.startsAt || null,
                endsAt: body.endsAt || null, audience: JSON.stringify(audience), mediaId: body.mediaId || null,
            },
            metadata: { sendAt: scheduled ? new Date(body.sendAt).toISOString() : null },
            source: 'school',
        });
        if (body.broadcast && !scheduled) {
            const result = await sendNotice(state, notice);
            notice = objects().get(notice.id);
            return res.status(201).json({ notice: toNotice(notice), ...result });
        }
        return res.status(201).json({ notice: toNotice(notice) });
    });

    router.delete('/school/notices/:id', gate('notices', { write: true }), (req, res) => {
        const notice = requireObject('notice', req.params.id);
        objects().remove(notice.id);
        res.json({ deleted: notice.id });
    });

    // ----------------------------------------------------------- broadcast --
    router.post('/school/broadcast', gate('broadcast', { write: true }), (req, res) => {
        const { kind, message, audience, mediaId = null } = req.body ?? {};
        if (!BROADCAST_KINDS.includes(kind)) throw new SchoolError(`kind must be one of ${BROADCAST_KINDS.join(', ')}`);
        if (!String(message ?? '').trim()) throw new SchoolError('message is required');
        if (!validAudience(audience)) throw new SchoolError('audience must be {all:true}, {classKeys:[...]} or {routes:[...]}');
        const media = mediaId ? state.media?.get(mediaId) : null;
        if (mediaId && !media) throw new SchoolError('media not found', 404);
        const text = render(state, 'school_broadcast', { schoolName: getSettings(db.db, db.tenantId).schoolName, message });
        // Same message, same audience, same day = the same broadcast: a second
        // click is a duplicate, not a second alarm to every parent.
        const batch = hash(kind, message, JSON.stringify(audience), mediaId ?? '', today(state).date);
        const result = tally();
        for (const contact of audienceContacts(state, audience)) {
            count(result, deliver(state, {
                recipient: contact.phone, text, media, key: `school.bc.${batch}.${contact.id}`,
                messageType: kind === 'emergency' ? 'transactional' : 'reminder', urgent: kind === 'emergency',
            }));
        }
        res.json(result);
    });

    // ---------------------------------------------------------------- fees --
    const createFee = async (student, { term, amount, dueAt, payLink }) => {
        const conf = settings();
        return objects().create('fee', {
            reference: `fee-${student.id}-${String(term).trim().toLowerCase().replace(/\s+/g, '-')}`,
            contactId: student.contactId,
            status: 'pending',
            data: {
                studentId: student.id, studentName: student.data.name, className: student.data.className,
                section: student.data.section, term: String(term).trim(), amount, currency: conf.currency, dueAt, payLink: payLink || null,
            },
            source: 'school',
        });
    };
    const checkFee = ({ term, amount, dueAt }) => {
        if (!String(term ?? '').trim()) throw new SchoolError('term is required');
        if (!(Number(amount) > 0)) throw new SchoolError('amount must be a positive number');
        if (Number.isNaN(Date.parse(dueAt ?? ''))) throw new SchoolError('dueAt must be a date');
    };

    router.get('/school/fees', gate('fees'), (req, res) => {
        const conf = settings();
        const date = today(state).date;
        const wanted = req.query.class ? normKey(req.query.class) : null;
        const scoped = listAll(objects(), { type: 'fee' }).map((o) => toFee(o, conf, date))
            .filter((f) => (!wanted || f.classKey === wanted) && (!req.query.term || f.term === req.query.term));
        const sum = (status) => scoped.filter((f) => f.status === status).reduce((n, f) => n + Number(f.amount), 0);
        res.json({
            fees: scoped.filter((f) => !req.query.status || f.status === req.query.status),
            totals: { collected: sum('paid'), pending: sum('pending'), overdue: sum('overdue'), currency: conf.currency },
        });
    });

    router.post('/school/fees', gate('fees', { write: true }), async (req, res) => {
        const body = req.body ?? {};
        checkFee(body);
        const fee = await createFee(requireStudent(body.studentId), body);
        res.status(201).json({ fee: toFee(fee, settings(), today(state).date) });
    });

    router.post('/school/fees/bulk', gate('fees', { write: true }), async (req, res) => {
        const body = req.body ?? {};
        checkFee(body);
        const key = normKey(body.classKey);
        if (!key) throw new SchoolError('classKey is required');
        let created = 0;
        for (const student of students(state).filter((o) => classKeyOf(o.data) === key)) {
            const ref = `fee-${student.id}-${String(body.term).trim().toLowerCase().replace(/\s+/g, '-')}`;
            if (objects().getByReference('fee', ref)) continue; // re-running a bulk create adds only the new students
            await createFee(student, body);
            created += 1;
        }
        res.json({ created });
    });

    router.put('/school/fees/:id/paid', gate('fees', { write: true }), async (req, res) => {
        const fee = requireObject('fee', req.params.id);
        const method = String(req.body?.method ?? '').trim();
        if (!method) throw new SchoolError('method is required');
        const paidAt = req.body?.paidAt ? new Date(req.body.paidAt) : new Date();
        if (Number.isNaN(paidAt.getTime())) throw new SchoolError('paidAt must be a date-time');
        const receiptNo = fee.data.receiptNo
            ?? `RCPT-${paidAt.toISOString().slice(0, 7).replace('-', '')}-${fee.id}`;
        const paid = await objects().update(fee.id, {
            status: 'paid', data: { paidAt: paidAt.toISOString(), method, receiptNo },
        }, { source: 'school' });
        const conf = settings();
        const contact = paid.contactId ? state.contacts.get(paid.contactId) : null;
        const outcome = deliver(state, {
            recipient: contact?.phone,
            key: `school.receipt.${paid.id}`,
            text: render(state, 'school_fee_receipt', {
                receiptNo, currency: paid.data.currency || conf.currency, amount: paid.data.amount,
                studentName: paid.data.studentName, term: paid.data.term, paidAt: paidAt.toISOString().slice(0, 10), method,
            }),
        });
        res.json({ fee: toFee(paid, conf, today(state).date), receiptSent: outcome === 'sent' });
    });

    router.post('/school/fees/remind', gate('fees', { write: true }), (req, res) => {
        const { ids = null, status = null } = req.body ?? {};
        const conf = settings();
        const date = today(state).date;
        const wanted = Array.isArray(ids) && ids.length ? new Set(ids.map(Number)) : null;
        const result = tally();
        for (const o of listAll(objects(), { type: 'fee' })) {
            const current = feeStatus(o, date);
            if (!['pending', 'overdue'].includes(current)) continue;
            if (wanted ? !wanted.has(o.id) : (status && current !== status)) continue;
            const contact = o.contactId ? state.contacts.get(o.contactId) : null;
            count(result, deliver(state, {
                recipient: contact?.phone,
                messageType: 'reminder',
                // One reminder per fee per day, however often the button is pressed.
                key: `school.fee.${current}.${o.id}.${date}`,
                text: render(state, current === 'overdue' ? 'school_fee_overdue' : 'school_fee_due', {
                    term: o.data.term, currency: o.data.currency || conf.currency, amount: o.data.amount,
                    studentName: o.data.studentName, dueAt: dateOnly(o.data.dueAt), payLink: payLinkFor(o, conf) ?? '',
                }),
            }));
        }
        res.json(result);
    });

    // ------------------------------------------------------------- results --
    router.get('/school/results', gate('results'), (req, res) => {
        const all = visible(req, listAll(objects(), { type: 'exam_result' }).map(toResult), (r) => r.classKey);
        const wanted = req.query.class ? normKey(req.query.class) : null;
        res.json({
            results: all.filter((r) => (!req.query.exam || r.examName === req.query.exam) && (!wanted || r.classKey === wanted))
                .sort((a, b) => String(a.rollNumber).localeCompare(String(b.rollNumber), undefined, { numeric: true })),
            exams: [...new Set(all.map((r) => r.examName))].sort(),
        });
    });

    router.post('/school/results/import', gate('results', { write: true }), upload.single('file'), checkImport, async (req, res) => {
        if (!req.file) throw new SchoolError('no file uploaded');
        const examName = String(req.body?.examName ?? '').trim();
        const key = normKey(req.body?.classKey);
        if (!examName) throw new SchoolError('examName is required');
        if (!key) throw new SchoolError('classKey is required');
        requireClass(req, key);
        const known = new Set(['roll_no', 'roll_number', 'roll', 'name', 'student_name', 'student', 'total', 'grade',
            'class', 'section', 'remarks']);
        const index = new Map(students(state).filter((o) => classKeyOf(o.data) === key).map((o) => [String(o.data.rollNumber), o]));
        const result = { imported: 0, updated: 0, errors: [] };
        for (const r of await readSheet(req.file)) {
            const roll = r.roll_no || r.roll_number || r.roll;
            const student = index.get(String(roll));
            if (!student) { result.errors.push({ row: r.row, error: `no student with roll ${roll || '?'} in class ${key}` }); continue; }
            // Subjects keep the sheet's own header text ("Maths"), not the snake_case key.
            const breakdown = [];
            let bad = null;
            for (const [header, cell] of Object.entries(r.raw)) {
                if (known.has(normalizeHeader(header)) || String(cell ?? '').trim() === '') continue;
                const parsed = parseMarks(cell);
                if (!parsed) { bad = `"${cell}" is not marks for ${header}`; break; }
                breakdown.push({ subject: String(header).trim(), ...parsed });
            }
            if (bad) { result.errors.push({ row: r.row, error: bad }); continue; }
            const totalCell = parseMarks(r.total);
            const marks = totalCell?.marks ?? breakdown.reduce((n, b) => n + b.marks, 0);
            const totalMarks = (totalCell && /\//.test(r.total) ? totalCell.total : null) ?? breakdown.reduce((n, b) => n + b.total, 0);
            const grade = r.grade || (totalMarks ? gradeFor((marks / totalMarks) * 100) : '');
            const reference = `res-${student.id}-${examName.toLowerCase().replace(/\s+/g, '-')}`;
            const data = {
                studentId: student.id, rollNumber: student.data.rollNumber, studentName: student.data.name,
                className: student.data.className, section: student.data.section, examName, marks, totalMarks, grade,
                breakdown: JSON.stringify(breakdown), publishedAt: new Date().toISOString(),
            };
            const existing = objects().getByReference('exam_result', reference);
            if (existing) {
                await objects().update(existing.id, { data, contactId: student.contactId }, { source: 'school' });
                result.updated += 1;
            } else {
                await objects().create('exam_result', { reference, status: 'published', contactId: student.contactId, data, source: 'school' });
                result.imported += 1;
            }
        }
        res.json(result);
    });

    router.post('/school/results/dispatch', gate('results', { write: true }), async (req, res) => {
        const examName = String(req.body?.examName ?? '').trim();
        if (!examName) throw new SchoolError('examName is required');
        const key = req.body?.classKey ? normKey(req.body.classKey) : null;
        if (key) requireClass(req, key);
        const result = tally();
        for (const o of listAll(objects(), { type: 'exam_result', filter: { examName } })) {
            const dto = toResult(o);
            if ((key && dto.classKey !== key) || !inClasses(req.school, dto.classKey)) continue;
            if (dto.dispatchedAt) { result.skipped += 1; continue; }
            const contact = o.contactId ? state.contacts.get(o.contactId) : null;
            const outcome = deliver(state, {
                recipient: contact?.phone,
                key: `school.result.${o.id}`,
                text: render(state, 'school_result', {
                    examName, studentName: dto.studentName, classKey: dto.classKey, marks: dto.marks, totalMarks: dto.totalMarks,
                    grade: dto.grade, breakdown: dto.breakdown.map((b) => `${b.subject}: ${b.marks}/${b.total}`).join('\n'),
                }),
            });
            count(result, outcome);
            if (outcome === 'sent' || outcome === 'duplicate') {
                await objects().update(o.id, { data: { dispatchedAt: new Date().toISOString() } }, { source: 'school' });
            }
        }
        res.json(result);
    });

    // --------------------------------------------------------------- leave --
    router.get('/school/leave', gate('leave'), (req, res) => {
        const requests = visible(req, state.tickets.list({ limit: 1000 }).filter(isLeave).map(toLeave), (l) => l.classKey)
            .filter((l) => !req.query.status || l.status === req.query.status);
        res.json({ requests });
    });

    router.post('/school/leave/:ticketId/decision', gate('leave', { write: true }), (req, res) => {
        const ticket = state.tickets.get(req.params.ticketId);
        if (!ticket || !isLeave(ticket)) throw new SchoolError('leave request not found', 404);
        requireClass(req, ticket.metadata.classKey ?? '');
        const { decision, note = '' } = req.body ?? {};
        if (!['approve', 'reject'].includes(decision)) throw new SchoolError('decision must be approve or reject');
        if (ticket.metadata.decision) throw new SchoolError(`this request was already ${ticket.metadata.decision}`, 409);
        const status = decision === 'approve' ? 'approved' : 'rejected';
        const userId = req.user?.id ?? null;
        state.tickets.update(ticket.id, {
            metadata: { ...ticket.metadata, decision: status, decidedBy: userId, note },
        }, { userId });
        state.tickets.addNote(ticket.id, `Leave ${status}${note ? `: ${note}` : ''}`, { userId });
        const resolved = state.tickets.resolve(ticket.id, { userId });
        const m = resolved.metadata;
        const contact = resolved.contactId ? state.contacts.get(resolved.contactId) : null;
        const outcome = deliver(state, {
            recipient: contact?.phone ?? m.parentPhone,
            key: `school.leave.${ticket.id}`,
            text: render(state, status === 'approved' ? 'school_leave_approved' : 'school_leave_rejected', {
                studentName: m.studentName, fromDate: m.fromDate ?? '-', toDate: m.toDate ?? m.fromDate ?? '-', note,
            }),
        });
        res.json({ request: toLeave(resolved), notified: outcome === 'sent' });
    });

    // ----------------------------------------------------------------- PTM --
    router.get('/school/ptm/slots', gate('ptm'), (req, res) => {
        const slots = visible(req, listAll(objects(), { type: 'appointment', filter: { service: 'PTM' } })
            .filter(isPtm).map(toSlot), (s) => s.classKey)
            .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        res.json({ slots });
    });

    router.post('/school/ptm/slots', gate('ptm', { write: true }), async (req, res) => {
        const { startsAt, durationMinutes = 10, teacher = '', classKey, count: howMany = 1 } = req.body ?? {};
        const key = normKey(classKey);
        if (!key) throw new SchoolError('classKey is required');
        requireClass(req, key);
        const start = Date.parse(startsAt ?? '');
        if (Number.isNaN(start)) throw new SchoolError('startsAt must be a date-time');
        const minutes = Number(durationMinutes);
        const n = Number(howMany);
        if (!(minutes > 0) || !Number.isInteger(n) || n < 1 || n > 100) {
            throw new SchoolError('durationMinutes must be positive and count between 1 and 100');
        }
        const slots = [];
        for (let i = 0; i < n; i += 1) {
            const at = new Date(start + i * minutes * 60_000).toISOString();
            const slot = await objects().create('appointment', {
                reference: `ptm-${key}-${String(teacher).trim().toLowerCase()}-${at}`,
                data: { service: 'PTM', scheduledAt: at, durationMinutes: minutes, staffId: String(teacher).trim() },
                metadata: { kind: 'ptm_slot', classKey: key },
                source: 'school',
            });
            slots.push(toSlot(slot));
        }
        res.status(201).json({ slots });
    });

    router.delete('/school/ptm/slots/:id', gate('ptm', { write: true }), (req, res) => {
        const slot = requireObject('appointment', req.params.id, 'slot');
        if (!isPtm(slot)) throw new SchoolError('slot not found', 404);
        requireClass(req, slot.metadata.classKey);
        objects().remove(slot.id);
        res.json({ deleted: slot.id });
    });

    // --------------------------------------------------------------- staff --
    const toStaff = (user, conf) => {
        const { title, classes } = profileFor(user, conf);
        return { id: user.id, email: user.email, name: user.name, role: user.role, title, classes };
    };

    router.get('/school/staff', gate('staff'), (req, res) => {
        const conf = settings();
        const users = state.tenancy?.listUsers(db.tenantId) ?? [];
        res.json({ users: users.filter((u) => !u.disabled).map((u) => toStaff(u, conf)) });
    });

    router.put('/school/staff/:userId', gate('staff', { write: true }), (req, res) => {
        const user = state.tenancy?.listUsers(db.tenantId).find((u) => u.id === Number(req.params.userId));
        if (!user) throw new SchoolError('user not found', 404);
        const { title, classes = [] } = req.body ?? {};
        if (!TITLES.includes(title)) throw new SchoolError(`title must be one of ${TITLES.join(', ')}`);
        if (!Array.isArray(classes)) throw new SchoolError('classes must be an array');
        const conf = settings();
        const staff = { ...conf.staff, [user.id]: { title, classes: [...new Set(classes.map(normKey).filter(Boolean))] } };
        res.json({ user: toStaff(user, saveSettings(db.db, db.tenantId, { staff })) });
    });

    // One place turns domain errors into `{errors}`; anything else is a 500.
    router.use((err, req, res, next) => {
        const status = err?.name === 'MulterError' ? 400 : err?.status;
        // 4xx from any store (object, ticket, contact) is the caller's mistake;
        // a 502 carrying an object means "saved, but the workflow did not start".
        if (status && (status < 500 || err.object)) return res.status(status).json({ errors: [err.message] });
        return next(err);
    });

    return router;
}

// ----------------------------------------------------------------- sweep --

/**
 * The school's clock, run from the app's sweep for each tenant with the
 * school service. Every step is idempotent: the bookkeeping keys in settings
 * and the message idempotency keys mean a sweep every few seconds sends
 * each alert once.
 */
export async function schoolSweep(state, at = new Date()) {
    const { db } = state;
    const now = localNow(state.channel?.timezone, at);
    let conf = getSettings(db.db, db.tenantId);

    // Fees: a pending fee past its due date becomes overdue (the `fee.status_changed` event is what recipes hook).
    for (const fee of listAll(state.objects, { type: 'fee', status: 'pending' })) {
        if (dateOnly(fee.data.dueAt) < now.date) await state.objects.update(fee.id, { status: 'overdue' }, { source: 'scheduler' });
    }

    // Scheduled homework and notices whose time has come.
    for (const hw of listAll(state.objects, { type: 'homework' })) {
        if (hw.metadata.sendAt && !hw.metadata.sentAt && Date.parse(hw.metadata.sendAt) <= at.getTime()) await sendHomework(state, hw);
    }
    for (const notice of listAll(state.objects, { type: 'notice' })) {
        if (notice.metadata.sendAt && !notice.data.sentAt && Date.parse(notice.metadata.sendAt) <= at.getTime()) {
            await sendNotice(state, notice);
        }
    }

    // Daily absent alerts, once, at or after the configured time.
    if (conf.absentAlertTime && now.time >= conf.absentAlertTime && conf._absentRun !== now.date) {
        conf = saveSettings(db.db, db.tenantId, { _absentRun: now.date });
        await notifyAttendance(state, { date: now.date, kinds: ['absent'] });
    }

    // Last month's attendance summary, on the 1st.
    if (conf.monthlySummary && now.date.endsWith('-01')) {
        const [y, m] = now.month.split('-').map(Number);
        const previous = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
        if (conf._summaryMonth !== previous) {
            saveSettings(db.db, db.tenantId, { _summaryMonth: previous });
            for (const student of students(state)) {
                const report = monthReport(state, student.id, previous);
                const contact = student.contactId ? state.contacts.get(student.contactId) : null;
                if (!report.days.length || !contact) continue;
                deliver(state, {
                    recipient: contact.phone, messageType: 'reminder', key: `school.month.${student.id}.${previous}`,
                    text: render(state, 'school_monthly_attendance', {
                        studentName: student.data.name, classKey: classKeyOf(student.data), month: previous,
                        percentage: report.percentage, absentDates: report.absentDates.join(', ') || 'none',
                    }),
                });
            }
        }
    }
}
