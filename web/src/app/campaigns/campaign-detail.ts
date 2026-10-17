import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { finalize, type Observable } from 'rxjs';

import {
  type Campaign,
  type CampaignAnalytics,
  CampaignsApi,
  type PacingPreset,
} from '../core/api';
import { CampaignPolicy } from '../campaign/policy-api';
import { Store } from '../core/store';
import {
  canCancel,
  dayKey,
  daysBetween,
  localTime,
  percent,
  relativeTime,
} from './campaign-format';
import { CampaignInsights } from './campaign-insights';
import { CampaignRecipients } from './campaign-recipients';
import { CampaignStatusPill } from './status-pill';

/** Pacing presets the engine accepts; changing one applies to the next send, mid-run. */
const SPEEDS: readonly { key: PacingPreset; label: string; icon: string }[] = [
  { key: 'safe', label: 'Safe', icon: 'shield' },
  { key: 'balanced', label: 'Balanced', icon: 'scale' },
  { key: 'fast', label: 'Fast', icon: 'bolt' },
];

/** How often a finished campaign is re-read while Delivered / Read ticks may still be on their way. */
const RECEIPT_POLL_MS = 10_000;
/** Phones that stay off or unread for longer than this are not worth a poll. */
const RECEIPT_WINDOW_MS = 7 * 86_400_000;

/**
 * One campaign: its schedule, live progress and controls, then analytics.
 *
 * Analytics is the primary load because it carries the campaign too; if it
 * fails the campaign is fetched on its own so the controls still work. Live
 * progress comes from the store's engine stats, which describe whichever
 * campaign is running, so it is only shown while this one is.
 */
@Component({
  selector: 'app-campaign-detail',
  imports: [RouterLink, CampaignStatusPill, CampaignInsights, CampaignRecipients],
  templateUrl: './campaign-detail.html',
  styleUrl: './campaign-detail.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // A sleeping tab misses SSE events: ask again the moment it is looked at.
    '(document:visibilitychange)': 'onSeen()',
    '(window:focus)': 'onSeen()',
  },
})
export class CampaignDetailView {
  private readonly api = inject(CampaignsApi);
  protected readonly store = inject(Store);

  /** Route param, bound by withComponentInputBinding. */
  readonly id = input.required<string>();

  protected readonly speeds = SPEEDS;
  /** Plan rules: speeds above the ceiling are shown but disabled. */
  protected readonly policy = inject(CampaignPolicy);
  /**
   * Why the platform paused or stopped this run (auto-pause on failures, the
   * business's message cap, the kill switch, an admin action). Server-written.
   */
  protected readonly statusReason = computed(
    () => (this.campaign()?.options as { statusReason?: string | null } | undefined)?.statusReason ?? null,
  );
  protected readonly campaign = signal<Campaign | null>(null);
  protected readonly analytics = signal<CampaignAnalytics | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly error = signal('');
  /** Which control is in flight; every control disables while any one is. */
  protected readonly busy = signal<string | null>(null);
  protected readonly confirmCancel = signal(false);
  /** When the analytics on screen were read (ms epoch); null until the first answer. */
  protected readonly updatedAt = signal<number | null>(null);
  /** Analytics requests in flight, for the funnel's refresh spinner. */
  protected readonly inflight = signal(0);
  /**
   * Request counter and the newest one applied. Analytics is slow on a big campaign, so an older
   * answer can land after a newer one and put stale counts back; it is dropped instead. An
   * older answer that lands first is still applied, so a busy run never starves the screen.
   */
  private issued = 0;
  private applied = 0;
  private lastAsk = 0;

  protected readonly numericId = computed(() => Number(this.id()));
  protected readonly status = computed(() => this.campaign()?.status ?? 'draft');
  protected readonly pacing = computed<PacingPreset>(
    () => this.campaign()?.options?.pacing ?? 'balanced',
  );
  protected readonly audience = computed(
    () => this.analytics()?.funnel.audience || this.campaign()?.audienceSize || 0,
  );
  protected readonly failedCount = computed(
    () => this.analytics()?.funnel.failed ?? this.campaign()?.stats?.failed ?? 0,
  );
  protected readonly canRetry = computed(() => {
    const s = this.status();
    return this.failedCount() > 0 && (s === 'done' || s === 'cancelled' || s === 'paused');
  });
  protected readonly canCancel = computed(() => canCancel(this.status()));

