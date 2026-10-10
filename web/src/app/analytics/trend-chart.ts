import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { DailyPoint } from './analytics-api';
import { dayLabel, niceMax } from './analytics-util';

type Key = 'sent' | 'delivered' | 'read' | 'failed';
interface Series {
  key: Key;
  label: string;
  kind: 'area' | 'line' | 'dash' | 'bar';
}

const SERIES: Series[] = [
  { key: 'sent', label: 'Sent', kind: 'area' },
  { key: 'delivered', label: 'Delivered', kind: 'dash' },
  { key: 'read', label: 'Read', kind: 'line' },
  { key: 'failed', label: 'Failed', kind: 'bar' },
];
/** viewBox units; the SVG stretches to its box, strokes stay crisp. */
const W = 1000;
const H = 300;

/**
 * Daily trend for the selected range: sent as an area, delivered (dashed) and
 * read (solid) as lines, failed as bars along the floor. Hover, touch or the
 * arrow keys pick a day; the series toggles are real buttons. Screen readers
 * get the summary as the chart's label and every value in a table.
 */
@Component({
  selector: 'app-trend-chart',
  imports: [DecimalPipe],
  templateUrl: './trend-chart.html',
  styleUrl: './trend-chart.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrendChart {
  readonly points = input.required<DailyPoint[]>();

  protected readonly series = SERIES;
  protected readonly w = W;
  protected readonly h = H;
  protected readonly hidden = signal<ReadonlySet<Key>>(new Set());
  protected readonly active = signal<number | null>(null);

  protected readonly max = computed(() => {
    const hide = this.hidden();
    const keys = SERIES.map((s) => s.key).filter((k) => !hide.has(k));
    return niceMax(Math.max(0, ...this.points().flatMap((p) => keys.map((k) => p[k]))));
  });
  protected readonly ticks = computed(() => [this.max(), this.max() / 2, 0]);

  private x(i: number) {
    const n = this.points().length;
    return n > 1 ? (i / (n - 1)) * W : W / 2;
  }
  private y(v: number) {
    return H - (v / this.max()) * H;
  }

  protected readonly paths = computed(() => {
    const pts = this.points();
    const line = (k: Key) =>
      pts
        .map((p, i) => `${i ? 'L' : 'M'}${this.x(i).toFixed(1)},${this.y(p[k]).toFixed(1)}`)
        .join('');
    const sent = line('sent');
    const barW = Math.max(2, Math.min(18, (W / Math.max(1, pts.length)) * 0.45));
    return {
      sentLine: sent,
      sentArea: pts.length ? `${sent}L${this.x(pts.length - 1)},${H}L${this.x(0)},${H}Z` : '',
      delivered: line('delivered'),
      read: line('read'),
      failed: pts
        .map((p, i) => ({
          x: this.x(i) - barW / 2,
          y: this.y(p.failed),
          w: barW,
          h: H - this.y(p.failed),
          n: p.failed,
        }))
        .filter((b) => b.n > 0),
    };
  });

  /** About six evenly spaced date labels, always including both ends. */
  protected readonly xLabels = computed(() => {
    const pts = this.points();
    const last = pts.length - 1;
    const step = Math.max(1, Math.ceil(last / 5));
    const idx: number[] = [];
    for (let i = 0; i < last; i += step) idx.push(i);
    if (idx.length && last - idx[idx.length - 1] < step / 2) idx.pop(); // too close to the end label
    if (last >= 0) idx.push(last);
    return idx.map((i) => ({ i, left: (this.x(i) / W) * 100, text: dayLabel(pts[i].date) }));
  });

  protected readonly tip = computed(() => {
    const i = this.active();
    const p = i == null ? null : this.points()[i];
    if (!p || i == null) return null;
    const left = (this.x(i) / W) * 100;
    const hide = this.hidden();
    return {
      p,
      left,
      date: dayLabel(p.date, { weekday: 'short', day: 'numeric', month: 'short' }),
      flip: left > 62,
      dots: SERIES.filter((s) => !hide.has(s.key) && s.kind !== 'bar').map((s) => ({
        key: s.key,
        bottom: (p[s.key] / this.max()) * 100,
      })),
    };
  });

  protected readonly totals = computed(() => {
    const t = { sent: 0, delivered: 0, read: 0, failed: 0 };
    for (const p of this.points()) for (const k of Object.keys(t) as Key[]) t[k] += p[k];
    return t;
  });

  protected readonly summary = computed(() => {
    const pts = this.points();
    const t = this.totals();
    if (!pts.length) return 'No data';
    const peak = pts.reduce((a, b) => (b.sent > a.sent ? b : a), pts[0]);
    return (
      `Daily messages over ${pts.length} days: ${t.sent} sent, ${t.delivered} delivered, ${t.read} read, ` +
      `${t.failed} failed.` +
      (peak.sent ? ` Busiest day ${dayLabel(peak.date)} with ${peak.sent} sent.` : '')
    );
  });

  protected readonly empty = computed(() => this.points().every((p) => p.total === 0));

  protected label(date: string) {
    return dayLabel(date, { weekday: 'short', day: 'numeric', month: 'short' });
  }

  protected toggle(key: Key) {
    const next = new Set(this.hidden());
    if (next.has(key)) next.delete(key);
    else if (next.size < SERIES.length - 1) next.add(key); // never hide everything
    this.hidden.set(next);
  }

  protected pick(e: PointerEvent) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const n = this.points().length;
    if (!n || !box.width) return;
    const f = Math.min(1, Math.max(0, (e.clientX - box.left) / box.width));
    this.active.set(Math.round(f * (n - 1)));
  }

  protected key(e: KeyboardEvent) {
    const n = this.points().length;
    if (!n) return;
    const cur = this.active() ?? n - 1;
    const next =
      e.key === 'ArrowLeft'
        ? cur - 1
        : e.key === 'ArrowRight'
          ? cur + 1
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : e.key === 'Escape'
                ? null
                : undefined;
    if (next === undefined) return;
    e.preventDefault();
    this.active.set(next === null ? null : Math.min(n - 1, Math.max(0, next)));
  }
}
