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

/** The inspector cursor snaps to this: finer than anyone can aim on a 24h strip. */
export const CURSOR_STEP = 5 * 60_000;

/** `at` rounded to the nearest 5 minutes of the local day that starts at `dayStart`. */
export const snapToStep = (at: number, dayStart: number): number =>
  dayStart + Math.round((at - dayStart) / CURSOR_STEP) * CURSOR_STEP;

/** What a tooltip says about one minute, or one window, of the quiet-time day. */
export interface TipInfo {
  /** "11:39" under the cursor; "Now" at the pin; "Tomorrow" for a window's own chip. */
  readonly time: string;
  readonly tone: 'quiet' | 'sending';
  /** The window the minute falls in; null while sending between windows. */
  readonly key: number | null;
  /** "Quiet time · 11:39–14:23 · 2h 44m", or "Sending". */
  readonly title: string;
  /** "ends in 1h 12m", "ended 40m ago", "next quiet time 17:11 · in 3h 5m". */
  readonly note: string;
  /** The same as one sentence for a live region (no middle dots to be read aloud). */
  readonly speech: string;
}

/** Countdowns round up and "ago" rounds down, never below a minute, so a ticking readout never shows 0m. */
const ahead = (ms: number): string => durationLabel(Math.max(1, Math.ceil(ms / 60_000)));
const behind = (ms: number): string => durationLabel(Math.max(1, Math.floor(ms / 60_000)));

/** "17:11", plus "tomorrow" / "yesterday" when it falls outside the local day `now` is in. */
function clockOn(at: number, now: number): string {
  const day = at < localDayStart(now) ? ' yesterday' : at >= localDayEnd(now) ? ' tomorrow' : '';
  return localClock(at) + day;
}

function tipInfo(time: string, key: number | null, title: string, note: string): TipInfo {
  return {
    time,
    tone: key === null ? 'sending' : 'quiet',
    key,
    title,
    note,
    speech: `${time}. ${title}. ${note}.`.replaceAll(' · ', ', '),
  };
}

function windowFacts(w: QuietSlot, now: number): { title: string; note: string } {
  const span = durationLabel(Math.round((w.endAt - w.startAt) / 60_000));
  return {
    title: `Quiet time · ${w.label}${w.day ? ` ${w.day}` : ''} · ${span}`,
    note:
      w.state === 'now'
        ? `ends in ${ahead(w.endAt - now)}`
        : w.state === 'done'
          ? `ended ${behind(now - w.endAt)} ago`
          : `starts in ${ahead(w.startAt - now)} · ends in ${ahead(w.endAt - now)}`,
  };
}

/**
 * Tooltip text for a window on its own (a chip, a row in the health card). The state comes from
 * `w.state`, which `quietSlots` cut on the same `now`, so it ticks with the store's clock.
 */
export function describeWindow(w: QuietSlot, now: number): TipInfo {
  const time =
    w.state === 'now' ? 'Now' : w.day ? w.day[0].toUpperCase() + w.day.slice(1) : 'Today';
  const { title, note } = windowFacts(w, now);
  return tipInfo(time, w.key, title, note);
}

/**
 * Tooltip text for the minute under the strip's cursor. `slots` must be ascending, as the server
 * sends them. Countdowns are measured from `now` (not from the cursor) so they read true however
 * far the cursor sits from the pin.
 */
export function describeMinute(at: number, slots: readonly QuietSlot[], now: number): TipInfo {
  const atPin = Math.abs(at - now) <= CURSOR_STEP / 2;
  const time = atPin ? 'Now' : localClock(at);
  const inside = slots.find((w) => at >= w.startAt && at < w.endAt);
  if (inside) {
    const { title, note } = windowFacts(inside, now);
    return tipInfo(time, inside.key, title, note);
  }
  const past = !atPin && at < now;
  const prev = past ? slots.filter((w) => w.endAt <= at).at(-1) : undefined;
  const next = slots.find((w) => w.startAt > at);
  const note = prev
    ? `since ${clockOn(prev.endAt, now)}`
    : next
      ? past
        ? `quiet time starts ${clockOn(next.startAt, now)}`
        : `next quiet time ${clockOn(next.startAt, now)} · in ${ahead(next.startAt - now)}`
      : past
        ? 'no quiet time yet today'
        : 'no more quiet time today';
  return tipInfo(time, null, 'Sending', note);
}

/** "Quiet time 11:39 to 14:23, 2 hours 44 minutes": the aria-label of a segment. */
export function windowSpeech(w: QuietSlot): string {
  const m = Math.round((w.endAt - w.startAt) / 60_000);
  const unit = (n: number, name: string): string => `${n} ${name}${n === 1 ? '' : 's'}`;
  const parts = [
    m >= 60 ? unit(Math.floor(m / 60), 'hour') : '',
    m % 60 ? unit(m % 60, 'minute') : '',
  ];
  const day = w.day ? ` ${w.day}` : '';
  return `Quiet time ${localClock(w.startAt)} to ${localClock(w.endAt)}${day}, ${parts.filter(Boolean).join(' ')}`;
}

/** Widest a tooltip gets; the text wraps inside it so a pure function can place it without measuring. */
export const TIP_WIDTH = 264;

export interface TipPlace {
  /** Left edge in px, in the coordinates `lo` / `hi` were given in. */
  readonly left: number;
  readonly width: number;
  /** Where the anchor sits inside the tooltip, in px: the origin its pop-in grows from. */
  readonly origin: number;
}

/**
 * Where a `tip`-px-wide tooltip goes for an anchor at `x` inside the strip `lo`..`hi`: centred on
 * the anchor, flipped to hang off one side of it when centring would spill, then clamped so it can
 * never leave the strip (and shrunk if the strip is narrower than the tooltip).
 */
export function tipPlacement(x: number, tip: number, lo: number, hi: number, gap = 10): TipPlace {
  const width = Math.min(tip, Math.max(0, hi - lo));
  let left = x - width / 2;
  if (left < lo) left = x + gap;
  else if (left + width > hi) left = x - gap - width;
  left = Math.min(Math.max(left, lo), hi - width);
  return { left, width, origin: Math.min(Math.max(x - left, 0), width) };
}
