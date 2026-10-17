import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import { Api, SafetyEvent, SafetyHealth, SafetyStatus } from '../core/api';
import { QuietTip, type TipAnchor, anchorBelow, isHovered, tipLayout } from '../core/quiet-tip';
import {
  type QuietSlot,
  describeWindow,
  durationLabel,
  quietSlots,
  windowSpeech,
} from '../core/quiet-time';
import { Store } from '../core/store';

/**
 * The staircase drawn on screen. The numbers mirror TIERS in the server's
 * campaign/humanize.js; the live tier and its progress always come from the
 * server, so a stale label here can never change what is enforced.
 */
const TIER_STEPS: readonly { readonly n: number; readonly perDay: string }[] = [
  { n: 1, perDay: '250' },
  { n: 2, perDay: '2,000' },
  { n: 3, perDay: '10,000' },
];

/**
 * How healthy the sending number is: which tier it is on and how far from the
 * next, today's budget and quiet-time windows, and the block / report rate with who
 * and when.
 *
 * Blocks are inferred (a message stuck at one tick for 24 hours), because
 * WhatsApp never tells a sender they were blocked. The copy says "may have".
 */
@Component({
  selector: 'app-sending-health',
  imports: [DatePipe, DecimalPipe, QuietTip],
  templateUrl: './sending-health.html',
  styleUrl: './sending-health.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'outside($event)' },
})
export class SendingHealth {
  private readonly api = inject(Api);
  private readonly store = inject(Store);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly health = signal<SafetyHealth | null>(null);
  protected readonly safety = signal<SafetyStatus | null>(null);

  protected readonly steps = TIER_STEPS;
  protected readonly tier = computed(() => this.safety()?.tier ?? null);
  protected readonly quiet = computed(() => this.safety()?.quiet ?? null);
  /** Today's windows in local time, judged against the server's clock so they tick on their own. */
  protected readonly slots = computed(() => {
    const q = this.quiet();
    return q ? quietSlots(q.windows, this.store.serverNow()) : [];
  });
  protected readonly resting = computed(() => this.slots().find((s) => s.state === 'now') ?? null);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  /** Window whose row has the pointer or focus, and where its tooltip hangs. */
  private readonly spot = signal<(TipAnchor & { readonly key: number }) | null>(null);
  /** A click froze the tooltip so touch users, who cannot hover, can read it. */
  protected readonly pinned = signal(false);
  /** Same words as the Campaigns strip, from the same helper, counting down on the same clock. */
  protected readonly tip = computed(() => {
    const w = this.slots().find((x) => x.key === this.spot()?.key);
    return w ? describeWindow(w, this.store.serverNow()) : null;
  });
  protected readonly lit = computed(() => this.tip()?.key ?? null);
  private readonly layout = tipLayout(this.spot);
  protected readonly place = this.layout.place;
  protected readonly tipTop = this.layout.top;
  protected readonly speech = windowSpeech;

  /** Share of the way to the next tier, 0-100. */
  protected readonly climb = computed(() => {
    const tier = this.tier();
    return tier?.nextTierAt ? Math.min(100, (tier.weekSent / tier.nextTierAt) * 100) : 100;
  });

  protected readonly usedPercent = computed(() => {
    const s = this.safety();
    return s?.limit ? Math.min(100, (s.used / s.limit) * 100) : 0;
  });

  /** Blocks + reports against the line where a campaign pauses itself. */
  protected readonly riskPercent = computed(() => {
    const h = this.health();
    if (!h?.pauseAtPercent) return 0;
    return Math.min(100, ((h.blockRatePercent + h.reportRatePercent) / h.pauseAtPercent) * 100);
  });

  protected readonly riskTone = computed(() => {
    const risk = this.riskPercent();
    return risk >= 100 ? 'tone-bad' : risk >= 50 ? 'tone-warn' : 'tone-ok';
  });

  constructor() {
    this.load();
    // The numbers move with sends and with the connection; reload on either.
    this.store.watch(['connection', 'history', 'stats'], () => this.load(false));
  }

  protected load(showSkeleton = true): void {
    if (showSkeleton) this.loading.set(true);
    this.error.set(null);
    this.api.safetyHealth().subscribe({
      next: ({ health, safety }) => {
        this.health.set(health);
        this.safety.set(safety);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected readonly duration = durationLabel;

  /** Hover or focus on a window row; ignored while another is pinned. */
  protected show(w: QuietSlot, e: Event): void {
    if (!this.pinned()) this.point(w, e.currentTarget as Element);
  }

  /** Touch fires a leave right after every tap, before the click that pins; that one is ignored. */
  protected hide(e?: PointerEvent): void {
    if (!this.pinned() && e?.pointerType !== 'touch') this.spot.set(null);
  }

  protected close(): void {
    this.pinned.set(false);
    this.spot.set(null);
  }

  /** A click pins a row's tooltip (the only way in on touch); clicking it again lets go. */
  protected pin(w: QuietSlot, e: MouseEvent): void {
    const el = e.currentTarget as Element;
    if (this.pinned() && this.lit() === w.key) {
      this.pinned.set(false);
      if (!isHovered(el)) this.spot.set(null);
      return;
    }
    this.point(w, el);
    this.pinned.set(true);
  }

  /** A tap or click outside the card closes a pinned tooltip. */
  protected outside(e: Event): void {
    if (this.spot() && !this.card()?.nativeElement.contains(e.target as Node)) this.close();
  }

  private point(w: QuietSlot, el: Element): void {
    const card = this.card()?.nativeElement;
    if (card) this.spot.set({ ...anchorBelow(card, el), key: w.key });
  }

  protected label(event: SafetyEvent): string {
    return event.kind === 'block' ? 'May have blocked you' : 'Complained';
  }
}
