/**
 * Platform rules for what Orders, Appointments and Leads send on their own: status notices from the Records page,
 * booking reminders, and leads made from new chats. See `index.js` for the field shape. Every default keeps what
 * the business could do before the rule existed.
 */

export const RECORDS_POLICY = Object.freeze([
    { key: 'orders.notifyOnStatus', service: 'orders', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Tell the customer when an order moves',
      hint: 'Confirmed, shipped, delivered, cancelled... is sent to the customer on WhatsApp. Off: status changes send nothing.' },
    { key: 'appointments.notifyOnStatus', service: 'appointments', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Tell the customer when a booking moves',
      hint: 'Confirmed, moved or cancelled is sent to the customer on WhatsApp. Off: status changes send nothing.' },
    { key: 'appointments.allowReminders', service: 'appointments', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Let the business send booking reminders',
      hint: 'A reminder some hours before each booking, as the business sets it. Off: no reminders are sent.' },
    { key: 'leads.autoCapture', service: 'leads', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Let the business make leads from new chats',
      hint: 'When the business switches it on, everyone new who messages becomes a lead. Off: leads are added by hand only.' },
    { key: 'leads.maxAutoPerDay', service: 'leads', group: 'Limits', type: 'int', default: 0, min: 0, max: 1_000_000, unlimitedAt: 0,
      label: 'Leads made from chats a day', hint: 'More new chats than this in a day are not turned into leads. 0 = no limit.' },
]);
