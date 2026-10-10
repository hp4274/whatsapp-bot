/** Platform rules for WhatsApp numbers. See `index.js` for the field shape. */

const S = 'whatsapp_channels';

export const CHANNEL_POLICY = Object.freeze([
    // ------------------------------------------------------------ limits --
    { key: 'channels.maxNumbers', service: S, group: 'Numbers', type: 'int', default: 0, min: 0, max: 1000, unlimitedAt: 0,
      label: 'Maximum numbers', hint: 'How many WhatsApp numbers one business may connect. 0 = no limit.' },
    { key: 'channels.allowCloudApi', service: S, group: 'Numbers', type: 'bool', default: true,
      label: 'Allow Cloud API', hint: 'Official Meta Cloud API numbers.' },
    { key: 'channels.allowBaileys', service: S, group: 'Numbers', type: 'bool', default: true,
      label: 'Allow Baileys (QR login)', hint: 'Unofficial QR-login numbers. Higher ban risk.' },
    { key: 'channels.routing', service: S, group: 'Numbers', type: 'enum', default: 'default',
      options: [
          { value: 'default', label: 'Fixed default number' },
          { value: 'round_robin', label: 'Round-robin' },
          { value: 'quota', label: 'Most quota left' },
      ],
      label: 'Sender rule', hint: 'Which number sends when a business has several.' },

    // ---------------------------------------------- safety for new numbers --
    { key: 'channels.dailyCap', service: S, group: 'Safety defaults for new numbers', type: 'int', default: 250, min: 1, max: 100000,
      label: 'Daily send cap', hint: 'Messages one number may send per day.' },
    { key: 'channels.warmupEnabled', service: S, group: 'Safety defaults for new numbers', type: 'bool', default: true,
      label: 'Warm-up for new numbers', hint: 'Start low and double the cap each day until it reaches the daily cap.' },
    { key: 'channels.warmupStart', service: S, group: 'Safety defaults for new numbers', type: 'int', default: 30, min: 1, max: 10000,
      label: 'Warm-up day-one cap' },
    { key: 'channels.minGapSeconds', service: S, group: 'Safety defaults for new numbers', type: 'int', default: 0, min: 0, max: 3600,
      label: 'Minimum gap between messages (s)', hint: '0 = adaptive: the gap grows with the size of the send.' },
    { key: 'channels.maxGapSeconds', service: S, group: 'Safety defaults for new numbers', type: 'int', default: 0, min: 0, max: 3600,
      label: 'Maximum gap between messages (s)', hint: '0 = adaptive.' },
    { key: 'channels.retryLimit', service: S, group: 'Safety defaults for new numbers', type: 'int', default: 3, min: 0, max: 10,
      label: 'Retry limit', hint: 'Attempts after the first for a retryable failure.' },

    // --------------------------------------------------------- ban guard --
    { key: 'channels.banGuardEnabled', service: S, group: 'Ban-risk guard', type: 'bool', default: true,
      label: 'Auto-pause risky numbers', hint: 'Pause a number when its failure rate or quality crosses the line below.' },
    { key: 'channels.banGuardFailurePct', service: S, group: 'Ban-risk guard', type: 'int', default: 20, min: 1, max: 100,
      label: 'Pause above failure rate (%)', hint: 'Measured over the last 24 hours.' },
    { key: 'channels.banGuardMinSample', service: S, group: 'Ban-risk guard', type: 'int', default: 20, min: 1, max: 10000,
      label: 'Minimum sends before judging', hint: 'So two failures out of three never pause a number.' },
    { key: 'channels.banGuardQuality', service: S, group: 'Ban-risk guard', type: 'enum', default: 'low',
      options: [
          { value: 'off', label: 'Ignore quality rating' },
          { value: 'low', label: 'Pause at LOW (red)' },
          { value: 'medium', label: 'Pause at MEDIUM (yellow) or worse' },
      ],
      label: 'Quality rating threshold', hint: 'Cloud API numbers only; Meta reports the rating.' },

    // ------------------------------------------------------------ health --
    { key: 'channels.offlineAfterMinutes', service: S, group: 'Health', type: 'int', default: 30, min: 1, max: 10080,
      label: 'Flag offline after (min)', hint: 'A number not seen for this long shows as offline in the health view.' },
]);
