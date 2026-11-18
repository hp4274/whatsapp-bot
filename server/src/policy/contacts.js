/**
 * Platform rules for the contact book. See `index.js` for the field shape. Every default is what Contacts did before it
 * had rules (no limit, everything on), so a business notices nothing until the super admin sets a value.
 */

const S = 'contacts';

export const CONTACT_POLICY = Object.freeze([
    { key: 'contacts.maxContacts', service: S, group: 'Limits', type: 'int', default: 0, min: 0, max: 10_000_000, unlimitedAt: 0,
      label: 'Contacts per business', hint: 'Adding, importing and WhatsApp-group imports stop at this. 0 = no limit.' },
    { key: 'contacts.allowGroupImport', service: S, group: 'Importing', type: 'bool', default: true,
      label: 'Import members of WhatsApp groups',
      hint: 'Collecting group members is the most common reason WhatsApp bans a number. Off: the groups button is refused.' },
    { key: 'contacts.allowExport', service: S, group: 'Importing', type: 'bool', default: true,
      label: 'Download contacts as CSV', hint: 'Off: contact and group exports are refused.' },
    { key: 'contacts.allowDateGreetings', service: S, group: 'Greetings', type: 'bool', default: true,
      label: 'Birthday greetings', hint: 'Off: no greeting is sent, whatever the business has set.' },
    { key: 'contacts.maxGreetingsPerDay', service: S, group: 'Greetings', type: 'int', default: 0, min: 0, max: 100000, unlimitedAt: 0,
      label: 'Greetings a day', hint: 'Per business. The rest wait for next year. 0 = no limit.' },
]);
