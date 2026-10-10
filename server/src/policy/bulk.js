/** Platform rules for bulk messages. See `index.js` for the field shape. */

const S = 'bulk_messages';

export const BULK_POLICY = Object.freeze([
    { key: 'bulk.dailyCap', service: S, group: 'Volume', type: 'int', default: 0, min: 0, max: 10000000, unlimitedAt: 0,
      label: 'Daily message cap', hint: 'Across all numbers of one business. 0 = no limit.' },
    { key: 'bulk.monthlyCap', service: S, group: 'Volume', type: 'int', default: 0, min: 0, max: 100000000, unlimitedAt: 0,
      label: 'Monthly message cap', hint: '0 = no limit.' },
    { key: 'bulk.maxRecipients', service: S, group: 'Volume', type: 'int', default: 0, min: 0, max: 1000000, unlimitedAt: 0,
      label: 'Maximum recipients per send', hint: '0 = no limit.' },
    { key: 'bulk.requireOptIn', service: S, group: 'Consent', type: 'bool', default: false,
      label: 'Require opt-in', hint: 'Contacts who have not opted in are skipped.' },
    { key: 'bulk.maxSpeed', service: S, group: 'Speed', type: 'enum', default: 'fast',
      options: [
          { value: 'safe', label: 'Slow' },
          { value: 'balanced', label: 'Normal' },
          { value: 'fast', label: 'Fast' },
      ],
      label: 'Fastest speed allowed', hint: 'Businesses can pick this preset or slower, never faster.' },
    { key: 'bulk.windowEnabled', service: S, group: 'Sending window', type: 'bool', default: false,
      label: 'Restrict sending hours', hint: 'In the recipient’s time zone when known, else the business’s.' },
    { key: 'bulk.windowStart', service: S, group: 'Sending window', type: 'text', default: '09:00',
      label: 'Send from (HH:MM)' },
    { key: 'bulk.windowEnd', service: S, group: 'Sending window', type: 'text', default: '21:00',
      label: 'Send until (HH:MM)' },
    { key: 'bulk.killSwitch', service: S, group: 'Kill switch', type: 'bool', default: false,
      label: 'Stop all bulk sending', hint: 'Platform-wide on the default scope; per business on a business override. Running sends stop at once.' },
]);
