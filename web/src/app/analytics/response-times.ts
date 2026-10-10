import { DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';

import { ResponseTimes } from './analytics-api';
import { CountUp, duration } from './analytics-util';

const ARC = 2 * Math.PI * 30;

/**
 * Inbox first-response metrics: median / p90 / average, the share of
 * conversations answered within 5 minutes and 1 hour (of ALL conversations,
 * so unanswered ones count against it), and the full distribution.
 */
@Component({
  selector: 'app-response-times',
  imports: [DecimalPipe, CountUp],
  templateUrl: './response-times.html',
  styleUrl: './response-times.scss',
})
export class ResponseTimesView {
  readonly data = input.required<ResponseTimes>();
  readonly days = input(30);

  protected readonly arc = ARC;
  protected readonly fmt = duration;

  protected readonly gauges = computed(() => {
    const d = this.data();
    return [
      { key: 'g5', label: 'Within 5 min', pct: d.within5mPct, n: d.within5m },
      { key: 'g60', label: 'Within 1 hour', pct: d.within1hPct, n: d.within1h },
    ];
  });

  protected readonly bars = computed(() => {
    const d = this.data();
    const rows = [
      ...d.buckets.map((b, i) => ({ key: b.key, label: b.label, n: b.count, tone: i < 2 ? 'fast' : i < 4 ? 'ok' : 'slow' })),
      { key: 'none', label: 'Unanswered', n: d.unanswered, tone: 'none' },
    ];
    const max = Math.max(1, ...rows.map((r) => r.n));
    return rows.map((r) => ({ ...r, pct: (r.n / max) * 100, share: d.conversations ? Math.round((r.n / d.conversations) * 100) : 0 }));
  });

  protected readonly summary = computed(() => {
    const d = this.data();
    return `First response distribution over ${d.conversations} conversations: ` +
      this.bars().map((b) => `${b.label} ${b.n}`).join(', ') + '.';
  });

  protected offset(pct: number | null) {
    return ARC * (1 - Math.min(100, Math.max(0, pct ?? 0)) / 100);
  }
}