  /** Live engine progress; only meaningful while this campaign is the running one. */
  protected readonly live = computed(() => {
    if (this.status() !== 'running') return null;
    const s = this.store.stats();
    const total = s.total || this.audience();
    return {
      processed: s.processed,
      total,
      successful: s.successful,
      failed: s.failed,
      pending: s.pending,
      pct: percent(s.processed, total),
    };
  });

  /**
   * Multi-day ("spread") progress, null for a one-off send. The day is counted on
   * the campaign's calendar (the running or next-booked day), not by batches sent,
   * so a skipped day still reads as the day it is.
   */
  protected readonly spread = computed(() => {
    const c = this.campaign();
    const s = c?.options?.spread;
    if (!c || !s?.total) return null;
    const days = daysBetween(s.from, s.to) + 1;
    const at =
      c.status === 'scheduled' && c.scheduledAt
        ? new Date(c.scheduledAt)
        : new Date(this.store.now());
    const day = Math.min(
      days,
      Math.max(1, daysBetween(s.from, dayKey(at, c.options.timezone)) + 1),
    );
    const sent = c.stats?.sent ?? s.cursor ?? 0;
    return { day, days, sent, total: s.total, pct: percent(sent, s.total) };
  });

  /**
   * Today's batch is out and the next one is booked for a later local day, so
   * "start" means "send that one now". The server decides the same way; this
   * only picks the label, so a timezone mismatch costs a wrong word, not a wrong send.
   */
  protected readonly canContinueEarly = computed(() => {
    const c = this.campaign();
    if (c?.status !== 'scheduled' || !c.options?.spread?.cursor || !c.scheduledAt) return false;
    const zone = c.options.timezone;
    return dayKey(new Date(c.scheduledAt), zone) > dayKey(new Date(this.store.now()), zone);
  });

