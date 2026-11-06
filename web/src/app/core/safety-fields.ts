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
    title: 'Daily limit',
    fields: [
      {
        key: 'dailyLimit',
        label: 'Messages per day',
        help: "Most per number (0 = use your plan's limit). A number's daily limit grows as people reply; this can only lower it",
      },
    ],
  },
  {
    title: 'Pacing between messages',
    fields: [
      {
        key: 'minDelaySeconds',
        label: 'Shortest gap between messages (seconds)',
        help: "0 = the number's own gap. A value here can only slow it down",
      },
      {
        key: 'maxDelaySeconds',
        label: 'Longest gap between messages (seconds)',
        help: "0 = the number's own gap. A value only ever slows it",
      },
      { key: 'restEvery', label: 'Rest every N messages', help: '0 = never rest', qrIgnored: true },
      { key: 'restMinMinutes', label: 'Rest min (min)', help: 'Shortest long pause', qrIgnored: true },
      { key: 'restMaxMinutes', label: 'Rest max (min)', help: 'Longest long pause', qrIgnored: true },
    ],
  },
  {
    title: 'Speed and retries',
    fields: [
      {
        key: 'rateLimitPerSecond',
        label: 'Messages per second (max)',
        help: 'The most that go out in any one second',
        step: 0.1,
      },
      { key: 'rateLimitBurst', label: 'Short burst allowed', help: 'How many can go out at once after a quiet spell' },
      { key: 'maxRetries', label: 'Tries after a failed send', help: 'How many times a failed message is tried again' },
      { key: 'retryDelay', label: 'Wait before the first retry (seconds)', help: 'Then each wait grows', step: 0.5 },
      { key: 'retryBackoff', label: 'Wait longer after each failure (×)', help: '2 doubles the wait each time', step: 0.5 },
      { key: 'retryMaxDelay', label: 'Longest wait before a retry (seconds)', help: 'Waits never grow past this' },
      { key: 'retryJitter', label: 'Random variation in gaps (0-1)', help: 'Varies each retry wait a little', step: 0.05 },
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
        label: 'Campaign messages per person per day',
        help: 'Replies never count. 0 = off. QR numbers: always 1',
      },
      {
        key: 'requireVariationAbove',
        label: 'Require word choices or {name} above this many people',
        help: '0 = off. QR numbers: never above 15',
      },
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
