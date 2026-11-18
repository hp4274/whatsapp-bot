/**
 * Platform rules for Tickets on WhatsApp: opening tickets from chats, replying from a ticket, the open-ticket cap and
 * auto-close. See `index.js` for the field shape. The defaults are what Tickets did before these rules existed.
 */

export const TICKET_POLICY = Object.freeze([
    { key: 'tickets.autoCreate', service: 'tickets', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Open tickets from WhatsApp chats',
      hint: 'When a customer asks for a person or uses a complaint word, if the business turns it on. Off: tickets are only made by hand.' },
    { key: 'tickets.allowCustomerReply', service: 'tickets', group: 'WhatsApp', type: 'bool', default: true,
      label: 'Let the team reply to the customer from a ticket', hint: 'Off: a ticket shows the chat but cannot send.' },
    { key: 'tickets.maxOpen', service: 'tickets', group: 'Limits', type: 'int', default: 0, min: 0, max: 1_000_000, unlimitedAt: 0,
      label: 'Open tickets per business', hint: 'Tickets not yet resolved or closed. 0 = no limit.' },
    { key: 'tickets.autoCloseDays', service: 'tickets', group: 'Response time', type: 'int', default: 0, min: 0, max: 365, unlimitedAt: 0,
      label: 'Close resolved tickets after (days)', hint: 'A resolved ticket nobody touches is closed after this. 0 = never.' },
]);
