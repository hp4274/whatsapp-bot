import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { Observable } from 'rxjs';

import {
  type Campaign,
  type CampaignAnalytics,
  CampaignsApi,
  type PacingPreset,
} from '../core/api';
import { CampaignPolicy } from '../campaign/policy-api';
import { Store } from '../core/store';
import { canCancel, localTime, percent, relativeTime } from './campaign-format';
import { CampaignInsights } from './campaign-insights';
import { CampaignRecipients } from './campaign-recipients';
import { CampaignStatusPill } from './status-pill';

/** Pacing presets the engine accepts; changing one applies to the next send, mid-run. */
const SPEEDS: readonly { key: PacingPreset; label: string; icon: string }[] = [
  { key: 'safe', label: 'Safe', icon: 'shield' },
  { key: 'balanced', label: 'Balanced', icon: 'scale' },
  { key: 'fast', label: 'Fast', icon: 'bolt' },
];

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

  protected readonly localTime = localTime;
  protected readonly relativeTime = relativeTime;

  constructor() {
    this.policy.load();
    effect(() => {
      this.id();
      untracked(() => {
        this.loading.set(true);
        this.campaign.set(null);
        this.analytics.set(null);
        this.notFound.set(false);
        this.reload();
      });
    });
    this.store.watch(['campaigns', 'campaign', 'history', 'analytics'], () => this.reload(), 700);
  }

  protected reload(): void {
    const id = this.numericId();
    if (!Number.isFinite(id) || id <= 0) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    this.api.analytics(id).subscribe({
      next: (data) => {
        this.analytics.set(data);
        this.campaign.set(data.campaign);
        this.error.set('');
        this.loading.set(false);
      },
      // Analytics failing does not mean the campaign is gone: ask for it directly.
      error: (err: Error) => {
        this.api.get(id).subscribe({
          next: ({ campaign }) => {
            this.campaign.set(campaign);
            this.error.set(`Analytics unavailable: ${err.message}`);
            this.loading.set(false);
          },
          error: (inner: Error) => {
            if (/not found|404/i.test(inner.message)) this.notFound.set(true);
            else this.error.set(inner.message);
            this.loading.set(false);
          },
        });
      },
    });
  }

  private run(label: string, call: () => Observable<{ campaign: Campaign }>, ok: string) {
    this.busy.set(label);
    call().subscribe({
      next: ({ campaign }) => {
        this.busy.set(null);
        this.campaign.set(campaign);
        this.store.setStatus(ok, 'primary');
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
    const done = {
      start: 'Campaign started.',
      pause: 'Campaign paused.',
      resume: 'Campaign resumed.',
    };
    this.run(action, () => this.api.action(this.numericId(), action), done[action]);
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
