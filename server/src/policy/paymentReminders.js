/**
 * Platform rules for the Payment reminders dues ledger (paymentDues.js). See `index.js` for the field shape.
 * Every default is what a business could do before the rule existed. `paymentReminders.maxPerSend` lives in
 * modules.js with the other modules' first rules.
 */

export const PAYMENT_REMINDER_POLICY = Object.freeze([
    { key: 'paymentReminders.allowUpi', service: 'payment_reminders', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Add a UPI pay link to reminders', hint: 'Off: the business\'s UPI ID is kept, but {upi_link} is left empty.' },
    { key: 'paymentReminders.allowAuto', service: 'payment_reminders', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Send reminders automatically', hint: 'Before the due date, on it and after it until paid. Off: only sends started by hand.' },
    { key: 'paymentReminders.maxFollowUps', service: 'payment_reminders', group: 'Limits', type: 'int', default: 3, min: 0, max: 10,
      label: 'Automatic follow-ups after the due date', hint: 'The most a business can set. 0 = none after the due day.' },
    { key: 'paymentReminders.maxPerMonth', service: 'payment_reminders', group: 'Limits', type: 'int', default: 0, min: 0, max: 10_000_000,
      unlimitedAt: 0, label: 'Reminders a month', hint: 'Sent by hand and automatically together. 0 = no limit.' },
]);
