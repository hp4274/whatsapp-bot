/**
 * Parent keywords on WhatsApp: ATTENDANCE, TIMETABLE, HOMEWORK, FEES, LEAVE,
 * PTM and friends. Called from `handleInbound` before the FAQ lookup, after
 * opt-out, capability and bot-pause checks have passed.
 *
 * Only a number linked to at least one student is answered. Anyone else - or
 * any word that is not a command - falls through to the FAQ and keyword
 * auto-replies, so a tenant that also sells something keeps its own "FEES"
 * rule for strangers.
 *
 * The recipes that trigger on `message.received` with intent leave_request /
 * timetable_lookup / ptm_slot_booking are superseded by this handler; it does
 * not dispatch to them, so a parent never gets two answers.
 *
 * Every reply's idempotency key is derived from the inbound message id, so a
 * redelivered webhook is answered once.
 */

import {
    DAYS, SERVICE, classKeyOf, deliver, feeStatus, isPtm, listAll, localNow, monthReport,
    normKey, payLinkFor, render, toResult, toSlot,
} from './routes.js';
import { getSettings } from './settings.js';

const COMMANDS = new Set(['ATTENDANCE', 'TIMETABLE', 'HOMEWORK', 'HOLIDAYS', 'CALENDAR', 'EXAMS', 'EXAM',
    'RESULT', 'RESULTS', 'FEES', 'FEE', 'LEAVE', 'PTM', 'SCHOOL']);
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * @returns {Promise<{ handled: boolean }>} handled when a reply was queued
 */
export async function handleSchoolCommand(state, message) {
    const [first = '', ...rest] = String(message.body ?? '').trim().split(/\s+/);
    const word = first.toUpperCase().replace(/[^A-Z]/g, '');
    if (!COMMANDS.has(word)) return { handled: false };
    const tenant = state.tenancy?.getTenant(state.db.tenantId);
    if (!tenant?.services.includes(SERVICE) || !state.objects) return { handled: false };

    const contact = state.contacts.getByPhone(message.sender);
    const children = contact ? listAll(state.objects, { type: 'student', contactId: contact.id }) : [];
    if (!children.length) return { handled: false };
    const settings = getSettings(state.db.db, state.db.tenantId);
    if (!settings.commandsEnabled) return { handled: false };

    const ctx = { state, settings, contact, children, args: rest, message, now: localNow(state.channel?.timezone) };
    const text = await (HANDLERS[word] ?? help)(ctx);
    deliver(state, {
        recipient: message.sender, text, messageType: 'auto_reply', key: `school.cmd.${message.messageId}`,
    });
    state.db.markInboundReplied?.(message.messageId, `school:${word.toLowerCase()}`);
    return { handled: true };
}

const HANDLERS = {
    ATTENDANCE: attendance,
    TIMETABLE: timetable,
    HOMEWORK: homework,
    HOLIDAYS: (ctx) => calendar(ctx, ['holiday', 'event'], 'Upcoming holidays & events'),
    CALENDAR: (ctx) => calendar(ctx, ['holiday', 'event'], 'Upcoming holidays & events'),
    EXAMS: (ctx) => calendar(ctx, ['exam'], 'Upcoming exams'),
    EXAM: (ctx) => calendar(ctx, ['exam'], 'Upcoming exams'),
    RESULT: result,
    RESULTS: result,
    FEES: fees,
    FEE: fees,
    LEAVE: leave,
    PTM: ptm,
};

function help({ settings }) {
    return [
        `${settings.schoolName || 'School'} - reply with:`,
        'ATTENDANCE - this month\'s attendance',
        'TIMETABLE [day] - today\'s periods',
        'HOMEWORK - current homework',
        'HOLIDAYS / EXAMS - upcoming dates',
        'RESULT - latest exam result',
        'FEES - pending fees and pay link',
        'LEAVE <reason, dates> - apply for leave',
        'PTM - book a parent-teacher meeting',
    ].join('\n');
}

// ------------------------------------------------------------- helpers --

const name = (s) => s.data.name;
const classes = (children) => [...new Set(children.map((s) => classKeyOf(s.data)))];
const dateOnly = (value) => (value ? String(value).slice(0, 10) : '');

