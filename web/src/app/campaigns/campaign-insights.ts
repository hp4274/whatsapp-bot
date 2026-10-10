import { afterNextRender, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';

import { CampaignAnalytics } from '../core/api';
import { percent } from './campaign-format';

type Tone = 'good' | 'accent' | 'bad';

/** Funnel, button clicks, failure breakdown and re-target shortcuts. */
@Component({
  selector: 'app-campaign-insights',
  templateUrl: './campaign-insights.html',
  styleUrl: './campaign-insights.scss',
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
      { key: 'sent', label: 'Sent', icon: 'send', count: f.sent, tone: 'good' },
      { key: 'delivered', label: 'Delivered', icon: 'done_all', count: f.delivered, tone: 'good' },
      { key: 'read', label: 'Read', icon: 'visibility', count: f.read, tone: 'good' },
      { key: 'replied', label: 'Replied', icon: 'reply', count: f.replied, tone: 'accent' },
      { key: 'failed', label: 'Failed', icon: 'error', count: f.failed, tone: 'bad' },
    ];
    return rows.map((r) => ({ ...r, pct: percent(r.count, base) }));
  });

  protected readonly clicks = computed(() => {
    const a = this.analytics();
    if (!Array.isArray(a.clicks)) return null;
    const sent = a.funnel.sent;
    const max = Math.max(1, ...a.clicks.map((c) => c.count));
    return a.clicks.map((c) => ({ ...c, pct: percent(c.count, sent), width: percent(c.count, max) }));
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
      { filter: 'unread', label: 'Not read', icon: 'mark_email_unread', count: Math.max(0, f.sent - f.read) },
      { filter: 'noreply', label: 'No reply', icon: 'speaker_notes_off', count: Math.max(0, f.sent - f.replied) },
      { filter: 'failed', label: 'Failed', icon: 'sync_problem', count: f.failed },
    ];
  });

  constructor() {
    afterNextRender(() => requestAnimationFrame(() => this.ready.set(true)));
  }

  protected retarget(filter: string): void {
    this.router.navigate(['/campaign'], {
      queryParams: { retarget: this.campaignId(), filter },
    });
  }
}
