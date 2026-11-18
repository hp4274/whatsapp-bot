/**
 * The Appointments and Leads clocks (moduleSweeps.js): booking reminders to the customer, and lead follow-ups to
 * the owner. Only moduleSweeps.js imports this file, which keeps the import cycle through ownerAlert safe.
 */

import { ownerAlert } from '../moduleSweeps.js';
import { deliver } from '../school/routes.js';
import { customerPhone, whenText } from '../shop/notice.js';
import { ShopStore } from '../shop/store.js';
import { OBJECT_TYPES } from './types.js';

const HOUR = 3_600_000;
const REMIND = ['scheduled', 'confirmed', 'rescheduled'];
/** A follow-up time older than this is not alerted any more (the sweep was down, or it was set in the past). */
const FOLLOW_UP_WINDOW = 24 * HOUR;

export const APPOINTMENT_REMINDERS = Object.freeze({
    name: 'appointment-reminders',
    service: 'appointments',
    run(state, now) {
        if (!state.objects || state.platformPolicy?.()?.['appointments.allowReminders'] === false) return;
        const hours = Number(new ShopStore(state.db).settings('booking').reminderHours) || 0;
        if (hours <= 0) return;
        const upcoming = state.objects.list({ type: 'appointment', from: now, to: new Date(now.getTime() + hours * HOUR), limit: 1000 });
        for (const o of upcoming) {
            const at = new Date(o.data.scheduledAt).getTime();
            // Booked inside the window: the booking message itself was the reminder.
            if (!REMIND.includes(o.status) || new Date(o.createdAt).getTime() > at - hours * HOUR) continue;
            const phone = customerPhone(state, o);
            if (!phone) continue;
            deliver(state, {
                recipient: phone, messageType: 'transactional',
                // Keyed by the time too, so a moved booking is reminded again.
                key: `appointment.reminder.${o.id}.${o.data.scheduledAt}`,
                text: `Reminder: your ${o.data.service} is at ${whenText(o.data.scheduledAt, state.channel?.timezone)}. Reply here if you need to change it.`,
            });
        }
    },
});

export const LEAD_FOLLOW_UPS = Object.freeze({
    name: 'lead-follow-ups',
    service: 'leads',
    run(state, now) {
        if (!state.objects) return;
        const due = state.objects.list({ type: 'lead', from: new Date(now.getTime() - FOLLOW_UP_WINDOW), to: new Date(now.getTime() + 1), limit: 1000 });
        for (const o of due) {
            if (OBJECT_TYPES.lead.closed.includes(o.status)) continue;
            const phone = customerPhone(state, o);
            const who = [o.data.name, phone && `+${String(phone).replace(/^\+/, '')}`].filter(Boolean).join(' ') || o.reference;
            ownerAlert(state, `Follow up: ${who}${o.data.interest ? ` - ${o.data.interest}` : ''}`, `lead.followup.${o.id}.${o.data.followUpAt}`);
        }
    },
});
