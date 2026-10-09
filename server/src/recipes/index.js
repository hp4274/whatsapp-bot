/**
 * Phase 12: the ready-made automation modules.
 *
 * Phase 12 is explicit that these are "workflow templates + business objects
 * + UI, not separate automation engines". So there is no engine here and no
 * new action type: a recipe is *data* - a workflow definition and the message
 * templates it references - and installing one is a `WorkflowStore.create`.
 * Every `build()` returns something `validateDefinition` accepts unchanged,
 * which is what the test asserts for the whole catalogue.
 *
 * Trigger names come from `objects/types.js` verbatim. Two of them -
 * `lead_stop_on_reply` and `complaint_to_ticket` - trigger on
 * `message.received`, which the matcher supports (a trigger type is just a
 * string, matched against `event.type`) but which nothing in the app dispatches
 * yet; see the report.
 *
 * Two condition conventions live side by side on purpose:
 *   - a TRIGGER condition is matched against `event.data`, so its field is
 *     `status` or `metadata.kind`;
 *   - a `condition`/`branch` step is matched against the whole run context, so
 *     its field is `event.data.status`.
 */

import { SCHOOL_TEMPLATES } from '../school/templates.js';

/** `{name}`-style placeholders; the template store derives its variable list from these. */
const T = (name, body) => ({ name, body });
/** A school master template, so the recipe and the tenant provisioning share one body. */
const ST = (name) => T(name, SCHOOL_TEMPLATES[name]);

