import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import type { CampaignAnalytics } from '../core/api';
import { Store } from '../core/store';
import { count, pct, percent, reportRates } from './campaign-format';

type Tone = 'info' | 'good' | 'accent' | 'bad';

/**
 * Funnel, button clicks, failure breakdown and re-target shortcuts.
 *
 * Funnel percentages use the shared report bases (delivered of attempted,
 * read and replied of delivered), each stage saying its base. Click bars are scaled to the most-clicked
 * button (their label still says % of sent) so small counts stay visible.
 *
 * The funnel header says how fresh the numbers are: Delivered and Read arrive
 * long after a campaign is done, so "Live" is only claimed while the event
 * stream is up, and a manual refresh is always one click away.
 */
@Component({
  selector: 'app-campaign-insights',
  templateUrl: './campaign-insights.html',
  styleUrl: './campaign-insights.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignInsights {
  private readonly router = inject(Router);
  protected readonly store = inject(Store);

  readonly analytics = input.required<CampaignAnalytics>();
  readonly campaignId = input.required<number>();
  /** When `analytics` was read (ms epoch); null before the first answer. */
  readonly updatedAt = input<number | null>(null);
  /** A re-read is in flight: the refresh button spins and waits. */
  readonly refreshing = input(false);
  readonly refresh = output<void>();
  /** "Show failed recipients": the parent filters its recipient table to them. */
  readonly showFailed = output<void>();

  protected readonly count = count;
  protected readonly pct = pct;

  /** "just now", "12s ago", "3m ago"; reads the store's ticking clock, so it counts up by itself. */
  protected readonly updated = computed(() => {
    const at = this.updatedAt();
    if (at === null) return '';
    const s = Math.max(0, Math.floor((this.store.now() - at) / 1000));
    if (s < 3) return 'just now';
    return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
  });

  /** Bars start at 0 and grow once painted, so the width transition plays. */
  protected readonly ready = signal(false);

  /**
   * Each stage is a share of the stage it follows (see `reportRates`), so the
   * numbers match the campaign list and the Analytics table. Sent is of the audience.
   */
  protected readonly stages = computed(() => {
    const f = this.analytics().funnel;
    const audience = f.audience || f.queued || f.sent + f.failed || 0;
    const r = reportRates(f);
    const rows: {
      key: string;
      label: string;
      icon: string;
      count: number;
      tone: Tone;
      rate: number | null;
      base: string;
    }[] = [
      { key: 'sent', label: 'Sent', icon: 'send', count: f.sent, tone: 'info', rate: audience ? percent(f.sent, audience) : null, base: 'of audience' },
      { key: 'delivered', label: 'Delivered', icon: 'checks', count: f.delivered, tone: 'good', rate: r.delivered, base: 'of attempted' },
      { key: 'read', label: 'Read', icon: 'eye', count: f.read, tone: 'good', rate: r.read, base: 'of delivered' },
      { key: 'replied', label: 'Replied', icon: 'arrow-back-up', count: f.replied, tone: 'accent', rate: r.replied, base: 'of delivered' },
      { key: 'failed', label: 'Failed', icon: 'alert-circle', count: f.failed, tone: 'bad', rate: r.failed, base: 'of attempted' },
    ];
    return rows.map((s) => ({ ...s, countText: count(s.count), pctText: pct(s.rate), width: s.rate ?? 0 }));
  });

  protected readonly clicks = computed(() => {
    const a = this.analytics();
    if (!Array.isArray(a.clicks)) return null;
    const sent = a.funnel.sent;
    const max = Math.max(1, ...a.clicks.map((c) => c.count));
    return a.clicks.map((c) => ({
      ...c,
      pct: percent(c.count, sent),
      width: percent(c.count, max),
    }));
  });

  protected readonly failures = computed(() => {
    const list = this.analytics().failures ?? [];
    const max = Math.max(1, ...list.map((f) => f.count));
    return [...list]
      .sort((a, b) => b.count - a.count)
      .map((f) => ({ ...f, width: percent(f.count, max) }));
  });

  protected readonly retargets = computed(() => {
    const f = this.analytics().funnel;
    return [
      {
        filter: 'unread',
        label: 'Not read',
        icon: 'mail-exclamation',
        count: Math.max(0, f.sent - f.read),
      },
      {
        filter: 'noreply',
        label: 'No reply',
        icon: 'message-off',
        count: Math.max(0, f.sent - f.replied),
      },
      { filter: 'failed', label: 'Failed', icon: 'refresh-alert', count: f.failed },
    ];
  });

  constructor() {
    afterNextRender(() => requestAnimationFrame(() => this.ready.set(true)));
  }

  /** Hands off to the campaign wizard, which pre-fills the audience from this slice. */
  protected retarget(filter: string): void {
    this.router.navigate(['/campaign'], {
      queryParams: { retarget: this.campaignId(), filter },
    });
  }
}
