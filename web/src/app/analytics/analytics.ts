import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { Store } from '../core/store';
import { RouterLink } from '@angular/router';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { Tilt } from '../school/tilt';
import {
  AnalyticsApi, CampaignStats, InboxStats, MessageHistory, MessageStatus, ObjectStats, TicketStats, Usage, UsagePeriod,
} from './analytics-api';

/** Bottom-to-top stacking order; FAILED sits on top so it is never hidden. */
const STATUS_ORDER: MessageStatus[] = ['READ', 'DELIVERED', 'SENT', 'SANDBOX', 'SENDING', 'QUEUED', 'FAILED'];
const OPEN_TICKETS = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'];
const RING = 2 * Math.PI * 34;
const DAYS = 14;

interface Seg { status: string; n: number; pct: number }
interface Day { key: string; weekday: string; date: string; total: number; segs: Seg[] }
interface Bar { label: string; n: number; pct: number; tone: string }
interface Sources {
  usage: Usage | null;
  months: UsagePeriod[] | null;
  history: MessageHistory | null;
  campaign: CampaignStats | null;
  objects: ObjectStats | null;
  tickets: TicketStats | null;
  inbox: InboxStats | null;
}

const EMPTY: Sources = { usage: null, months: null, history: null, campaign: null, objects: null, tickets: null, inbox: null };

/** Round a chart ceiling up to 1/2/5 x 10^n so the axis labels read cleanly. */
function niceMax(n: number) {
  if (n <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(n));
  return ([1, 2, 5, 10].find((m) => m * p >= n) ?? 10) * p;
}
const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);
const sum = (o: Record<string, number | undefined>) => Object.values(o).reduce<number>((a, v) => a + (v ?? 0), 0);
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function bars(map: Record<string, number>, tone: (k: string) => string): Bar[] {
  const total = sum(map);
  return Object.entries(map)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ label: human(k), n, pct: pct(n, total), tone: tone(k) }));
}

@Component({
  selector: 'app-analytics',
  imports: [RouterLink, Tilt, DecimalPipe, DatePipe],
  templateUrl: './analytics.html',
  styleUrl: './analytics.scss',
})
export class AnalyticsView {
  private readonly api = inject(AnalyticsApi);
  private readonly store = inject(Store);

  protected readonly ring = RING;
  protected readonly statusOrder = STATUS_ORDER;
  protected readonly loading = signal(true);
  protected readonly data = signal<Sources>(EMPTY);
  protected readonly updatedAt = signal<Date | null>(null);

  protected readonly allFailed = computed(() => !this.loading() && Object.values(this.data()).every((v) => v === null));

  // ---------------------------------------------------------------- KPIs --
  protected readonly counts = computed(() => this.data().history?.counts ?? null);

  protected readonly monthly = computed(() => {
    const m = this.data().usage?.metrics.find((x) => x.metric === 'messages');
    if (m) return { used: m.used, limit: m.limit, fromPlan: true };
    const h = this.data().history;
    if (!h) return null;
    const now = new Date();
    const used = h.records.filter((r) => {
      const d = new Date(r.createdAt);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    }).length;
    return { used, limit: null as number | null, fromPlan: false };
  });
  protected readonly monthlyPct = computed(() => {
    const m = this.monthly();
    return m && m.limit ? Math.min(100, pct(m.used, m.limit)) : 0;
  });

  protected readonly deliveryRate = computed(() => {
    const c = this.counts();
    if (!c) return null;
    const ok = (c.DELIVERED ?? 0) + (c.READ ?? 0);
    const out = ok + (c.SENT ?? 0) + (c.FAILED ?? 0);
    return out ? Math.round((ok / out) * 100) : null;
  });
  protected readonly failed = computed(() => this.counts()?.FAILED ?? 0);

  protected readonly openTickets = computed(() => {
    const t = this.data().tickets;
    return t ? OPEN_TICKETS.reduce((a, s) => a + (t.byStatus[s] ?? 0), 0) : null;
  });

