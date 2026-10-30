import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { type Campaign, type CampaignStatus, CampaignsApi } from '../core/api';
import { QuietTip, type TipAnchor, anchorBelow, isHovered, tipLayout } from '../core/quiet-tip';
import {
  CURSOR_STEP,
  type QuietSlot,
  describeMinute,
  describeWindow,
  durationLabel,
  localClock,
  localDayEnd,
  localDayStart,
  quietSlots,
  snapToStep,
  windowSpeech,
} from '../core/quiet-time';
import { Store } from '../core/store';
import {
  canCancel,
  canDelete,
  canPause,
  canResume,
  canStart,
  count,
  listCounts,
  localTime,
  pct,
  percent,
  relativeTime,
  reportRates,
} from './campaign-format';
import { CampaignStatusPill } from './status-pill';

type Filter = 'all' | CampaignStatus;
type RowAction = 'start' | 'pause' | 'resume' | 'cancel' | 'delete';

/** A quiet window placed on today's local bar; `from` / `span` are percentages of the day. */
interface BarWindow extends QuietSlot {
  readonly onBar: boolean;
  readonly from: number;
  readonly span: number;
  readonly backIn: string;
  readonly speech: string;
}

/** What the tooltip points at: a minute on the bar, or (`at` null) one window's chip. */
interface Spot extends TipAnchor {
  readonly at: number | null;
  /** The chip's window; only set when `at` is null. */
  readonly key: number | null;
  readonly barWidth: number;
}

/** Chip order follows what an operator checks first: what is queued, then what is moving. */
const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'running', label: 'Running' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Done' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'draft', label: 'Draft' },
];

/**
 * Every campaign for the active workspace, newest first.
 *
 * Filtering and search are client-side because the list is small and already
 * loaded; the store's change feed triggers a reload so running campaigns stay
 * current. Cancel and delete need a second click on the same button instead of
 * a dialog, and the confirmation resets on blur.
 */
@Component({
  selector: 'app-campaigns-list',
  imports: [RouterLink, CampaignStatusPill, QuietTip],
  templateUrl: './campaigns-list.html',
  styleUrl: './campaigns-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'outside($event)' },
})
export class CampaignsListView {
  private readonly api = inject(CampaignsApi);
  private readonly store = inject(Store);

  protected readonly filters = FILTERS;
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly filter = signal<Filter>('all');
  protected readonly search = signal('');
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  /** Row id + action awaiting its second click. */
  protected readonly confirming = signal<{ id: number; action: RowAction } | null>(null);
  protected readonly busy = signal<number | null>(null);

  protected readonly counts = computed(() => {
    const out: Record<string, number> = { all: 0 };
    for (const c of this.campaigns()) {
      out['all']++;
      out[c.status] = (out[c.status] ?? 0) + 1;
    }
    return out;
  });

