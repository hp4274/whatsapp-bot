/**
 * The school pack's message templates. Routes render through the tenant's own
 * template of the same name when one exists (so a school can reword it, or
 * swap in a Meta-approved body), and fall back to these defaults otherwise.
 * Super admin provisioning copies these into a tenant's template store.
 *
 * `{placeholders}` are filled by `templates.render` / `personalize`.
 */

export const SCHOOL_TEMPLATES = Object.freeze({
    school_absent_alert: 'Dear Parent, Roll No {rollNumber} ({studentName}) of Class {classKey} was marked absent today, {date}. Reply here if this needs correction.',
    school_late_alert: 'Dear Parent, {studentName} (Class {classKey}) arrived late today at {arrivedAt}. Gate closes at {gateCutoff}.',
    school_monthly_attendance: 'Attendance for {studentName} ({classKey}), {month}: {percentage}% present. Absent on: {absentDates}.',
    school_homework: 'Homework for {classKey} - {subject}: {title}. {instructions} Due: {dueAt}.',
    school_notice: '{schoolName}: {title}\n{body}',
    school_broadcast: '{schoolName}: {message}',
    school_timetable_change: 'Timetable update for {classKey}: {day} period {period} is {status}. {note}',
    school_fee_due: 'Dear Parent, the {term} fee of {currency} {amount} for {studentName} is due on {dueAt}. Pay here: {payLink}',
    school_fee_overdue: 'Dear Parent, the {term} fee of {currency} {amount} for {studentName} is overdue. Pay here: {payLink}',
    school_fee_receipt: 'Receipt {receiptNo}: received {currency} {amount} for {studentName} ({term}) on {paidAt} via {method}. Thank you.',
    school_result: '{examName} result for {studentName} ({classKey}):\n{breakdown}\nTotal: {marks}/{totalMarks}  Grade: {grade}',
    school_leave_approved: 'Leave for {studentName} ({fromDate} to {toDate}) is approved. {note}',
    school_leave_rejected: 'Leave for {studentName} ({fromDate} to {toDate}) could not be approved. {note}',
    school_ptm_confirmed: 'PTM booked: {studentName} with {teacher} on {startsAt} ({durationMinutes} min). Reply PTM CANCEL to cancel.',
});

/** Columns the student import accepts (header names are matched case/space-insensitively). */
export const STUDENT_CSV_COLUMNS = Object.freeze([
    'Roll No', 'Student Name', 'Class', 'Section', 'Father Name', 'Mother Name', 'Parent Phone', 'Bus Route', 'Hostel',
]);
