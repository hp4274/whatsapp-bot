import { SafetyPolicy } from './api';

/**
 * The anti-ban fields, grouped. Shared by the super admin drawer and the tenant's own controls.
 * `qrIgnored`: a QR number's own sending level sets this (server campaign/safety.js paceFor), so the value
 * does nothing there; the tenant drawer leaves it out and the admin drawer shows it disabled.
 */
export type SafetyField = {
  key: keyof SafetyPolicy;
  label: string;
  help: string;
  step?: number;
  qrIgnored?: boolean;
};

/** Order is the order shown; each field's `help` is the plain-language hint under it. */
export const SAFETY_GROUPS: { title: string; fields: SafetyField[] }[] = [
  {
    title: 'Daily cap',
    fields: [
      {
        key: 'dailyLimit',
        label: 'Messages per day',
        help: "Ceiling per number (0 = the plan's day). A QR number grows its daily limit as people reply; this only lowers it",
      },
    ],
  },
  {
    title: 'Pacing between messages',
    fields: [
      {
        key: 'minDelaySeconds',
        label: 'Min gap (s)',
        help: "0 = the number's own gap. A value only ever slows it",
      },
      {
        key: 'maxDelaySeconds',
        label: 'Max gap (s)',
        help: "0 = the number's own gap. A value only ever slows it",
      },
      { key: 'restEvery', label: 'Rest every N messages', help: '0 = never rest', qrIgnored: true },
      { key: 'restMinMinutes', label: 'Rest min (min)', help: 'Shortest long pause', qrIgnored: true },
      { key: 'restMaxMinutes', label: 'Rest max (min)', help: 'Longest long pause', qrIgnored: true },
    ],
  },
  {
    title: 'Throughput and retries',
    fields: [
      {
        key: 'rateLimitPerSecond',
        label: 'Messages per second',
        help: 'Token-bucket rate',
        step: 0.1,
      },
      { key: 'rateLimitBurst', label: 'Burst', help: 'Sent at once after idle' },
      { key: 'maxRetries', label: 'Max retries', help: 'Attempts on failure' },
      { key: 'retryDelay', label: 'Retry delay (s)', help: 'First wait', step: 0.5 },
      { key: 'retryBackoff', label: 'Backoff factor', help: 'Multiplier per retry', step: 0.5 },
      { key: 'retryMaxDelay', label: 'Max retry wait (s)', help: 'Cap on backoff' },
      { key: 'retryJitter', label: 'Jitter (0-1)', help: 'Randomises retries', step: 0.05 },
    ],
  },
  {
    title: 'Protect the number',
    fields: [
      {
        key: 'failureStopPercent',
        label: 'Pause a campaign above (% failed)',
        help: 'Checked after 20 sends. 0 = never pause',
      },
      {
        key: 'recipientDailyCap',
        label: 'Bulk per recipient per 24h',
        help: 'Replies never count. 0 = off. QR numbers: always 1',
      },
      {
        key: 'requireVariationAbove',
        label: 'Require spintax/{name} above N recipients',
        help: '0 = off. QR numbers: never above 15',
      },
    ],
  },
  {
    title: 'Quiet hours (bulk only, channel timezone)',
    fields: [
      { key: 'quietHoursStart', label: 'Hold from hour (0-23)', help: 'Bulk waits, never fails' },
      { key: 'quietHoursEnd', label: 'Resume at hour (0-23)', help: 'Same as start = off' },
    ],
  },
];

/**
 * Short names for the brakes a QR number can be under (server campaign/humanize.js levelFor), for
 * chips and pills; the server's `text` says the rest. An unknown code shows as itself.
 */
export const BRAKE_LABELS: Readonly<Record<string, string>> = {
  reply_rate: 'Few replies',
  reports: 'Spam reports',
  blocks: 'Blocks',
  failures: 'Failed sends',
  restricted: 'Limited by WhatsApp',
  idle: 'Quiet for a few days',
  ban: 'Recent ban',
  delivery: 'Low delivery',
  stuck: 'Messages stuck on one tick',
  unstable: 'Unstable connection',
};

/** Why a value is risky for a number, or '' when it is not. Advisory only: the server enforces ranges. */
export function safetyRisk(
  key: keyof SafetyPolicy,
  value: unknown,
  policy: Partial<SafetyPolicy> = {},
): string {
  const n = Number(value);
  switch (key) {
    case 'safetyEnabled':
      return value === false
        ? 'All pacing and caps are off. This is the fastest way to get a number banned.'
        : '';
    case 'pacingMode':
      return value === 'fixed' ? 'A fixed rhythm is easy for WhatsApp to spot.' : '';
    // 0 is no ceiling of its own: the plan's day and the number's gradual rise still hold.
    case 'dailyLimit':
      return n > 1000 ? 'Over 1,000 a day is high for most numbers.' : '';
    case 'minDelaySeconds':
      return n > 0 && n < 4 ? 'Gaps under 4 seconds look automated.' : '';
    case 'maxDelaySeconds':
      return n > 0 && n < 6 ? 'A short maximum gap removes most variation.' : '';
    case 'restEvery':
      return n === 0 && policy.pacingMode !== 'fixed' ? 'No long pauses between batches.' : '';
    case 'rateLimitPerSecond':
      return n > 1 ? 'More than 1 message a second is aggressive.' : '';
    case 'rateLimitBurst':
      return n > 5 ? 'Large bursts look like a bot.' : '';
    case 'failureStopPercent':
      return n === 0 ? 'Campaigns keep going even when most messages fail.' : '';
    default:
      return '';
  }
}
