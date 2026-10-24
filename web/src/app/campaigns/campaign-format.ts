/** Small formatting helpers shared by the campaign list and detail views. */

import type { CampaignStatus } from '../core/api';

export const STATUS_LABEL: Record<CampaignStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  running: 'Running',
  paused: 'Paused',
  done: 'Done',
  cancelled: 'Cancelled',
};

export function localTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "in 2h", "5m ago", "just now". */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return '';
  const diff = at - now;
  const abs = Math.abs(diff);
  const minute = 60_000;
  // Under a minute away: count the seconds, so a start time reads "in 5s", "in 4s", ...
  if (abs < minute) return diff > 1000 ? `in ${Math.ceil(abs / 1000)}s` : 'just now';
  const units: [number, string][] = [
    [86_400_000, 'd'],
    [3_600_000, 'h'],
    [minute, 'm'],
  ];
  const [size, unit] = units.find(([ms]) => abs >= ms) ?? units[2];
  const n = Math.round(abs / size);
  return diff > 0 ? `in ${n}${unit}` : `${n}${unit} ago`;
}

/** `YYYY-MM-DD` on the wall clock of `zone` (the browser's when unset or unknown). */
export function dayKey(at: Date, zone?: string | null): string {
  const fmt = (timeZone?: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  try {
    return fmt(zone || undefined);
  } catch {
    return fmt();
  }
}

/** Whole days from `a` to `b`, both `YYYY-MM-DD`. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export function percent(part: number, whole: number): number {
  if (!whole || whole <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((part / whole) * 1000) / 10));
}

export function canStart(s: CampaignStatus) {
  return s === 'draft' || s === 'scheduled';
}
export function canPause(s: CampaignStatus) {
  return s === 'running';
}
export function canResume(s: CampaignStatus) {
  return s === 'paused';
}
export function canCancel(s: CampaignStatus) {
  return s === 'running' || s === 'paused' || s === 'scheduled';
}
export function canDelete(s: CampaignStatus) {
  return s === 'draft' || s === 'done' || s === 'cancelled';
}

/* ------------------------------------------------------------------------------------------------
 * Report numbers. One definition of every rate, shared by the campaign list, the campaign detail
 * and the analytics table, so "98% delivered" means the same thing on every screen. They match the
 * server's analytics definitions:
 *   attempted = sent + failed      (everything that left the queue)
 *   delivered % = delivered / attempted   (failures count against it)
 *   read %      = read / delivered        (WhatsApp's own definition)
 *   replied %   = replied / delivered
 *   failed %    = failed / attempted
 * ---------------------------------------------------------------------------------------------- */

/** Per-recipient delivery states in plain words. */
export const RECIPIENT_STATUS_LABEL: Readonly<Record<string, string>> = {
  QUEUED: 'Waiting',
  SENDING: 'Sending',
  SENT: 'Sent',
  DELIVERED: 'Delivered',
  READ: 'Read',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  SANDBOX: 'Test send',
  NOT_ON_WHATSAPP: 'Not on WhatsApp',
};

/** Human label for a campaign status or a recipient status; unknown values pass through. */
export function statusLabel(status: string): string {
  return (
    STATUS_LABEL[status as CampaignStatus] ??
    RECIPIENT_STATUS_LABEL[status.toUpperCase()] ??
    status.toLowerCase()
  );
}

/** 1240 -> "1,240"; null or non-finite -> "-". */
export function count(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '-';
}

/** 52.3 -> "52.3%", 50 -> "50%", null -> "-". One decimal at most, everywhere. */
export function pct(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

/** The counts every report has, whatever screen it comes from. */
export interface ReportCounts {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  replied?: number;
}

/** Rates as percentages (one decimal), or null when their base is still 0. */
export interface ReportRates {
  attempted: number;
  delivered: number | null;
  read: number | null;
  replied: number | null;
  failed: number | null;
}

export function reportRates(c: ReportCounts): ReportRates {
  const attempted = c.sent + c.failed;
  const of = (part: number, whole: number) => (whole > 0 ? percent(part, whole) : null);
  return {
    attempted,
    delivered: of(c.delivered, attempted),
    read: of(c.read, c.delivered),
    replied: of(c.replied ?? 0, c.delivered),
    failed: of(c.failed, attempted),
  };
}

/** What the list knows about a campaign from its stored stats (no per-recipient read). */
export function listCounts(stats: {
  total?: number;
  pending?: number;
  failed?: number;
  sent?: number;
  byStatus?: Record<string, number>;
} | null | undefined): ReportCounts & { total: number; pending: number } {
  const by = stats?.byStatus ?? {};
  const sent =
    typeof stats?.sent === 'number'
      ? stats.sent
      : (by['SENT'] ?? 0) + (by['DELIVERED'] ?? 0) + (by['READ'] ?? 0) + (by['SANDBOX'] ?? 0);
  return {
    total: stats?.total ?? 0,
    pending: stats?.pending ?? (by['QUEUED'] ?? 0) + (by['SENDING'] ?? 0),
    sent,
    delivered: (by['DELIVERED'] ?? 0) + (by['READ'] ?? 0),
    read: by['READ'] ?? 0,
    failed: stats?.failed ?? by['FAILED'] ?? 0,
  };
}

export type OutcomeTone = 'ok' | 'info' | 'warn' | 'bad' | 'mute';

/** The one-line answer to "did my campaign work?", shown above the detailed numbers. */
export interface Outcome {
  tone: OutcomeTone;
  icon: string;
  title: string;
  detail: string;
}

export function outcome(
  status: CampaignStatus,
  audience: number,
  c: ReportCounts & { pending?: number },
): Outcome {
  const r = reportRates(c);
  const failed = c.failed ? ` · ${count(c.failed)} failed` : '';
  const reach = `${count(c.delivered)} of ${count(r.attempted || audience)} delivered${failed}`;
  const engagement = [
    r.read !== null ? `${pct(r.read)} of delivered read it` : '',
    c.replied ? `${count(c.replied)} replied` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const left = Math.max(0, audience - r.attempted);

  if (status === 'draft')
    return { tone: 'mute', icon: 'pencil', title: 'Not sent yet', detail: 'This campaign is a draft. Start it when you are ready.' };
  if (status === 'scheduled' && !r.attempted)
    return { tone: 'warn', icon: 'clock', title: 'Scheduled, nothing sent yet', detail: `${count(audience)} recipients will get it at the scheduled time.` };
  if (status === 'running' || (status === 'scheduled' && r.attempted))
    return {
      tone: 'info',
      icon: 'send',
      title: `Sending: ${count(r.attempted)} of ${count(audience)} done${failed}`,
      detail: [`${count(c.delivered)} delivered so far`, left ? `${count(left)} still to go` : '']
        .filter(Boolean)
        .join(' · '),
    };
  if (!r.attempted)
    return {
      tone: 'mute',
      icon: status === 'cancelled' ? 'ban' : 'player-pause',
      title: status === 'cancelled' ? 'Cancelled before anything was sent' : 'Paused before anything was sent',
      detail: status === 'paused' ? 'Resume it to start sending.' : 'Nothing went out.',
    };
  const mostlyFailed = (r.failed ?? 0) >= 50;
  return {
    tone: mostlyFailed ? 'bad' : c.failed ? 'warn' : 'ok',
    icon: mostlyFailed ? 'alert-triangle' : c.failed ? 'alert-circle' : 'circle-check',
    title: reach,
    detail: [
      engagement,
      status === 'paused' && left ? `Paused with ${count(left)} still to send` : '',
      status === 'cancelled' && left ? `Cancelled, ${count(left)} never sent` : '',
    ]
      .filter(Boolean)
      .join(' · ') || 'Read receipts appear here as recipients open the message.',
  };
}