  protected readonly restLeft = computed(() => {
    const min = Math.ceil(this.store.quietLeft() / 60);
    return min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`;
  });

  protected readonly localTime = localTime;
  /** Reads the store's ticking clock, so "in 5s" runs down by itself. */
  protected readonly relativeTime = (iso: string | null | undefined) =>
    relativeTime(iso, this.store.now());

  constructor() {
    this.policy.load();
    effect(() => {
      this.id();
      untracked(() => {
        this.loading.set(true);
        this.campaign.set(null);
        this.analytics.set(null);
        this.updatedAt.set(null);
        this.notFound.set(false);
        // Whatever is still in flight belongs to the previous campaign.
        this.applied = ++this.issued;
        this.reload();
      });
    });
    this.store.watch(['campaigns', 'campaign', 'history', 'analytics'], () => this.reload(), 700);
    // Events sent while the stream was down are gone: read again once it is back.
    let wasOnline = this.store.streamOnline();
    effect(() => {
      const online = this.store.streamOnline();
      if (online && !wasOnline) untracked(() => this.reload());
      wasOnline = online;
    });
    // SSE can drop silently (proxy resets, sleeping tabs), so poll as a backstop: fast while a run
    // is live, and slowly once it is done for as long as Delivered / Read ticks can still arrive.
    const poll = setInterval(() => {
      if (this.loading()) return;
      if (['running', 'paused', 'scheduled'].includes(this.status())) this.reload();
      else if (this.receiptsPending() && document.visibilityState === 'visible'
        && Date.now() - this.lastAsk >= RECEIPT_POLL_MS) this.reload();
    }, 3000);
    inject(DestroyRef).onDestroy(() => clearInterval(poll));
  }

  /**
   * Ticks land minutes to hours after the last send, long after the status says `done`, so
   * "finished" is not "settled": some sends are still short of Read, and recently enough to care.
   */
  private receiptsPending(): boolean {
    const funnel = this.analytics()?.funnel;
    if (!funnel || !['done', 'cancelled', 'paused'].includes(this.status())) return false;
    const ended = Date.parse(this.campaign()?.finishedAt ?? '');
    return funnel.sent > funnel.read && !(Date.now() - ended > RECEIPT_WINDOW_MS);
  }

  /** Tab shown or window focused; both events fire together, so the second is ignored. */
  protected onSeen(): void {
    if (document.visibilityState !== 'visible' || this.loading() || Date.now() - this.lastAsk < 1000) return;
    this.reload();
  }

  protected reload(): void {
    const id = this.numericId();
    if (!Number.isFinite(id) || id <= 0) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    const ticket = ++this.issued;
    const stale = () => ticket < this.applied;
    this.lastAsk = Date.now();
    this.inflight.update((n) => n + 1);
    this.api
      .analytics(id)
      .pipe(finalize(() => this.inflight.update((n) => n - 1)))
      .subscribe({
        next: (data) => {
          if (stale()) return;
          this.applied = ticket;
          this.analytics.set(data);
          this.campaign.set(data.campaign);
          this.updatedAt.set(Date.now());
          this.error.set('');
          this.loading.set(false);
        },
        // Analytics failing does not mean the campaign is gone: ask for it directly.
        error: (err: Error) => {
          if (stale()) return;
          this.api.get(id).subscribe({
            next: ({ campaign }) => {
              if (stale()) return;
              this.campaign.set(campaign);
              this.error.set(`Analytics unavailable: ${err.message}`);
              this.loading.set(false);
            },
            error: (inner: Error) => {
              if (stale()) return;
              if (/not found|404/i.test(inner.message)) this.notFound.set(true);
              else this.error.set(inner.message);
              this.loading.set(false);
            },
          });
        },
      });
  }

  private run<T extends { campaign: Campaign }>(
    label: string,
    call: () => Observable<T>,
    ok: string | ((res: T) => string),
  ) {
    this.busy.set(label);
    call().subscribe({
      next: (res) => {
        this.busy.set(null);
        this.campaign.set(res.campaign);
        this.store.setStatus(typeof ok === 'string' ? ok : ok(res), 'primary');
        this.reload();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
        this.store.setStatus(err.message, 'danger');
      },
    });
  }

  protected act(action: 'start' | 'pause' | 'resume'): void {
    const early = action === 'start' && this.canContinueEarly();
    const done = {
      start: 'Campaign started.',
      pause: 'Campaign paused.',
      resume: 'Campaign resumed.',
    };
    this.run(
      action,
      () => this.api.action(this.numericId(), action),
      ({ queued, carried }) =>
        early
          ? `Sent ${queued ?? 0} now${carried ? `; ${carried} more go out tomorrow` : ''}.`
          : done[action],
    );
  }

  protected cancel(): void {
    if (!this.confirmCancel()) {
      this.confirmCancel.set(true);
      return;
    }
    this.confirmCancel.set(false);
    this.run(
      'cancel',
      () => this.api.action(this.numericId(), 'cancel'),
      'Pending messages cancelled.',
    );
  }

  protected retry(): void {
    this.busy.set('retry');
    this.api.retryFailed(this.numericId()).subscribe({
      next: ({ campaign, queued }) => {
        this.busy.set(null);
        this.campaign.set(campaign);
        this.store.setStatus(
          `Re-queued ${queued} failed recipient${queued === 1 ? '' : 's'}.`,
          'primary',
        );
        this.reload();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected setSpeed(pacing: PacingPreset): void {
    if (pacing === this.pacing() || this.busy()) return;
    this.run('speed', () => this.api.speed(this.numericId(), pacing), `Speed set to ${pacing}.`);
  }

  protected exportCsv(): void {
    this.busy.set('export');
    this.api.exportCsv(this.numericId()).subscribe({
      next: (blob) => {
        this.busy.set(null);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `campaign-${this.id()}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }
}
