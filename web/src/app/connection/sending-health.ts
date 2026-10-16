import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import { Api, SafetyEvent, SafetyHealth, SafetyStatus } from '../core/api';
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
 * next, today's budget and rest window, and the block / report rate with who
 * and when.
 *
 * Blocks are inferred (a message stuck at one tick for 12 hours), because
 * WhatsApp never tells a sender they were blocked. The copy says "may have".
 */
@Component({
  selector: 'app-sending-health',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './sending-health.html',
  styleUrl: './sending-health.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  /** When tonight's rest ends on this browser's clock; the server only says how long was left when it answered. */
  private readonly restEndsAt = signal(0);
  protected readonly restLeftMinutes = computed(
    () => Math.max(0, this.restEndsAt() - this.store.now()) / 60_000,
  );

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
        this.restEndsAt.set(Date.now() + (safety.quiet?.active ? safety.quiet.leftSeconds * 1000 : 0));
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  /** 125 minutes after midnight -> "02:05". */
  protected clock(minute: number): string {
    const h = Math.floor(minute / 60) % 24;
    return `${String(h).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  }

  protected duration(minutes: number): string {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes % 60);
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  }

  protected label(event: SafetyEvent): string {
    return event.kind === 'block' ? 'May have blocked you' : 'Complained';
  }
}