/** A roll number as the first argument narrows to that child; otherwise all of them. */
function pickChildren(children, args) {
    const roll = String(args[0] ?? '').toLowerCase();
    const match = children.filter((s) => String(s.data.rollNumber ?? '').toLowerCase() === roll);
    return match.length ? { kids: match, rest: args.slice(1) } : { kids: children, rest: args };
}

function when(iso, timeZone) {
    try {
        return new Intl.DateTimeFormat('en-IN', {
            timeZone: timeZone || 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(new Date(iso));
    } catch {
        return iso;
    }
}

/** Does a notice's audience include this family? */
function forFamily(notice, children) {
    let audience;
    try {
        audience = JSON.parse(notice.data.audience ?? '{"all":true}');
    } catch {
        return true;
    }
    if (audience.all) return true;
    if (audience.classKeys) return audience.classKeys.map(normKey).some((k) => classes(children).includes(k));
    if (audience.routes) {
        const routes = audience.routes.map((r) => String(r).trim().toLowerCase());
        return children.some((s) => routes.includes(String(s.data.busRoute ?? '').trim().toLowerCase()));
    }
    return true;
}

/**
 * Loose date pick-up for leave text: "10/10 - 12/10", "10-10-2026",
 * "Oct 10 to Oct 12", "10th Oct", "today", "tomorrow". Numbers are day-first.
 * Returns ISO dates in the order they appear.
 */
export function parseDates(text, todayDate) {
    const year = Number(todayDate.slice(0, 4));
    const mon = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?';
    const pattern = new RegExp([
        '\\b(\\d{1,2})([/.-])(\\d{1,2})(?:\\2(\\d{4}|\\d{2})(?!\\d))?',
        `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}(?:\\s+(\\d{4}))?`,
        `\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`,
        '\\b(today|tomorrow)\\b',
    ].join('|'), 'gi');
    const out = [];
    for (const m of String(text).matchAll(pattern)) {
        let d;
        let mo;
        let y;
        if (m[1]) [d, mo, y] = [m[1], m[3], m[4]];
        else if (m[5]) [d, mo, y] = [m[5], MONTHS.indexOf(m[6].toLowerCase()) + 1, m[7]];
        else if (m[8]) [d, mo, y] = [m[9], MONTHS.indexOf(m[8].toLowerCase()) + 1, m[10]];
        else {
            const base = Date.parse(`${todayDate}T00:00:00Z`) + (m[11].toLowerCase() === 'tomorrow' ? 86_400_000 : 0);
            out.push(new Date(base).toISOString().slice(0, 10));
            continue;
        }
        y = y ? Number(y.length === 2 ? `20${y}` : y) : year;
        const date = new Date(Date.UTC(y, Number(mo) - 1, Number(d)));
        // Date.UTC rolls 31/02 into March; a date that does not round-trip is not a date.
        if (date.getUTCDate() === Number(d) && date.getUTCMonth() === Number(mo) - 1) out.push(date.toISOString().slice(0, 10));
    }
    return out;
}

// ------------------------------------------------------------ commands --

function attendance({ state, children, args, now }) {
    const { kids } = pickChildren(children, args);
    return kids.map((s) => {
        const r = monthReport(state, s.id, now.month);
        if (!r.days.length) return `${name(s)} (${classKeyOf(s.data)}): no attendance marked yet in ${now.month}.`;
        return `${name(s)} (${classKeyOf(s.data)}), ${now.month}: ${r.percentage}% present over ${r.days.length} days.`
            + ` Absent: ${r.absentDates.join(', ') || 'none'}.`;
    }).join('\n\n');
}

function timetable({ state, children, args, now }) {
    let day = null;
    let key = null;
    for (const arg of args) {
        const lower = arg.toLowerCase();
        const found = DAYS.find((d) => lower.startsWith(d.toLowerCase()));
        if (found) day = found;
        else if (lower === 'tomorrow') day = DAYS[(DAYS.indexOf(now.day) + 1) % DAYS.length] ?? 'Mon';
        else if (lower !== 'today') key = normKey(arg);
    }
    day ??= DAYS.includes(now.day) ? now.day : 'Mon'; // Sunday asks about Monday
    const keys = key ? [key] : classes(children);
    const entries = listAll(state.objects, { type: 'timetable', filter: { day } });
    return keys.map((k) => {
        const rows = entries.filter((o) => classKeyOf(o.data) === k)
            .sort((a, b) => String(a.data.startTime ?? '').localeCompare(String(b.data.startTime ?? '')));
        if (!rows.length) return `No timetable for ${k} on ${day}.`;
        return [`Timetable ${k} - ${day}:`, ...rows.map((o) => {
            const time = o.data.startTime ? ` ${o.data.startTime}-${o.data.endTime ?? ''}` : '';
            const flag = o.status === 'scheduled' ? '' : ` (${o.status.toUpperCase()}${o.data.notes ? `: ${o.data.notes}` : ''})`;
            return `P${o.data.period ?? ''}${time} ${o.data.subject}${o.data.teacher ? ` - ${o.data.teacher}` : ''}${flag}`;
        })].join('\n');
    }).join('\n\n');
}

function homework({ state, children, now }) {
    const keys = classes(children);
    const rows = listAll(state.objects, { type: 'homework' })
        .filter((o) => keys.includes(o.metadata.classKey ?? classKeyOf(o.data)))
        .filter((o) => !(o.metadata.sendAt && !o.metadata.sentAt)) // not out yet
        .filter((o) => dateOnly(o.data.dueAt) >= now.date || localNow(state.channel?.timezone, new Date(o.createdAt)).date === now.date)
        .slice(0, 10);
    if (!rows.length) return 'No current homework.';
    return ['Homework:', ...rows.map((o) => `${o.metadata.classKey ?? classKeyOf(o.data)} ${o.data.subject}: ${o.data.title}`
        + `${o.data.dueAt ? ` (due ${dateOnly(o.data.dueAt)})` : ''}`)].join('\n');
}

function calendar({ state, children, now }, kinds, title) {
    const rows = listAll(state.objects, { type: 'notice', status: 'published' })
        .filter((o) => kinds.includes(o.data.kind) && o.data.startsAt && forFamily(o, children))
        .filter((o) => dateOnly(o.data.endsAt ?? o.data.startsAt) >= now.date)
        .sort((a, b) => a.data.startsAt.localeCompare(b.data.startsAt))
        .slice(0, 10);
    if (!rows.length) return `${title}: nothing scheduled.`;
    return [`${title}:`, ...rows.map((o) => {
        const end = o.data.endsAt && dateOnly(o.data.endsAt) !== dateOnly(o.data.startsAt) ? ` to ${dateOnly(o.data.endsAt)}` : '';
        return `${dateOnly(o.data.startsAt)}${end}: ${o.data.title}`;
    })].join('\n');
}

function result({ state, children, args }) {
    const { kids } = pickChildren(children, args);
    return kids.map((s) => {
        const latest = listAll(state.objects, { type: 'exam_result', filter: { studentId: s.id } })
            .filter((o) => o.data.dispatchedAt)
            .sort((a, b) => b.data.dispatchedAt.localeCompare(a.data.dispatchedAt))[0];
        if (!latest) return `No published result for ${name(s)} yet.`;
        const r = toResult(latest);
        return render(state, 'school_result', {
            examName: r.examName, studentName: r.studentName, classKey: r.classKey, marks: r.marks, totalMarks: r.totalMarks,
            grade: r.grade, breakdown: r.breakdown.map((b) => `${b.subject}: ${b.marks}/${b.total}`).join('\n'),
        });
    }).join('\n\n');
}

function fees({ state, settings, children, now }) {
    const ids = new Set(children.map((s) => s.id));
    const rows = listAll(state.objects, { type: 'fee' })
        .filter((o) => ids.has(o.data.studentId) && ['pending', 'overdue'].includes(feeStatus(o, now.date)));
    if (!rows.length) return 'No pending fees. Thank you!';
    return rows.map((o) => {
        const overdue = feeStatus(o, now.date) === 'overdue';
        const link = payLinkFor(o, settings);
        return `${o.data.studentName} - ${o.data.term}: ${o.data.currency || settings.currency} ${o.data.amount}`
            + `, due ${dateOnly(o.data.dueAt)}${overdue ? ' (OVERDUE)' : ''}${link ? `\nPay: ${link}` : ''}`;
    }).join('\n\n');
}

function leave({ state, contact, children, args, message, now }) {
    const { kids, rest } = pickChildren(children, args);
    if (kids.length > 1) {
        return `Please include the roll number: LEAVE <roll no> <reason and dates>. Roll numbers: ${
            children.map((s) => `${s.data.rollNumber} (${name(s)})`).join(', ')}`;
    }
    const reason = rest.join(' ').trim();
    if (!reason) return 'Please send: LEAVE <reason and dates>, e.g. LEAVE fever from 10/10 to 12/10';
    const student = kids[0];
    const dates = parseDates(reason, now.date);
    // A redelivered webhook finds the ticket it already opened.
    const ticket = state.tickets.list({ contactId: contact.id, limit: 50 })
        .find((t) => t.metadata.messageId === message.messageId)
        ?? state.tickets.create({
            contactId: contact.id,
            category: 'leave_request',
            source: 'keyword',
            subject: `Leave: ${name(student)} (${classKeyOf(student.data)})`,
            metadata: {
                studentId: student.id, studentName: name(student), classKey: classKeyOf(student.data),
                parentPhone: contact.phone, reason, fromDate: dates[0] ?? null, toDate: dates[1] ?? dates[0] ?? null,
                messageId: message.messageId,
            },
        });
    const span = ticket.metadata.fromDate ? ` (${ticket.metadata.fromDate} to ${ticket.metadata.toDate})` : '';
    return `Leave request ${ticket.reference} received for ${name(student)}${span}. The school will confirm here.`;
}

async function ptm({ state, contact, children, args }) {
    const tz = state.channel?.timezone;
    const nowIso = new Date().toISOString();
    const keys = classes(children);
    const slots = listAll(state.objects, { type: 'appointment', filter: { service: 'PTM' } })
        .filter((o) => isPtm(o) && o.status !== 'cancelled' && o.data.scheduledAt > nowIso);
    const mine = slots.filter((o) => o.contactId === contact.id);
    const open = slots.filter((o) => !o.contactId && keys.includes(o.metadata.classKey))
        .sort((a, b) => a.data.scheduledAt.localeCompare(b.data.scheduledAt));
    const arg = String(args[0] ?? '').toUpperCase();

    if (arg === 'CANCEL') {
        if (!mine.length) return 'You have no PTM booking to cancel.';
        for (const slot of mine) {
            const { studentId, studentName, parentPhone, ...metadata } = slot.metadata;
            await state.objects.update(slot.id, { contactId: null, status: 'scheduled', metadata }, { source: 'whatsapp' });
        }
        return 'Your PTM booking is cancelled. Reply PTM to pick another slot.';
    }
    if (/^\d+$/.test(arg)) {
        const slot = open[Number(arg) - 1];
        if (!slot) return `There is no open slot ${arg}. Reply PTM to see the list.`;
        const student = children.find((s) => classKeyOf(s.data) === slot.metadata.classKey);
        const clash = mine.find((o) => o.metadata.classKey === slot.metadata.classKey);
        if (clash) return `You already have a PTM on ${when(clash.data.scheduledAt, tz)}. Reply PTM CANCEL first to change it.`;
        const booked = await state.objects.update(slot.id, {
            contactId: contact.id,
            status: 'confirmed',
            metadata: { ...slot.metadata, studentId: student.id, studentName: name(student), parentPhone: contact.phone },
        }, { source: 'whatsapp' });
        const dto = toSlot(booked);
        return render(state, 'school_ptm_confirmed', {
            studentName: name(student), teacher: dto.teacher, startsAt: when(dto.startsAt, tz), durationMinutes: dto.durationMinutes,
        });
    }
    if (!open.length) {
        return mine.length ? `Your PTM is on ${when(mine[0].data.scheduledAt, tz)}. Reply PTM CANCEL to cancel.` : 'No PTM slots are open right now.';
    }
    return ['Open PTM slots:', ...open.slice(0, 20).map((o, i) => `${i + 1}. ${when(o.data.scheduledAt, tz)} - ${o.data.staffId ?? ''} (${o.metadata.classKey})`),
        'Reply PTM <number> to book.'].join('\n');
}