export const RECIPES = Object.freeze([
    {
        key: 'appointment_reminder',
        name: 'Appointment reminder and follow-up',
        description: 'Reminds a day before the appointment, asks for a confirm or a reschedule, then asks how it went.',
        industry: 'clinics, salons, services',
        requires: {
            objectType: 'appointment',
            templates: [
                T('appointment_reminder', 'Hi {name}, a reminder of your {service} appointment on {scheduledAt}. Reply 1 to confirm or 2 to reschedule.'),
                T('appointment_feedback', 'Hi {name}, thanks for coming in. How did we do? Reply with a word or two - it helps.'),
            ],
        },
        build({ remindHoursBefore = 24, feedbackHoursAfter = 2 } = {}) {
            return {
                name: 'Appointment reminder and follow-up',
                trigger: { type: 'appointment.created' },
                steps: [
                    // A negative offset on the appointment time: "a day before".
                    { id: 'hold', action: 'wait', params: { until: 'event.data.scheduledAt', hours: -Math.abs(remindHoursBefore) }, next: 'remind' },
                    { id: 'remind', action: 'send_template', params: { template: 'appointment_reminder' }, next: 'settle' },
                    { id: 'settle', action: 'wait', params: { until: 'event.data.scheduledAt', hours: Math.abs(feedbackHoursAfter) }, next: 'feedback' },
                    { id: 'feedback', action: 'send_template', params: { template: 'appointment_feedback' }, next: null },
                ],
            };
        },
    },
    {
        key: 'appointment_confirmed',
        name: 'Appointment confirmed or rescheduled',
        description: 'Acknowledges the new time whenever an appointment is confirmed or moved.',
        industry: 'clinics, salons, services',
        requires: {
            objectType: 'appointment',
            templates: [
                T('appointment_confirmed', 'Thanks {name} - your {service} is set for {scheduledAt}. See you then.'),
            ],
        },
        build() {
            return {
                name: 'Appointment confirmed or rescheduled',
                trigger: { type: 'appointment.updated', conditions: [{ field: 'status', op: 'in', value: ['confirmed', 'rescheduled'] }] },
                steps: [
                    { id: 'ack', action: 'send_template', params: { template: 'appointment_confirmed' }, next: null },
                ],
            };
        },
    },
    {
        key: 'order_confirmation',
        name: 'Order confirmation',
        description: 'Confirms a new order the moment it is placed.',
        industry: 'retail, ecommerce',
        requires: {
            objectType: 'order',
            templates: [
                T('order_confirmed', 'Thanks {name}! Order {reference} for {amount} is confirmed. We will tell you when it ships.'),
            ],
        },
        build() {
            return {
                name: 'Order confirmation',
                trigger: { type: 'order.created' },
                steps: [
                    { id: 'confirm', action: 'send_template', params: { template: 'order_confirmed' }, next: null },
                ],
            };
        },
    },
    {
        key: 'order_status_updates',
        name: 'Order shipped, delivered, feedback',
        description: 'One workflow for the whole post-purchase trail: shipping notice, delivery notice, then a feedback ask.',
        industry: 'retail, ecommerce',
        requires: {
            objectType: 'order',
            templates: [
                T('order_shipped', 'Good news {name} - order {reference} has shipped. Tracking: {trackingId}'),
                T('order_delivered', 'Order {reference} was delivered. Enjoy, {name}!'),
                T('order_feedback', 'Hi {name}, how was order {reference}? Reply with a rating from 1 to 5.'),
            ],
        },
        build({ feedbackAfterDays = 2 } = {}) {
            return {
                name: 'Order shipped, delivered, feedback',
                trigger: { type: 'order.status_changed' },
                steps: [
                    {
                        id: 'route',
                        action: 'branch',
                        params: {
                            branches: [
                                { conditions: [{ field: 'event.data.status', op: 'eq', value: 'shipped' }], next: 'shipped' },
                                { conditions: [{ field: 'event.data.status', op: 'eq', value: 'delivered' }], next: 'delivered' },
                            ],
                            else: null, // any other status is not news
                        },
                        next: null,
                    },
                    { id: 'shipped', action: 'send_template', params: { template: 'order_shipped' }, next: null },
                    { id: 'delivered', action: 'send_template', params: { template: 'order_delivered' }, next: 'settle' },
                    { id: 'settle', action: 'wait', params: { days: feedbackAfterDays }, next: 'feedback' },
                    { id: 'feedback', action: 'send_template', params: { template: 'order_feedback' }, next: null },
                ],
            };
        },
    },
    {
        key: 'lead_welcome',
        name: 'Lead welcome and follow-ups',
        description: 'Welcomes a new lead, then follows up twice on a delay. Install lead_stop_on_reply beside it to stop the chase once they answer.',
        industry: 'sales, real estate, services',
        requires: {
            objectType: 'lead',
            templates: [
                T('lead_welcome', 'Hi {name}, thanks for your interest in {interest}. Anything you want to know?'),
                T('lead_followup_1', 'Hi {name}, just checking in - still thinking about {interest}?'),
                T('lead_followup_2', 'Last note from me, {name}. Reply any time and we will pick it up.'),
            ],
        },
        build({ firstFollowUpDays = 1, secondFollowUpDays = 3 } = {}) {
            return {
                name: 'Lead welcome and follow-ups',
                trigger: { type: 'lead.created' },
                steps: [
                    { id: 'welcome', action: 'send_template', params: { template: 'lead_welcome' }, next: 'hold_1' },
                    { id: 'hold_1', action: 'wait', params: { days: firstFollowUpDays }, next: 'followup_1' },
                    { id: 'followup_1', action: 'send_template', params: { template: 'lead_followup_1' }, next: 'hold_2' },
                    { id: 'hold_2', action: 'wait', params: { days: secondFollowUpDays }, next: 'followup_2' },
                    { id: 'followup_2', action: 'send_template', params: { template: 'lead_followup_2' }, next: 'tag' },
                    { id: 'tag', action: 'add_tag', params: { tag: 'nurtured' }, next: null },
                ],
            };
        },
    },
    {
        key: 'lead_stop_on_reply',
        name: 'Stop chasing a lead who replied',
        description: 'On an inbound message, stops this contact\'s runs of the nurture workflow and tags them as replied.',
        industry: 'sales, real estate, services',
        requires: {
            templates: [],
        },
        /** `nurtureWorkflowId` is the id `lead_welcome` installed as; 0 stops nothing. */
        build({ nurtureWorkflowId = 0, assignTo = null } = {}) {
            const steps = [
                { id: 'stop', action: 'stop_workflow', params: { workflowId: nurtureWorkflowId }, next: 'tag' },
                { id: 'tag', action: 'add_tag', params: { tag: 'replied' }, next: assignTo ? 'assign' : null },
            ];
            if (assignTo) steps.push({ id: 'assign', action: 'set_field', params: { key: 'assignedTo', value: assignTo }, next: null });
            return { name: 'Stop chasing a lead who replied', trigger: { type: 'message.received' }, steps };
        },
    },
    {
        key: 'payment_due_reminder',
        name: 'Payment due, then overdue',
        description: 'Reminds when a payment falls due and chases twice after that. Install payment_received to stop the chase.',
        industry: 'finance, services, subscriptions',
        requires: {
            objectType: 'payment',
            templates: [
                T('payment_due', 'Hi {name}, {amount} for {invoiceId} is due today. Reply here if anything is unclear.'),
                T('payment_overdue', 'Hi {name}, {amount} for {invoiceId} is still outstanding.'),
                T('payment_final_notice', 'Hi {name}, this is the last reminder for {amount} on {invoiceId}.'),
            ],
        },
        build({ overdueAfterDays = 3, finalAfterDays = 4 } = {}) {
            return {
                name: 'Payment due, then overdue',
                trigger: { type: 'payment.due' },
                steps: [
                    { id: 'due', action: 'send_template', params: { template: 'payment_due' }, next: 'hold_1' },
                    { id: 'hold_1', action: 'wait', params: { days: overdueAfterDays }, next: 'overdue' },
                    { id: 'overdue', action: 'send_template', params: { template: 'payment_overdue' }, next: 'hold_2' },
                    { id: 'hold_2', action: 'wait', params: { days: finalAfterDays }, next: 'final' },
                    { id: 'final', action: 'send_template', params: { template: 'payment_final_notice' }, next: null },
                ],
            };
        },
    },
    {
        key: 'payment_received',
        name: 'Payment received: stop the reminders',
        description: 'When a payment moves to paid, stops that contact\'s reminder runs and sends a receipt.',
        industry: 'finance, services, subscriptions',
        requires: {
            objectType: 'payment',
            templates: [
                T('payment_receipt', 'Thanks {name} - we have received {amount} for {invoiceId}.'),
            ],
        },
        /** `reminderWorkflowId` is the id `payment_due_reminder` installed as. */
        build({ reminderWorkflowId = 0 } = {}) {
            return {
                name: 'Payment received: stop the reminders',
                trigger: { type: 'payment.status_changed', conditions: [{ field: 'status', op: 'eq', value: 'paid' }] },
                steps: [
                    { id: 'stop', action: 'stop_workflow', params: { workflowId: reminderWorkflowId }, next: 'receipt' },
                    { id: 'receipt', action: 'send_template', params: { template: 'payment_receipt' }, next: null },
                ],
            };
        },
    },
    {
        key: 'subscription_renewal',
        name: 'Subscription expiring and renewal',
        description: 'Reminds before expiry, chases once, then sends the expiry notice on the day.',
        industry: 'saas, gyms, memberships',
        requires: {
            objectType: 'subscription',
            templates: [
                T('subscription_expiring', 'Hi {name}, your {plan} plan expires on {expiresAt}. Renew for {amount}?'),
                T('subscription_renewal_reminder', 'Hi {name}, {plan} is about to lapse. Reply RENEW and we will sort it.'),
                T('subscription_expired', 'Hi {name}, your {plan} plan has expired. Reply RENEW to pick up where you left off.'),
            ],
        },
        build({ chaseAfterDays = 3 } = {}) {
            return {
                name: 'Subscription expiring and renewal',
                trigger: { type: 'subscription.expiring' },
                steps: [
                    { id: 'notice', action: 'send_template', params: { template: 'subscription_expiring' }, next: 'hold' },
                    { id: 'hold', action: 'wait', params: { days: chaseAfterDays }, next: 'chase' },
                    { id: 'chase', action: 'send_template', params: { template: 'subscription_renewal_reminder' }, next: 'until_expiry' },
                    { id: 'until_expiry', action: 'wait', params: { until: 'event.data.expiresAt' }, next: 'expired' },
                    { id: 'expired', action: 'send_template', params: { template: 'subscription_expired' }, next: null },
                ],
            };
        },
    },
    {
        key: 'event_registration',
        name: 'Event registration, reminders, feedback',
        description: 'Confirms a registration, reminds a day and an hour before, then asks for feedback after.',
        industry: 'events, training, community',
        requires: {
            objectType: 'event',
            templates: [
                T('event_confirmed', 'You are in, {name}! {title} on {startsAt} at {venue}.'),
                T('event_reminder', 'Reminder: {title} is tomorrow at {venue}. See you there, {name}.'),
                T('event_final_reminder', '{title} starts shortly at {venue}. Doors are open.'),
                T('event_feedback', 'Thanks for coming to {title}, {name}. What did you think?'),
            ],
        },
        build({ remindHoursBefore = 24, finalHoursBefore = 2, feedbackHoursAfter = 24 } = {}) {
            return {
                name: 'Event registration, reminders, feedback',
                trigger: { type: 'event.created' },
                steps: [
                    { id: 'confirm', action: 'send_template', params: { template: 'event_confirmed' }, next: 'hold_1' },
                    { id: 'hold_1', action: 'wait', params: { until: 'event.data.startsAt', hours: -Math.abs(remindHoursBefore) }, next: 'remind' },
                    { id: 'remind', action: 'send_template', params: { template: 'event_reminder' }, next: 'hold_2' },
                    { id: 'hold_2', action: 'wait', params: { until: 'event.data.startsAt', hours: -Math.abs(finalHoursBefore) }, next: 'final' },
                    { id: 'final', action: 'send_template', params: { template: 'event_final_reminder' }, next: 'hold_3' },
                    { id: 'hold_3', action: 'wait', params: { until: 'event.data.startsAt', hours: Math.abs(feedbackHoursAfter) }, next: 'feedback' },
                    { id: 'feedback', action: 'send_template', params: { template: 'event_feedback' }, next: null },
                ],
            };
        },
    },
    {
        key: 'student_welcome',
        name: 'Student enrolment welcome',
        description: 'Welcomes a new student (or their parent) and tags the contact for the school segments.',
        industry: 'schools, coaching',
        requires: {
            objectType: 'student',
            templates: [
                T('student_welcome', 'Welcome {name}! You are enrolled in {course}, batch {batch}. We will send updates here.'),
            ],
        },
        build() {
            return {
                name: 'Student enrolment welcome',
                trigger: { type: 'student.created' },
                steps: [
                    { id: 'welcome', action: 'send_template', params: { template: 'student_welcome' }, next: 'tag' },
                    { id: 'tag', action: 'add_tag', params: { tags: ['student', 'school'] }, next: null },
                ],
            };
        },
    },
    {
        key: 'school_fee_reminder',
        name: 'School fee reminder',
        description: 'A fee-specific payment reminder: triggers only on payments marked as fees, so it never collides with the generic one.',
        industry: 'schools, coaching',
        requires: {
            objectType: 'payment',
            templates: [
                T('school_fee_due', 'Dear parent, the fee of {amount} for {invoiceId} is due. Reply here with any question.'),
                T('school_fee_overdue', 'Dear parent, the fee of {amount} for {invoiceId} is still pending.'),
            ],
        },
        build({ overdueAfterDays = 3, kind = 'fee' } = {}) {
            return {
                name: 'School fee reminder',
                // The payment carries `metadata: { kind: 'fee' }`; without that
                // marker this workflow and payment_due_reminder would both fire.
                trigger: { type: 'payment.due', conditions: [{ field: 'metadata.kind', op: 'eq', value: kind }] },
                steps: [
                    { id: 'due', action: 'send_template', params: { template: 'school_fee_due' }, next: 'hold' },
                    { id: 'hold', action: 'wait', params: { days: overdueAfterDays }, next: 'overdue' },
                    { id: 'overdue', action: 'send_template', params: { template: 'school_fee_overdue' }, next: null },
                ],
            };
        },
    },
    {
        key: 'daily_absent_alert',
        name: 'Daily absent alert',
        description: 'Alerts the parent the instant an attendance record is marked absent. Do not combine it with the portal manual "Notify parents" button, or parents get two alerts.',
        industry: 'schools, coaching',
        requires: {
            objectType: 'attendance',
            templates: [
                T('daily_absent_alert', 'Dear parent, {studentName} has been marked absent for {className} on {date}. Reply here if this needs correction.'),
            ],
        },
        build() {
            return {
                name: 'Daily absent alert',
                trigger: { type: 'attendance.created', conditions: [{ field: 'status', op: 'eq', value: 'absent' }] },
                steps: [
                    { id: 'alert', action: 'send_template', params: { template: 'daily_absent_alert' }, next: null },
                ],
            };
        },
    },
    {
        key: 'fee_payment_receipt',
        name: 'Fee payment receipt',
        description: 'Sends a receipt to the parent as soon as a fee is marked paid.',
        industry: 'schools, coaching',
        requires: { objectType: 'fee', templates: [ST('school_fee_receipt')] },
        build() {
            return {
                name: 'Fee payment receipt',
                trigger: { type: 'fee.status_changed', conditions: [{ field: 'status', op: 'eq', value: 'paid' }] },
                steps: [{ id: 'receipt', action: 'send_template', params: { template: 'school_fee_receipt' }, next: null }],
            };
        },
    },
    {
        key: 'fee_due_reminder',
        name: 'Fee due reminder',
        description: 'The fee-object version of the school fee reminder: nudges 3 days before the due date, then once more a day after the due date. It cannot see a payment made in between, so use the portal reminders for paid-aware nudges.',
        industry: 'schools, coaching',
        requires: { objectType: 'fee', templates: [ST('school_fee_due'), ST('school_fee_overdue')] },
        build({ remindHoursBefore = 72, overdueHoursAfter = 24 } = {}) {
            return {
                name: 'Fee due reminder',
                trigger: { type: 'fee.created' },
                steps: [
                    { id: 'hold', action: 'wait', params: { until: 'event.data.dueAt', hours: -Math.abs(remindHoursBefore) }, next: 'due' },
                    { id: 'due', action: 'send_template', params: { template: 'school_fee_due' }, next: 'settle' },
                    // ponytail: no paid check - a run sees the fee as created, not live. Add when the engine can re-read objects.
                    { id: 'settle', action: 'wait', params: { until: 'event.data.dueAt', hours: Math.abs(overdueHoursAfter) }, next: 'overdue' },
                    { id: 'overdue', action: 'send_template', params: { template: 'school_fee_overdue' }, next: null },
                ],
            };
        },
    },
    {
        key: 'late_arrival_alert',
        name: 'Late arrival alert',
        description: 'Tells the parent when a student is marked late.',
        industry: 'schools, coaching',
        requires: { objectType: 'attendance', templates: [ST('school_late_alert')] },
        build() {
            return {
                name: 'Late arrival alert',
                trigger: { type: 'attendance.created', conditions: [{ field: 'status', op: 'eq', value: 'late' }] },
                steps: [{ id: 'alert', action: 'send_template', params: { template: 'school_late_alert' }, next: null }],
            };
        },
    },
    {
        key: 'homework_due_reminder',
        name: 'Homework due reminder',
        description: 'Reminds the class a day before homework is due.',
        industry: 'schools, coaching',
        requires: {
            objectType: 'homework',
            templates: [T('school_homework_due', 'Reminder: {subject} homework "{title}" for {classKey} is due {dueAt}.')],
        },
        build({ remindHoursBefore = 24 } = {}) {
            return {
                name: 'Homework due reminder',
                trigger: { type: 'homework.created' },
                steps: [
                    { id: 'hold', action: 'wait', params: { until: 'event.data.dueAt', hours: -Math.abs(remindHoursBefore) }, next: 'remind' },
                    { id: 'remind', action: 'send_template', params: { template: 'school_homework_due' }, next: null },
                ],
            };
        },
    },
    {
        key: 'exam_result_published',
        name: 'Exam result published',
        description: 'Sends the result breakdown to the parent when an exam result is published.',
        industry: 'schools, coaching',
        requires: { objectType: 'exam_result', templates: [ST('school_result')] },
        build() {
            return {
                name: 'Exam result published',
                trigger: { type: 'exam_result.status_changed', conditions: [{ field: 'status', op: 'eq', value: 'published' }] },
                steps: [{ id: 'result', action: 'send_template', params: { template: 'school_result' }, next: null }],
            };
        },
    },
    {
        key: 'homework_broadcast',
        name: 'Homework broadcast',
        description: 'Sends the homework details when a new homework object is published into the catalogue.',
        industry: 'schools, coaching',
        requires: {
            objectType: 'homework',
            templates: [
                T('homework_broadcast', 'Homework for {className} {section}: {subject} - {title}. Due {dueAt}. {instructions}'),
            ],
        },
        build() {
            return {
                name: 'Homework broadcast',
                trigger: { type: 'homework.created' },
                steps: [
                    { id: 'send', action: 'send_template', params: { template: 'homework_broadcast' }, next: null },
                ],
            };
        },
    },
    {
        key: 'ptm_slot_booking',
        name: 'PTM slot booking',
        description: 'Turns an inbound PTM booking request into a staff ticket and confirms that the request was received.',
        industry: 'schools, coaching',
        requires: {
            templates: [],
        },
        build({ assignTo = 'front-desk' } = {}) {
            return {
                name: 'PTM slot booking',
                trigger: { type: 'message.received', conditions: [{ field: 'intent', op: 'eq', value: 'ptm_slot_booking' }] },
                steps: [
                    { id: 'file', action: 'create_ticket', params: { category: 'ptm', priority: 'normal', assignedTo: assignTo, subject: 'PTM slot request from {name}' }, next: 'ack' },
                    { id: 'ack', action: 'send_message', params: { text: 'Thanks {name}. We have received your PTM slot request as {vars.file.reference}.' }, next: null },
                ],
            };
        },
    },
    {
        key: 'leave_request_to_ticket',
        name: 'Leave request to ticket',
        description: 'Files an inbound leave request for school staff review and acknowledges the parent.',
        industry: 'schools, coaching',
        requires: {
            templates: [],
        },
        build({ assignTo = 'class-teacher' } = {}) {
            return {
                name: 'Leave request to ticket',
                trigger: { type: 'message.received', conditions: [{ field: 'intent', op: 'eq', value: 'leave_request' }] },
                steps: [
                    { id: 'file', action: 'create_ticket', params: { category: 'leave_request', priority: 'normal', assignedTo: assignTo, subject: 'Leave request from {name}' }, next: 'ack' },
                    { id: 'ack', action: 'send_message', params: { text: 'Thanks {name}. Your leave request has been logged as {vars.file.reference}.' }, next: null },
                ],
            };
        },
    },
    {
        key: 'timetable_lookup',
        name: 'Timetable lookup',
        description: 'Replies to an inbound timetable lookup intent with the timetable fields carried by the event.',
        industry: 'schools, coaching',
        requires: {
            templates: [
                T('timetable_lookup', '{className} {section} timetable for {day}: {period} - {subject} with {teacher} in {room}.'),
            ],
        },
        build() {
            return {
                name: 'Timetable lookup',
                trigger: { type: 'message.received', conditions: [{ field: 'intent', op: 'eq', value: 'timetable_lookup' }] },
                steps: [
                    { id: 'reply', action: 'send_template', params: { template: 'timetable_lookup' }, next: null },
                ],
            };
        },
    },
    {
        key: 'complaint_to_ticket',
        name: 'Complaint to ticket',
        description: 'Files a ticket from an inbound complaint, assigns it, and tells the customer the reference.',
        industry: 'support, any',
        requires: {
            templates: [],
        },
        build({ assignTo = 'support', priority = 'high', category = 'complaint' } = {}) {
            return {
                name: 'Complaint to ticket',
                trigger: { type: 'message.received', conditions: [{ field: 'intent', op: 'eq', value: 'complaint' }] },
                steps: [
                    {
                        id: 'file',
                        action: 'create_ticket',
                        params: { category, priority, subject: 'Complaint from {name}' },
                        next: 'assign',
                    },
                    // `vars.file` is the previous step's output, so the ticket is
                    // named by the reference it was just given.
                    { id: 'assign', action: 'assign_agent', params: { reference: '{vars.file.reference}', assignedTo: assignTo }, next: 'ack' },
                    {
                        id: 'ack',
                        action: 'send_message',
                        params: { text: 'Sorry about this, {name}. We have logged it as {vars.file.reference} and someone is on it.' },
                        next: null,
                    },
                ],
            };
        },
    },
]);

export function getRecipe(key) {
    return RECIPES.find((recipe) => recipe.key === String(key)) ?? null;
}

/**
 * Install a recipe: create any template it names that does not exist yet, then
 * create the workflow. Both stores are passed in; this function owns no state.
 *
 * @returns {{ workflow: object, templates: string[] }} the workflow, and the
 *   names of the templates this call had to create.
 */
export function installRecipe(recipe, { workflows, templates, channelId = null, name = null, status = 'draft', options = {} } = {}) {
    const created = [];
    for (const wanted of recipe.requires.templates ?? []) {
        if (templates.getByName(wanted.name)) continue;
        templates.create({ name: wanted.name, body: wanted.body, channelId });
        created.push(wanted.name);
    }
    const definition = recipe.build(options);
    const workflow = workflows.create({
        name: name || definition.name,
        channelId,
        status,
        trigger: definition.trigger,
        steps: definition.steps,
    });
    return { workflow, templates: created };
}
