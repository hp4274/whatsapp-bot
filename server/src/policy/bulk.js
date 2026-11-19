/**
 * Platform rules for bulk sending. They sit under the Campaigns service (one service since 2026-11-19); the keys
 * keep their `bulk.` prefix so saved values still apply. See `index.js` for the field shape.
 */

const S = 'campaigns';

export const BULK_POLICY = Object.freeze([
    { key: 'bulk.dailyCap', service: S, group: 'Volume', type: 'int', default: 0, min: 0, max: 10000000, unlimitedAt: 0,
      label: 'Bulk messages a day, all numbers', hint: 'Bulk and campaign sends only, every number of the business together. The per-number day is under Anti-ban. 0 = no limit.' },
    { key: 'bulk.monthlyCap', service: S, group: 'Volume', type: 'int', default: 0, min: 0, max: 100000000, unlimitedAt: 0,
      label: 'Bulk messages a month', hint: "Bulk and campaign sends only. The plan's monthly quota counts every message. 0 = no limit." },
    { key: 'bulk.maxRecipients', service: S, group: 'Volume', type: 'int', default: 0, min: 0, max: 1000000, unlimitedAt: 0,
      label: 'Maximum recipients per send', hint: '0 = no limit.' },
    { key: 'bulk.requireOptIn', service: S, group: 'Consent', type: 'bool', default: false,
      label: 'Require opt-in', hint: 'Contacts who have not opted in are skipped.' },
    { key: 'bulk.windowEnabled', service: S, group: 'Sending window', type: 'bool', default: false,
      label: 'Restrict sending hours', hint: 'Off: bulk goes out at any hour, nights included. On: only between these times, in the recipient’s time zone when known, else the business’s.' },
    { key: 'bulk.windowStart', service: S, group: 'Sending window', type: 'text', default: '09:00',
      label: 'Send from (HH:MM)' },
    { key: 'bulk.windowEnd', service: S, group: 'Sending window', type: 'text', default: '21:00',
      label: 'Send until (HH:MM)' },
    { key: 'bulk.killSwitch', service: S, group: 'Kill switch', type: 'bool', default: false,
      label: 'Stop all bulk sending', hint: 'Platform-wide on the default scope; per business on a business override. Running sends stop at once.' },
]);