  // -------------------------------------------------------- 14-day chart --
  protected readonly days = computed<Day[] | null>(() => {
    const h = this.data().history;
    if (!h) return null;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - (DAYS - 1));
    const buckets = new Map<string, Record<string, number>>();
    const list: { key: string; d: Date }[] = [];
    for (let i = 0; i < DAYS; i += 1) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      list.push({ key: dayKey(d), d });
      buckets.set(dayKey(d), {});
    }
    for (const r of h.records) {
      const b = buckets.get(dayKey(new Date(r.createdAt)));
      if (b) b[r.status] = (b[r.status] ?? 0) + 1;
    }
    const max = niceMax(Math.max(0, ...[...buckets.values()].map(sum)));
    return list.map(({ key, d }) => {
      const b = buckets.get(key)!;
      return {
        key,
        weekday: d.toLocaleDateString(undefined, { weekday: 'short' }),
        date: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        total: sum(b),
        segs: STATUS_ORDER.filter((s) => b[s]).map((s) => ({ status: s, n: b[s], pct: pct(b[s], max) })),
      };
    });
  });
  protected readonly dayMax = computed(() => {
    const d = this.days();
    return d ? niceMax(Math.max(0, ...d.map((x) => x.total))) : 4;
  });
  protected readonly dayTotal = computed(() => (this.days() ?? []).reduce((a, d) => a + d.total, 0));
  protected readonly dayLegend = computed(() => {
    const seen = new Set((this.days() ?? []).flatMap((d) => d.segs.map((s) => s.status)));
    return STATUS_ORDER.filter((s) => seen.has(s));
  });
  protected readonly daySummary = computed(() => {
    const d = this.days();
    if (!d) return '';
    const peak = d.reduce((a, b) => (b.total > a.total ? b : a), d[0]);
    return `Messages per day over the last ${DAYS} days: ${this.dayTotal()} in total` +
      (peak.total ? `, busiest ${peak.weekday} ${peak.date} with ${peak.total}.` : '.');
  });
  protected readonly truncated = computed(() => (this.data().history?.records.length ?? 0) >= 1000);

  // ------------------------------------------------------- breakdowns --
  protected readonly statusBars = computed(() => {
    const c = this.counts();
    return c ? bars(c as Record<string, number>, (k) => `s-${k}`) : [];
  });

  protected readonly months = computed(() => {
    const m = this.data().months;
    if (!m) return null;
    const mon = this.monthly();
    const limit = mon?.fromPlan ? mon.limit : null;
    const rows = [...m].reverse().map((p) => ({
      period: p.period,
      label: new Date(`${p.period}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short' }),
      n: p.metrics['messages'] ?? 0,
    }));
    const max = niceMax(Math.max(limit ?? 0, ...rows.map((r) => r.n)));
    return {
      limit,
      limitPct: limit ? pct(limit, max) : null,
      summary: `Messages per month: ${rows.map((r) => `${r.label} ${r.n}`).join(', ')}` +
        (limit ? `. Plan limit ${limit}.` : '.'),
      rows: rows.map((r) => ({ ...r, pct: pct(r.n, max) })),
    };
  });

  protected readonly recordTypes = computed(() => {
    const o = this.data().objects;
    if (!o || !o.total) return [];
    const max = Math.max(...Object.values(o.byType).map((t) => t.total));
    return Object.entries(o.byType)
      .sort((a, b) => b[1].total - a[1].total)
      .map(([type, t]) => {
        const segs = Object.entries(t.byStatus)
          .sort((a, b) => b[1] - a[1])
          .map(([s, n], i) => ({ label: human(s), n, tone: `t${i % 5}` }));
        return {
          label: human(type),
          total: t.total,
          width: Math.max(8, pct(t.total, max)),
          segs,
          summary: `${human(type)}: ${segs.map((s) => `${s.label} ${s.n}`).join(', ')}`,
        };
      });
  });

  protected readonly ticketBars = computed(() => {
    const t = this.data().tickets;
    return t ? bars(t.byStatus, (k) => (k === 'OPEN' ? 'warn' : OPEN_TICKETS.includes(k) ? 'info' : 'ok')) : [];
  });
  protected readonly inboxBars = computed(() => {
    const i = this.data().inbox;
    return i ? bars(i.byStatus, (k) => (k === 'open' ? 'info' : k === 'pending' ? 'warn' : 'ok')) : [];
  });
  protected readonly supportGroups = computed(() =>
    [{ name: 'Tickets', rows: this.ticketBars() }, { name: 'Conversations', rows: this.inboxBars() }]
      .filter((g) => g.rows.length));
  protected readonly medianResolve = computed(() => {
    const s = this.data().tickets?.medianResolveSeconds;
    if (s == null) return null;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
    return s < 86400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86400).toFixed(1)} d`;
  });

  /** Sources answered, but there is nothing to chart anywhere. */
  protected readonly empty = computed(() => {
    const d = this.data();
    if (this.loading() || this.allFailed()) return false;
    return !(d.history?.records.length || (d.history && sum(d.history.counts)) || d.tickets?.total ||
      d.inbox?.total || d.objects?.total || this.monthly()?.used || d.campaign?.total);
  });

  constructor() {
    this.load();
    this.store.watch(['history', 'campaign', 'analytics', 'objects', 'tickets', 'inbox'], () => this.load(true), 2000);
  }

  protected load(quiet = false) {
    if (!quiet) this.loading.set(true);
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Each source fails alone: a tenant without a service gets 403 there and
    // that section simply does not render.
    const soft = <T>(o: Observable<T>) => o.pipe(catchError(() => of(null)));
    forkJoin({
      usage: soft(this.api.usage(period)),
      months: soft(this.api.usageHistory(6)),
      history: soft(this.api.history(1000)),
      campaign: soft(this.api.campaignStats()),
      objects: soft(this.api.objectStats()),
      tickets: soft(this.api.ticketStats()),
      inbox: soft(this.api.inboxStats()),
    }).subscribe((res) => {
      this.data.set(res);
      this.updatedAt.set(new Date());
      this.loading.set(false);
    });
  }

  protected ringOffset(p: number) {
    return RING * (1 - p / 100);
  }
  protected statusLabel(s: string) {
    return human(s);
  }
  protected segCount(d: Day, status: string) {
    return d.segs.find((s) => s.status === status)?.n ?? 0;
  }
}
