/**
 * The business modules' clock: built-in reminders and follow-ups that run without the Workflows service
 * (appointment reminders, payment dues, lead follow-ups, ticket auto-close...).
 *
 * Each module adds ONE entry to MODULE_SWEEPS: { name, service, run(state, now) }. The platform sweep in app.js calls
 * `run` once a minute for every active tenant that has `service`, on that tenant's default number's runtime
 * (`state` is the same object routers get: state.db, state.objects, state.messages, state.platformPolicy()...).
 * A run must be idempotent - use deliver()'s key (school/routes.js) so a message goes once however often it runs -
 * and quick: it is awaited in turn with every other tenant's.
 */

import { greetingSweep } from './contactGreetings.js';
import { deliver } from './school/routes.js';
import { APPOINTMENT_REMINDERS, LEAD_FOLLOW_UPS } from './objects/sweeps.js';
import { paymentReminderSweep } from './paymentDues.js';
import { ticketSweep } from './tickets/whatsapp.js';

export const MODULE_SWEEPS = [APPOINTMENT_REMINDERS, LEAD_FOLLOW_UPS];
MODULE_SWEEPS.push({ name: 'contacts.greetings', service: 'contacts', run: greetingSweep });
MODULE_SWEEPS.push({ name: 'tickets', service: 'tickets', run: ticketSweep });
// Called through a closure: paymentDues.js imports ownerAlert from here.
MODULE_SWEEPS.push({ name: 'payment.dues', service: 'payment_reminders', run: (state, now) => paymentReminderSweep(state, now) });

/**
 * Message the business owner on WhatsApp (the contact number the super admin keeps on the tenant), from the
 * business's own number. Returns 'sent', 'duplicate', 'skipped' (no owner number) or 'failed'.
 * `key` makes it once-only: the same key never sends twice.
 */
export function ownerAlert(state, text, key) {
    const phone = String(state.tenancy?.getTenant?.(state.db.tenantId)?.contactPhone ?? '').replace(/\D/g, '');
    if (!phone) return 'skipped';
    return deliver(state, { recipient: phone, text, key: `owner.${key}`, messageType: 'transactional' });
}