  protected readonly visible = computed(() => {
    const f = this.filter();
    const q = this.search().trim().toLowerCase();
    return this.campaigns()
      .filter((c) => f === 'all' || c.status === f)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.id) === q);
  });

  protected readonly pageSize = 10;
  protected readonly page = signal(0);
  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.visible().length / this.pageSize)),
  );
  /** Clamped here so a shrinking list (filter, delete) never leaves an empty page. */
  protected readonly pageIndex = computed(() => Math.min(this.page(), this.pageCount() - 1));
  protected readonly offset = computed(() => this.pageIndex() * this.pageSize);
  protected readonly rows = computed(() =>
    this.visible().slice(this.offset(), this.offset() + this.pageSize),
  );
  protected readonly from = computed(() => (this.visible().length ? this.offset() + 1 : 0));
  protected readonly to = computed(() => Math.min(this.visible().length, this.offset() + this.pageSize));

  /**
   * Today's quiet windows on the viewer's own local day: the server sends absolute instants (its
   * channel zone may differ from this browser's), so labels, the 00:00-24:00 bar and the "now" pin
   * are all in local time. The pin and the readout tick with `store.serverNow` (every second) so
   * the pin matches the server's idea of the windows even if this browser's clock is off.
   * Windows entirely outside the local day (the channel's day spills over it) stay as chips only.
   * Null when the tier system is off.
   */
  protected readonly quiet = computed(() => {
    const q = this.store.safety()?.quiet;
    if (!q?.windows?.length) return null;
    const now = this.store.serverNow();
    const dayStart = localDayStart(now);
    const dayLength = localDayEnd(now) - dayStart;
    const windows: BarWindow[] = quietSlots(q.windows, now).map((w) => {
      const from = Math.max(w.startAt, dayStart);
      const to = Math.min(w.endAt, dayStart + dayLength);
      return {
        ...w,
        onBar: to > from,
        from: ((from - dayStart) / dayLength) * 100,
        span: ((to - from) / dayLength) * 100,
        backIn: durationLabel(w.minutesLeft),
        speech: windowSpeech(w),
      };
    });
    return {
      windows,
      dayStart,
      dayLength,
      total: durationLabel(q.minutesToday),
      marker: ((now - dayStart) / dayLength) * 100,
      clock: localClock(now, true),
      summary: windows.map((w) => w.label + (w.day ? ` ${w.day}` : '')).join(', '),
    };
  });

  private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');
  private readonly bar = viewChild<ElementRef<HTMLElement>>('bar');

  /**
   * The quiet-time inspector. One tooltip serves the bar's cursor, the chips and the segments, so
   * every way in (pointer, touch, keyboard) lands on the same `spot`; the text is derived from it
   * and `serverNow`, which is why a countdown keeps ticking under a still cursor.
   */
  private readonly spot = signal<Spot | null>(null);
  /** Window whose chip the pointer or focus is on; lights its segment (and the reverse via the spot). */
  private readonly hot = signal<number | null>(null);
  /** A click froze the tooltip in place so touch users, who cannot hover, can read it. */
  protected readonly pinned = signal(false);
  /** The cursor was last moved by keys or focus: only then is the text mirrored to a live region. */
  private readonly byKeys = signal(false);

  protected readonly tip = computed(() => {
    const s = this.spot();
    const q = this.quiet();
    if (!s || !q) return null;
    const now = this.store.serverNow();
    if (s.at !== null) return describeMinute(s.at, q.windows, now);
    const w = q.windows.find((x) => x.key === s.key);
    return w ? describeWindow(w, now) : null;
  });

  /** Window under the cursor or chip: its chip and segment light up, the rest step back. */
  protected readonly lit = computed(() => this.hot() ?? this.tip()?.key ?? null);
  protected readonly pinKey = computed(() => (this.pinned() ? (this.tip()?.key ?? null) : null));

  /** Where the cursor line sits, % of the day; null while the tooltip points at a chip. */
  protected readonly cursor = computed(() => {
    const s = this.spot();
    const q = this.quiet();
    return s && s.at !== null && q ? ((s.at - q.dayStart) / q.dayLength) * 100 : null;
  });

  private readonly layout = tipLayout(this.spot);
  protected readonly place = this.layout.place;
  protected readonly tipTop = this.layout.top;

  /**
   * How far the lit segment leans toward the cursor. CSS only draws it on fine pointers. The angle
   * shrinks as the segment widens so the far end always sits about the same depth from the near one.
   */
  protected readonly tilt = computed(() => {
    const s = this.spot();
    const at = this.cursor();
    const w = this.quiet()?.windows.find((x) => x.key === this.lit());
    if (!s || at === null || !w?.onBar) return '0deg';
    const lean = Math.max(-1, Math.min(1, (at - (w.from + w.span / 2)) / (w.span / 2)));
    const px = (w.span / 100) * s.barWidth;
    return `${(lean * Math.min(9, 1400 / px)).toFixed(1)}deg`;
  });

  /** Read aloud only when the cursor moves, never on the minute tick, and only for keyboard users. */
  protected readonly live = computed(() => {
    this.spot();
    return this.byKeys() ? untracked(() => this.tip()?.speech ?? '') : '';
  });

  protected readonly canStart = canStart;
  protected readonly canPause = canPause;
  protected readonly canResume = canResume;
  protected readonly canCancel = canCancel;
  protected readonly canDelete = canDelete;
  protected readonly localTime = localTime;
  protected readonly count = count;
  protected readonly pct = pct;

  constructor() {
    this.load();
    this.store.watch(['campaigns', 'campaign', 'history'], () => this.load());
  }

  protected goTo(page: number): void {
    this.page.set(Math.min(Math.max(0, page), this.pageCount() - 1));
  }

  /** Filter or search changed: back to the first page. */
  protected setFilter(f: Filter): void {
    this.filter.set(f);
    this.page.set(0);
  }

  protected setSearch(q: string): void {
    this.search.set(q);
    this.page.set(0);
  }

  /** The pointer moves the cursor unless a click pinned the tooltip. */
  protected move(e: PointerEvent): void {
    if (this.pinned()) return;
    this.byKeys.set(false);
    this.aim(e.clientX);
  }

  /**
   * Pointer down is the click for anything on the bar: touch has no hover, so a tap must both
   * place the cursor and pin it. Pressing the spot that is already pinned lets go of it; pressing
   * anywhere else moves the pin there.
   */
  protected press(e: PointerEvent): void {
    if (e.button !== 0) return;
    const before = this.pinned() ? this.tip() : null;
    this.byKeys.set(false);
    this.aim(e.clientX);
    const now = this.tip();
    const same =
      !!before &&
      !!now &&
      (before.key !== null ? before.key === now.key : before.time === now.time);
    this.pinned.set(!same);
    if (same && e.pointerType === 'touch') this.hide();
  }

  protected leave(e: PointerEvent): void {
    if (e.pointerType !== 'touch' && !this.pinned() && !this.byKeys()) this.spot.set(null);
  }

  /** Left / Right step the cursor 15 minutes (Shift: an hour); Home / End jump to the day's ends. */
  protected key(e: KeyboardEvent): void {
    const q = this.quiet();
    const step = (e.shiftKey ? 12 : 3) * CURSOR_STEP;
    if (!q) return;
    const from = this.spot()?.at ?? this.store.serverNow();
    const jump: Partial<Record<string, number>> = {
      ArrowRight: from + step,
      ArrowLeft: from - step,
      Home: q.dayStart,
      End: q.dayStart + q.dayLength,
    };
    const to = jump[e.key];
    if (to === undefined) return;
    e.preventDefault();
    this.byKeys.set(true);
    this.put(snapToStep(to, q.dayStart));
  }

  protected hide(): void {
    this.spot.set(null);
    this.pinned.set(false);
    this.byKeys.set(false);
  }

  /** Focus leaving the strip ends a keyboard reading; the element that gets focus next restarts it. */
  protected blurred(): void {
    if (this.byKeys() && !this.pinned()) this.hide();
  }

  /** A tap or click anywhere outside the strip closes a pinned tooltip. */
  protected outside(e: Event): void {
    if (this.spot() && !this.strip()?.nativeElement.contains(e.target as Node)) this.hide();
  }

  protected hoverChip(w: BarWindow, e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    this.hot.set(w.key);
    if (this.pinned()) return;
    this.byKeys.set(false);
    this.point(w, e.currentTarget as Element);
  }

  protected leaveChip(): void {
    this.unlight();
    if (!this.pinned() && !this.byKeys()) this.spot.set(null);
  }

  protected focusChip(w: BarWindow, e: FocusEvent): void {
    this.hot.set(w.key);
    this.focusWindow(w, e);
  }

  protected unlight(): void {
    this.hot.set(null);
  }

  /** Tabbing in shows the tooltip like a hover would; a mouse click's focus does not (it pins). */
  protected focusWindow(w: BarWindow, e: FocusEvent): void {
    const el = e.currentTarget as Element;
    if (!el.matches(':focus-visible') || this.pinned()) return;
    this.byKeys.set(true);
    this.point(w, el);
  }

  /**
   * Click on a chip, or Enter / Space on a segment, pins that window's tooltip; again lets go.
   * Mouse clicks on the bar were already handled on pointer down, hence the `detail` check.
   */
  protected pin(w: BarWindow, e: MouseEvent, onBar = false): void {
    if (onBar && e.detail > 0) return;
    const el = e.currentTarget as Element;
    if (this.pinKey() === w.key) {
      this.pinned.set(false);
      if (!isHovered(el)) this.hide();
      return;
    }
    this.byKeys.set(e.detail === 0);
    this.point(w, el);
    this.pinned.set(true);
  }

  /** Aims the cursor at the minute under `clientX`. */
  private aim(clientX: number): void {
    const q = this.quiet();
    const bar = this.bar()?.nativeElement;
    if (!q || !bar) return;
    const r = bar.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    this.put(snapToStep(q.dayStart + frac * q.dayLength, q.dayStart));
  }

  /** Puts the cursor on `at`, kept inside the day. */
  private put(at: number): void {
    const q = this.quiet();
    if (!q) return;
    const last = q.dayStart + q.dayLength - CURSOR_STEP;
    this.spot.set(this.barSpot(Math.min(Math.max(at, q.dayStart), last)));
  }

  private barSpot(at: number): Spot | null {
    const q = this.quiet();
    const strip = this.strip()?.nativeElement;
    const bar = this.bar()?.nativeElement;
    if (!q || !strip || !bar) return null;
    const frac = (at - q.dayStart) / q.dayLength;
    return { ...anchorBelow(strip, bar, frac, 12), at, key: null, barWidth: bar.offsetWidth };
  }

  /**
   * Points the tooltip at a window: on the bar where it is (the pin while it is resting, else its
   * start) when it lies on today's bar, otherwise under its own chip.
   */
  private point(w: BarWindow, el: Element): void {
    const q = this.quiet();
    const strip = this.strip()?.nativeElement;
    if (!q || !strip) return;
    this.spot.set(
      w.onBar
        ? this.barSpot(w.state === 'now' ? this.store.serverNow() : Math.max(w.startAt, q.dayStart))
        : { ...anchorBelow(strip, el), at: null, key: w.key, barWidth: 0 },
    );
  }

  protected load(): void {
    this.loading.set(true);
    this.api.list().subscribe({
      next: ({ campaigns }) => {
        this.campaigns.set(
          [...campaigns].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
        );
        this.error.set('');
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
        this.loaded.set(true);
      },
    });
  }

  protected relative(iso: string | null): string {
    return relativeTime(iso, this.store.now());
  }

  /**
   * The Results cell. Only sent / failed / progress: the list's stats are a snapshot written on
   * status changes, so Delivered / Read (which keep arriving after a run) live on the detail page.
   */
  /** Why the run is paused, held or closed early ("Today's limit reached…"), so nobody has to open each one. */
  protected reason(c: Campaign): string | null {
    return (c.options as { statusReason?: string | null } | undefined)?.statusReason ?? null;
  }

  protected result(c: Campaign) {
    const n = listCounts(c.stats);
    const total = n.total || c.audienceSize || 0;
    // No snapshot yet (`stats: {}` before the first write) means nothing has gone out, not everything.
    const done = n.total ? Math.max(0, n.total - n.pending) : 0;
    const r = reportRates(n);
    return {
      sending: c.status === 'running',
      total,
      done,
      donePct: percent(done, total),
      attempted: r.attempted,
      sent: n.sent,
      failed: n.failed,
      failedPct: r.failed,
    };
  }

  protected isConfirming(id: number, action: RowAction): boolean {
    const c = this.confirming();
    return !!c && c.id === id && c.action === action;
  }

  protected act(c: Campaign, action: RowAction): void {
    const destructive = action === 'cancel' || action === 'delete';
    if (destructive && !this.isConfirming(c.id, action)) {
      this.confirming.set({ id: c.id, action });
      return;
    }
    this.confirming.set(null);
    this.busy.set(c.id);
    const done = {
      next: () => {
        this.busy.set(null);
        this.store.setStatus(`Campaign "${c.name}": ${action} done`, 'primary');
        this.load();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
        this.store.setStatus(err.message, 'danger');
      },
    };
    if (action === 'delete') this.api.remove(c.id).subscribe(done);
    else this.api.action(c.id, action).subscribe(done);
  }
}
