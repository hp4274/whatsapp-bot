import { Channel } from '../core/api';

/** Human labels for the provider ids the API returns. Unknown ids get a tidy fallback. */
const TRANSPORT_LABELS: Record<
  string,
  { label: string; short: string; icon: string; hint: string; qr: boolean }
> = {
  cloud_api: {
    label: 'WhatsApp Cloud API',
    short: 'Cloud API',
    icon: 'cloud',
    hint: 'Official Meta API - needs an access token',
    qr: false,
  },
  baileys: {
    label: 'WhatsApp QR (Baileys)',
    short: 'WhatsApp QR',
    icon: 'qrcode',
    hint: 'QR login, no browser - sends images, PDFs and videos',
    qr: true,
  },
};

export const titleCase = (id: string) =>
  id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(' ') || 'Unknown';

export function transportMeta(id: string | undefined | null) {
  const key = String(id ?? '');
  return (
    TRANSPORT_LABELS[key] ?? {
      label: titleCase(key),
      short: titleCase(key),
      icon: 'topology-star-3',
      hint: '',
      // An unknown provider is most likely another QR-linked one.
      qr: key.includes('web') || key.includes('qr'),
    }
  );
}

const CAPABILITY_LABELS: Record<string, { label: string; hint: string }> = {
  campaigns: { label: 'Campaigns', hint: 'Bulk broadcasts' },
  transactional_messages: { label: 'Transactional', hint: 'Receipts, OTPs, confirmations' },
  workflow_messages: { label: 'Workflows', hint: 'Automations you build' },
  appointment_reminders: { label: 'Appointment reminders', hint: 'Bookings and PTMs' },
  order_updates: { label: 'Order updates', hint: 'Shipping and status' },
  lead_followups: { label: 'Lead follow-ups', hint: 'Sales nudges' },
  faq: { label: 'FAQ answers', hint: 'Knowledge base replies' },
  auto_replies: { label: 'Auto-replies', hint: 'Keyword responses' },
  ticketing: { label: 'Ticketing', hint: 'Support conversations' },
  ai: { label: 'AI assistant', hint: 'Generated replies' },
};

export const capabilityMeta = (id: string) =>
  CAPABILITY_LABELS[id] ?? { label: titleCase(id), hint: '' };

export type LiveState = 'connected' | 'connecting' | 'disconnected' | 'disabled';

export function liveState(channel: Channel): LiveState {
  if (channel.status !== 'active') return 'disabled';
  if (channel.health?.connected) return 'connected';
  if (channel.health?.connecting) return 'connecting';
  return 'disconnected';
}

export const LIVE_LABEL: Record<LiveState, string> = {
  connected: 'Connected',
  connecting: 'Connecting',
  disconnected: 'Not connected',
  disabled: 'Disabled',
};

export const WEEKDAYS = [
  { id: 'mon', short: 'Mon', long: 'Monday' },
  { id: 'tue', short: 'Tue', long: 'Tuesday' },
  { id: 'wed', short: 'Wed', long: 'Wednesday' },
  { id: 'thu', short: 'Thu', long: 'Thursday' },
  { id: 'fri', short: 'Fri', long: 'Friday' },
  { id: 'sat', short: 'Sat', long: 'Saturday' },
  { id: 'sun', short: 'Sun', long: 'Sunday' },
];

/** "Mon-Fri", "Every day", "Mon, Wed, Fri". */
export function describeDays(days: string[] | undefined): string {
  const ids = WEEKDAYS.map((d) => d.id);
  const set = new Set((days ?? []).map((d) => d.toLowerCase().slice(0, 3)));
  if (!days?.length || set.size === 7) return 'Every day';
  const idx = ids.map((id, i) => (set.has(id) ? i : -1)).filter((i) => i >= 0);
  const contiguous = idx.every((v, i) => i === 0 || v === idx[i - 1] + 1);
  if (contiguous && idx.length > 2)
    return `${WEEKDAYS[idx[0]].short}-${WEEKDAYS[idx[idx.length - 1]].short}`;
  return idx.map((i) => WEEKDAYS[i].short).join(', ');
}

const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] })
  .supportedValuesOf;
const ZONES: string[] = (() => {
  const list = supported ? supported('timeZone') : [];
  return list.includes('UTC') ? list : ['UTC', ...list];
})();

/** Every IANA zone the browser knows, plus `current` if it is somehow missing. */
export function timeZones(current?: string): string[] {
  return current && !ZONES.includes(current) ? [current, ...ZONES] : ZONES;
}

export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** The weekday and HH:MM it is right now in `zone`. */
export function nowIn(
  zone: string,
  at = new Date(),
): { day: string; time: string; minutes: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone || 'UTC',
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return {
      day: get('weekday').toLowerCase().slice(0, 3),
      time: `${hour}:${get('minute')}`,
      minutes: Number(hour) * 60 + Number(get('minute')),
    };
  } catch {
    return { day: '', time: '--:--', minutes: -1 };
  }
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':');
  return Number(h) * 60 + Number(m || 0);
};
