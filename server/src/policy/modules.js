/**
 * Platform rules for the business modules opened on 2026-11-18: Orders, Appointments, Leads, Payment reminders,
 * FAQ, Tickets and OTP. See `index.js` for the field shape. Every default is what the module did before it had rules
 * (no limit, everything on), so a business notices nothing until the super admin sets a value.
 */

/** The WhatsApp-ordering rules, once for Orders (products) and once for Appointments (services). */
function shopRules(prefix, service, { thing, things, record, records }) {
    return [
        { key: `${prefix}.allowWhatsapp`, service, group: 'WhatsApp', type: 'bool', default: true,
          label: `Take ${records} on WhatsApp`,
          hint: `Customers browse the ${things}, pick by number and ${prefix === 'orders' ? 'check out' : 'choose a time'} in the chat. Off: only the records list.` },
        { key: `${prefix}.allowUpi`, service, group: 'WhatsApp', type: 'bool', default: true,
          label: 'Ask for payment by UPI QR',
          hint: `Off: the ${record} is placed without the QR and the "reply PAID" step.` },
        { key: `${prefix}.cartHours`, service, group: 'WhatsApp', type: 'int', default: 24, min: 1, max: 168,
          label: 'Forget an unfinished chat after (hours)',
          hint: `A customer who stops half-way starts again after this. Keeps an old "2" from being read as a pick.` },
        { key: `${prefix}.maxProducts`, service, group: 'Limits', type: 'int', default: 0, min: 0, max: 100000, unlimitedAt: 0,
          label: `${thing.charAt(0).toUpperCase()}${thing.slice(1)}s per business`, hint: '0 = no limit.' },
        { key: `${prefix}.maxPerMonth`, service, group: 'Limits', type: 'int', default: 0, min: 0, max: 10_000_000, unlimitedAt: 0,
          label: `New ${records} a month`, hint: 'From WhatsApp, the dashboard and the API together. 0 = no limit.' },
    ];
}

export const MODULE_POLICY = Object.freeze([
    ...shopRules('orders', 'orders', { thing: 'product', things: 'products', record: 'order', records: 'orders' }),
    ...shopRules('appointments', 'appointments', { thing: 'service', things: 'services', record: 'booking', records: 'bookings' }),

    { key: 'leads.maxLeads', service: 'leads', group: 'Limits', type: 'int', default: 0, min: 0, max: 10_000_000, unlimitedAt: 0,
      label: 'Leads per business', hint: 'All leads kept at once. 0 = no limit.' },

    { key: 'paymentReminders.maxPerSend', service: 'payment_reminders', group: 'Limits', type: 'int', default: 0, min: 0, max: 1_000_000,
      unlimitedAt: 0, label: 'Reminders in one send', hint: 'Rows of one uploaded sheet sent at a time. 0 = no limit.' },

    { key: 'faq.autoAnswer', service: 'faq', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Answer customers from the FAQ', hint: 'Off: the FAQ is kept, but nothing is answered from it on WhatsApp.' },
    { key: 'faq.maxItems', service: 'faq', group: 'Limits', type: 'int', default: 0, min: 0, max: 100000, unlimitedAt: 0,
      label: 'FAQ answers per business', hint: '0 = no limit.' },

    { key: 'tickets.sla', service: 'tickets', group: 'Response time', type: 'table',
      default: [
          { priority: 'Low', hours: 72 },
          { priority: 'Normal', hours: 24 },
          { priority: 'High', hours: 8 },
          { priority: 'Urgent', hours: 2 },
      ],
      columns: [
          { key: 'priority', type: 'text', fixed: true, label: 'Priority' },
          { key: 'hours', type: 'int', min: 1, max: 720, label: 'Hours' },
      ],
      label: 'Time to resolve, by priority', hint: 'A ticket past this is shown as overdue.' },
    { key: 'tickets.notifyOnClose', service: 'tickets', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Tell the customer when a ticket is resolved', hint: 'Off: resolving or closing sends nothing.' },

    { key: 'otp.maxPerPhoneHour', service: 'otp', group: 'Limits', type: 'int', default: 5, min: 0, max: 1000, unlimitedAt: 0,
      label: 'Codes to one phone an hour', hint: 'Stops one number being flooded with codes. 0 = no limit.' },
    { key: 'otp.maxPerMonth', service: 'otp', group: 'Limits', type: 'int', default: 0, min: 0, max: 10_000_000, unlimitedAt: 0,
      label: 'Codes a month', hint: 'Every code sent by the business, from the API and the test button. 0 = no limit.' },
    { key: 'otp.maxTtlMinutes', service: 'otp', group: 'Limits', type: 'int', default: 30, min: 1, max: 60,
      label: 'Longest a code stays valid (minutes)', hint: 'A longer expiry asked for by the business is cut to this.' },
    { key: 'otp.allowCustomCode', service: 'otp', group: 'API', type: 'bool', default: true,
      label: 'Let the business send its own code', hint: 'Off: every code is made here, and a "code" in the request is refused.' },
]);

/** A "0 = no limit" rule as a number, or null for no limit. */
export const ruleCap = (policy, key) => {
    const n = Number(policy?.[key] ?? 0);
    return Number.isFinite(n) && n > 0 ? n : null;
};

/** The policy prefix of the record types that have creation caps. */
const OBJECT_CAPS = Object.freeze({
    order: { key: 'orders.maxPerMonth', monthly: true, noun: 'orders' },
    appointment: { key: 'appointments.maxPerMonth', monthly: true, noun: 'bookings' },
    lead: { key: 'leads.maxLeads', monthly: false, noun: 'leads' },
});

/**
 * Why one more `type` record may not be created now, or null. `objects` is the tenant's ObjectStore; a monthly cap
 * counts from the 1st of this month (UTC), a total cap counts everything kept.
 */
export function objectCapError(policy, objects, type, now = new Date()) {
    const rule = OBJECT_CAPS[type];
    const cap = rule && ruleCap(policy, rule.key);
    if (!cap || !objects) return null;
    const since = rule.monthly ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) : undefined;
    const used = objects.count({ type, createdSince: since });
    return used >= cap
        ? `Your plan allows ${cap} ${rule.noun}${rule.monthly ? ' a month' : ''}, and you have reached it.`
        : null;
}
