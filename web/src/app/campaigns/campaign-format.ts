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
