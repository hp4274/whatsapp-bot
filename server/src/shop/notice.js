/**
 * What the customer is told when their order or booking moves along, from the WhatsApp shop's page
 * (shop/routes.js) or the Records page (objects/routes.js). Both send with the same idempotency key, so a
 * move seen by both is still one message.
 */

import { deliver } from '../school/routes.js';
import { moneyIn } from './bot.js';

const NOTICE = {
    order: {
        confirmed: 'Your order *{ref}* is confirmed. We are getting it ready.',
        processing: 'Your order *{ref}* is being prepared.',
        shipped: 'Your order *{ref}* is on its way!{tracking}',
        delivered: 'Your order *{ref}* has been delivered. Thank you for shopping with us!',
        cancelled: 'Your order *{ref}* has been cancelled. Reply here if you have a question.',
        refunded: 'The refund for order *{ref}* has been sent.',
    },
    appointment: {
        confirmed: 'Your booking *{ref}* for {service} on {when} is confirmed. See you then!',
        rescheduled: 'Your booking *{ref}* for {service} has moved to {when}.',
        completed: 'Thanks for visiting! We hope to see you again.',
        cancelled: 'Your booking *{ref}* has been cancelled. Reply here if you have a question.',
    },
};

/** The policy prefix (policy/records.js) for each record type that has notices. */
const SERVICE = { order: 'orders', appointment: 'appointments' };

/** "Tue, 25 Nov, 4:00 pm" in the business's time zone; the ISO text when it cannot be read. */
export function whenText(iso, timeZone) {
    if (!iso) return '';
    try {
        return new Intl.DateTimeFormat('en-IN', { timeZone: timeZone || 'UTC', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
            .format(new Date(iso));
    } catch {
        return iso;
    }
}

/** The number to message about a record: the one it was placed from, else its contact's, else a lead's own. */
export function customerPhone(state, o) {
    return o.metadata?.phone ?? (o.contactId ? state.contacts?.get(o.contactId)?.phone : null) ?? o.data?.phone ?? null;
}

/** The message for a payment received and/or a status move ('' when there is nothing to say). */
export function noticeText(o, { paidNow = false, statusMoved = false, state }) {
    const lines = [];
    if (paidNow) lines.push(`Payment received for *${o.reference}* - ${moneyIn(o.data.currency)(o.metadata?.total ?? o.data.amount ?? 0)}. Thank you!`);
    const statusOn = state.platformPolicy?.()?.[`${SERVICE[o.type]}.notifyOnStatus`] !== false;
    const template = statusMoved && statusOn ? NOTICE[o.type]?.[o.status] : null;
    if (template) {
        lines.push(template.replace('{ref}', o.reference).replace('{service}', o.data.service ?? '')
            .replace('{when}', whenText(o.data.scheduledAt, state.channel?.timezone))
            .replace('{tracking}', o.data.trackingId ? `\nTracking: ${o.data.trackingId}` : ''));
    }
    return lines.join('\n\n');
}

/** Tell the customer; returns deliver()'s outcome, or 'skipped' with nothing to say or nobody to say it to. */
export function notifyCustomer(state, o, { paidNow = false, statusMoved = false } = {}) {
    if (!SERVICE[o.type]) return 'skipped';
    const text = noticeText(o, { paidNow, statusMoved, state });
    const phone = text ? customerPhone(state, o) : null;
    if (!phone) return 'skipped';
    return deliver(state, {
        recipient: phone, text, messageType: 'transactional',
        key: `shop.notice.${o.id}.${o.status}.${o.metadata?.payment}`,
    });
}
