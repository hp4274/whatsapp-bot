import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { Usage, UsagePeriod } from './analytics-api';
import { niceMax } from './analytics-util';

const RING = 2 * Math.PI * 34;
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);

/** Six months of billed message usage, with this month's share of the plan limit. */
@Component({
  selector: 'app-monthly-usage',
  imports: [DecimalPipe],
  template: `
    <div class="p-head">
      <div>
        <h2 id="t-months">Monthly usage</h2>
        <span class="muted">Messages, 6 months</span>
      </div>
      @if (monthly(); as m) {
        @if (m.limit) {
          <svg
            class="ring"
            viewBox="0 0 80 80"
            role="img"
            [attr.aria-label]="
              m.used + ' of ' + m.limit + ' messages used this month, ' + monthlyPct() + '%'
            "
          >
            <circle cx="40" cy="40" r="34" class="track" />
            <circle
              cx="40"
              cy="40"
              r="34"
              class="fill"
              [class.hot]="monthlyPct() >= 90"
              [attr.stroke-dasharray]="ring"
              [attr.stroke-dashoffset]="ring * (1 - monthlyPct() / 100)"
            />
            <text x="40" y="45" text-anchor="middle">{{ monthlyPct() | number: '1.0-0' }}%</text>
          </svg>
        } @else {
          <span class="muted">{{ m.used | number }} this month</span>
        }
      }
    </div>
    @if (chart(); as mo) {
      <div class="mchart" role="img" [attr.aria-label]="mo.summary">
        @if (mo.limitPct !== null) {
          <span class="limit" [style.bottom.%]="mo.limitPct"
            ><small>Limit {{ mo.limit | number }}</small></span
          >
        }
        @for (r of mo.rows; track r.period; let i = $index; let last = $last) {
          <div class="mcol" style="--i: {{ i }}">
            <small class="m-num">{{ r.n | number }}</small>
            <div class="m-track">
              <i class="m-bar" [class.now]="last" [style.height.%]="r.pct"></i>
            </div>
            <span class="x">{{ r.label }}</span>
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .p-head {
      display: flex;
      flex-wrap: wrap;
      gap: 4px var(--space-md);
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-lg);
      h2 {
        margin: 0;
        font-size: 17px;
        font-weight: 500;
        color: var(--text-strong);
      }
      span {
        display: block;
        margin-top: 2px;
        font-size: 12.5px;
      }
    }
    .mchart {
      position: relative;
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: var(--space-md);
      padding-top: 4px;
    }
    .mcol {
      display: grid;
      grid-template-rows: auto 150px auto;
      justify-items: center;
      gap: 6px;
    }
    .m-num {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }
    .m-track {
      position: relative;
      width: 100%;
      max-width: 44px;
      display: flex;
      align-items: end;
      border-radius: 10px;
      background: var(--surface-sunken);
    }
    .m-bar {
      display: block;
      width: 100%;
      border-radius: 10px;
      background: color-mix(in srgb, var(--accent) 55%, var(--surface-sunken));
      transform-origin: bottom;
      animation: grow-y 760ms var(--ease) both;
      animation-delay: calc(var(--i, 0) * 70ms);
      &.now {
        background: var(--primary);
      }
    }
    .limit {
      position: absolute;
      left: 0;
      right: 0;
      height: 0;
      border-top: 2px dashed var(--danger-text);
      z-index: 1;
      pointer-events: none;
      margin-bottom: 26px;
      small {
        position: absolute;
        right: 0;
        top: -18px;
        font-size: 11px;
        font-weight: 500;
        color: var(--danger-text);
        background: var(--surface-card);
        padding: 0 4px;
      }
    }
    .x {
      font-size: 11.5px;
      font-weight: 500;
      color: var(--hint);
    }
    .ring {
      width: 56px;
      height: 56px;
      flex: none;
      transform: rotate(-90deg);
      circle {
        fill: none;
        stroke-width: 9;
      }
      .track {
        stroke: var(--surface-sunken);
      }
      .fill {
        stroke: var(--primary);
        stroke-linecap: round;
        transition: stroke-dashoffset 900ms var(--ease);
        animation: ring 900ms var(--ease) both;
        &.hot {
          stroke: var(--danger);
        }
      }
      text {
        transform: rotate(90deg);
        transform-origin: 40px 40px;
        fill: var(--text-strong);
        font-size: 17px;
        font-weight: 500;
      }
    }
    @keyframes grow-y {
      from {
        transform: scaleY(0);
      }
    }
    @keyframes ring {
      from {
        stroke-dashoffset: 213.6;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .m-bar,
      .ring .fill {
        animation: none;
        transition: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MonthlyUsage {
  readonly months = input.required<UsagePeriod[]>();
  readonly usage = input<Usage | null>(null);

  protected readonly ring = RING;

  protected readonly monthly = computed(() => {
    const m = this.usage()?.metrics.find((x) => x.metric === 'messages');
    return m ? { used: m.used, limit: m.limit } : null;
  });
  protected readonly monthlyPct = computed(() => {
    const m = this.monthly();
    return m && m.limit ? Math.min(100, pct(m.used, m.limit)) : 0;
  });

  protected readonly chart = computed(() => {
    const limit = this.monthly()?.limit ?? null;
    const rows = [...this.months()].reverse().map((p) => ({
      period: p.period,
      label: new Date(`${p.period}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' }),
      n: p.metrics['messages'] ?? 0,
    }));
    if (!rows.length) return null;
    const max = niceMax(Math.max(limit ?? 0, ...rows.map((r) => r.n)));
    return {
      limit,
      limitPct: limit ? pct(limit, max) : null,
      summary:
        `Messages per month: ${rows.map((r) => `${r.label} ${r.n}`).join(', ')}` +
        (limit ? `. Plan limit ${limit}.` : '.'),
      rows: rows.map((r) => ({ ...r, pct: pct(r.n, max) })),
    };
  });
}
