import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import type { CampaignAnalytics } from '../core/api';
import { percent } from './campaign-format';

type Tone = 'info' | 'good' | 'accent' | 'bad';

/**
 * Funnel, button clicks, failure breakdown and re-target shortcuts.
 *
 * Funnel percentages are of the audience, not of the previous stage, so a
 * drop at any step is comparable. Click bars are scaled to the most-clicked
 * button (their label still says % of sent) so small counts stay visible.
 */
@Component({
  selector: 'app-campaign-insights',
  templateUrl: './campaign-insights.html',
  styleUrl: './campaign-insights.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignInsights {
  private readonly router = inject(Router);

  readonly analytics = input.required<CampaignAnalytics>();
  readonly campaignId = input.required<number>();

  /** Bars start at 0 and grow once painted, so the width transition plays. */
  protected readonly ready = signal(false);

  protected readonly stages = computed(() => {
    const f = this.analytics().funnel;
    const base = f.audience || f.queued || f.sent + f.failed || 0;
    const rows: { key: string; label: string; icon: string; count: number; tone: Tone }[] = [
      { key: 'sent', label: 'Sent', icon: 'send', count: f.sent, tone: 'info' },
      { key: 'delivered', label: 'Delivered', icon: 'checks', count: f.delivered, tone: 'good' },
      { key: 'read', label: 'Read', icon: 'eye', count: f.read, tone: 'good' },
      { key: 'replied', label: 'Replied', icon: 'arrow-back-up', count: f.replied, tone: 'accent' },
      { key: 'failed', label: 'Failed', icon: 'alert-circle', count: f.failed, tone: 'bad' },
    ];
    return rows.map((r) => ({ ...r, pct: percent(r.count, base) }));
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
