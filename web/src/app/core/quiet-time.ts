/** 125 minutes after midnight -> "02:05". */
export function clockLabel(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  return `${String(h).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
}

/** 72 minutes -> "1h 12m". */
export function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}

/**
 * An instant (ms epoch) as 24h "HH:MM" in this browser's zone, "HH:MM:SS" with seconds. The
 * windows come from the channel's zone, which may not be the viewer's, so they are shown from
 * absolute instants rather than from the channel's minute-of-day.
 */
export function localClock(at: number, seconds = false): string {
  const d = new Date(at);
  const hhmm = clockLabel(d.getHours() * 60 + d.getMinutes());
  return seconds ? `${hhmm}:${String(d.getSeconds()).padStart(2, '0')}` : hhmm;
}

/** Local midnight at or before `at` (ms epoch). */
export const localDayStart = (at: number): number => new Date(at).setHours(0, 0, 0, 0);

/** The next local midnight after `at`; `setHours(24)` rolls over, so a 23h / 25h DST day stays right. */
export const localDayEnd = (at: number): number => new Date(at).setHours(24, 0, 0, 0);

export interface QuietSlot {
  /** Stable across ticks, for `@for` tracking. */
  readonly key: number;
  readonly startAt: number;
  readonly endAt: number;
  /** "05:30–07:00" in the browser's zone. */
  readonly label: string;
  /** Set when the window starts on another local calendar day than today. */
  readonly day: 'yesterday' | 'tomorrow' | null;
  readonly state: 'done' | 'now' | 'next';
  /** Whole minutes until the window ends, at least 1; only meaningful while `state` is 'now'. */
  readonly minutesLeft: number;
}

/**
 * Today's quiet windows as the viewer reads them: local labels, which local day each belongs to,
 * and where it stands against `now`. One helper so the Campaigns strip and the number-health card
 * can never disagree. `now` is the store's `serverNow`, the same clock the windows were cut on.
 */
export function quietSlots(
  windows: readonly { readonly startAt: number; readonly endAt: number }[],
  now: number,
): QuietSlot[] {
  const dayStart = localDayStart(now);
  const dayEnd = localDayEnd(now);
  return windows.map((w) => ({
    key: w.startAt,
    startAt: w.startAt,
    endAt: w.endAt,
    label: `${localClock(w.startAt)}–${localClock(w.endAt)}`,
    day: w.startAt < dayStart ? 'yesterday' : w.startAt >= dayEnd ? 'tomorrow' : null,
    state: now >= w.endAt ? 'done' : now >= w.startAt ? 'now' : 'next',
    minutesLeft: Math.max(1, Math.ceil((w.endAt - now) / 60_000)),
  }));
}
