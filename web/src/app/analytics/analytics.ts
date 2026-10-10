import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Observable, Subject, forkJoin, of } from 'rxjs';
import { catchError, distinctUntilChanged, map, switchMap } from 'rxjs/operators';

import { Store } from '../core/store';
import { Tilt } from '../school/tilt';
import {
  AnalyticsApi, CampaignStats, InboxStats, ObjectStats, Overview, RANGE_DAYS, RangeDays, TicketStats, Usage, UsagePeriod,
} from './analytics-api';
import { CountUp, downloadCsv, duration, toCsv, today } from './analytics-util';
import { CampaignTable } from './campaign-table';
import { MonthlyUsage } from './monthly-usage';
import { ResponseTimesView } from './response-times';
import { TrendChart } from './trend-chart';

const STATUS_ORDER = ['READ', 'DELIVERED', 'SENT', 'SANDBOX', 'SENDING', 'QUEUED', 'FAILED'];
const OPEN_TICKETS = ['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER'];

interface Bar { label: string; n: number; pct: number; tone: string }
/** The range-independent sources. Each is null when its endpoint failed or is not enabled. */
interface Sources {
  usage: Usage | null;
  months: UsagePeriod[] | null;
  campaign: CampaignStats | null;
  objects: ObjectStats | null;
  tickets: TicketStats | null;
  inbox: InboxStats | null;
}
const EMPTY: Sources = { usage: null, months: null, campaign: null, objects: null, tickets: null, inbox: null };

const pct = (n: number, of: number) => (of > 0 ? Math.round((n / of) * 1000) / 10 : 0);
const sum = (o: Record<string, number | undefined>) => Object.values(o).reduce<number>((a, v) => a + (v ?? 0), 0);
const human = (s: string) => s.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
const toDays = (v: string | null): RangeDays => (RANGE_DAYS.find((d) => String(d) === v) ?? 30);

function bars(source: Record<string, number>, tone: (k: string) => string): Bar[] {
  const total = sum(source);
  return Object.entries(source)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => ({ label: human(k), n, pct: pct(n, total), tone: tone(k) }));
}

/** A 100x32 sparkline path (line and closed area) for a KPI tile. */
function spark(values: number[]) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(30 - (v / max) * 26).toFixed(2)}`);
  const line = `M${pts.join('L')}`;
  return { line, area: `${line}L100,32L0,32Z` };
}

@Component({
  selector: 'app-analytics',
  imports: [RouterLink, Tilt, DecimalPipe, DatePipe, CountUp, TrendChart, CampaignTable, ResponseTimesView, MonthlyUsage],
  templateUrl: './analytics.html',
  styleUrl: './analytics.scss',
})
export class AnalyticsView {
  private readonly api = inject(AnalyticsApi);
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly ranges = RANGE_DAYS;
  protected readonly fmt = duration;

  protected readonly days = signal<RangeDays>(toDays(this.route.snapshot.queryParamMap.get('days')));
  protected readonly data = signal<Sources>(EMPTY);
  protected readonly srcLoading = signal(true);
  protected readonly overview = signal<Overview | null>(null);
  protected readonly ovLoading = signal(true);
  protected readonly ovError = signal<string | null>(null);
  protected readonly updatedAt = signal<Date | null>(null);
  private readonly overviewReq = new Subject<boolean>();

  /** First paint only; a range switch keeps the old figures on screen, dimmed. */
  protected readonly loading = computed(() => this.srcLoading() || (this.ovLoading() && !this.overview() && !this.ovError()));
  protected readonly stale = computed(() => this.ovLoading() && !!this.overview());
  protected readonly allFailed = computed(() =>
    !this.loading() && !this.overview() && Object.values(this.data()).every((v) => v === null));
  /** Nothing at all happened on this number in the range. */
  protected readonly quiet = computed(() => {
    const o = this.overview();
    return !!o && o.totals.total === 0 && o.autoReplies.inbound === 0;
  });

  // ---------------------------------------------------------------- KPIs --
  protected readonly kpis = computed(() => {
    const o = this.overview();
    if (!o) return null;
    const t = o.totals;
    const series = (k: 'sent' | 'delivered' | 'read' | 'failed') => spark(o.daily.map((d) => d[k]));
    const rt = o.responseTimes;
    return [
      { key: 'sent', label: 'Sent', icon: 'send', tone: 'info', value: t.sent, decimals: 0, suffix: '', text: null,
        foot: `${t.attempted.toLocaleString()} attempted · ${t.pending.toLocaleString()} queued`, spark: series('sent') },
      { key: 'delivery', label: 'Delivery rate', icon: 'done_all', tone: 'ok', value: t.deliveryRate, decimals: 1, suffix: '%', text: null,
        foot: `${t.delivered.toLocaleString()} delivered of ${t.attempted.toLocaleString()}`, spark: series('delivered') },
      { key: 'read', label: 'Read rate', icon: 'visibility', tone: 'read', value: t.readRate, decimals: 1, suffix: '%', text: null,
        foot: `${t.read.toLocaleString()} read of ${t.delivered.toLocaleString()} delivered`, spark: series('read') },
      { key: 'failed', label: 'Failed', icon: 'error', tone: 'bad', value: t.failed, decimals: 0, suffix: '', text: null,
        foot: t.failureRate === null ? 'Nothing attempted yet' : `${t.failureRate}% of attempted`, spark: series('failed') },
      { key: 'auto', label: 'Auto-reply hits', icon: 'smart_toy', tone: 'warn', value: o.autoReplies.messages, decimals: 0, suffix: '', text: null,
        foot: `${o.autoReplies.matched.toLocaleString()} of ${o.autoReplies.inbound.toLocaleString()} inbound matched a rule`, spark: null },
      { key: 'response', label: 'Median first response', icon: 'timer', tone: 'mute', value: null, decimals: 0, suffix: '',
        text: duration(rt.medianSeconds), foot: rt.answered ? `p90 ${duration(rt.p90Seconds)} · ${rt.unanswered} unanswered` : 'No replies to measure yet',
        spark: null },
    ];
  });

  protected readonly statusBars = computed(() => {
    const s = this.overview()?.totals.byStatus;
    if (!s) return [];
    const ordered = Object.fromEntries(STATUS_ORDER.map((k) => [k, s[k] ?? 0]));
    return bars(ordered, (k) => `s-${k}`);
  });

  protected readonly ruleBars = computed(() => {
    const rules = this.overview()?.autoReplies.topRules ?? [];
    const max = Math.max(1, ...rules.map((r) => r.count));
    return rules.map((r) => ({ label: r.rule, n: r.count, pct: (r.count / max) * 100 }));
  });

  // ------------------------------------------------- range-free sections --
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

  protected readonly supportGroups = computed(() => {
    const t = this.data().tickets;
    const i = this.data().inbox;
    return [
      { name: 'Tickets', rows: t ? bars(t.byStatus, (k) => (k === 'OPEN' ? 'warn' : OPEN_TICKETS.includes(k) ? 'info' : 'ok')) : [] },
      { name: 'Conversations', rows: i ? bars(i.byStatus, (k) => (k === 'open' ? 'info' : k === 'pending' ? 'warn' : 'ok')) : [] },
    ].filter((g) => g.rows.length);
  });
  protected readonly openTickets = computed(() => {
    const t = this.data().tickets;
    return t ? OPEN_TICKETS.reduce((a, s) => a + (t.byStatus[s] ?? 0), 0) : null;
  });
  protected readonly medianResolve = computed(() => {
    const s = this.data().tickets?.medianResolveSeconds;
    return s == null ? null : duration(s);
  });

  constructor() {
    this.overviewReq.pipe(
      switchMap((quiet) => {
        if (!quiet) this.ovLoading.set(true);
        return this.api.overview(this.days()).pipe(
          map((o) => ({ o, err: null as string | null, quiet })),
          catchError((e: Error) => of({ o: null, err: e.message, quiet })),
        );
      }),
      takeUntilDestroyed(),
    ).subscribe(({ o, err, quiet }) => {
      if (o) {
        this.overview.set(o);
        this.ovError.set(null);
        this.updatedAt.set(new Date());
      } else if (!quiet) {
        // A failed background refresh keeps the figures already shown.
        this.overview.set(null);
        this.ovError.set(err);
      }
      this.ovLoading.set(false);
    });

    // The range lives in the URL (?days=7|30|90): shareable, and Back works.
    this.route.queryParamMap.pipe(
      map((p) => toDays(p.get('days'))),
      distinctUntilChanged(),
      takeUntilDestroyed(),
    ).subscribe((d) => {
      this.days.set(d);
      this.overviewReq.next(false);
    });

    this.loadSources();
    this.store.watch(['history', 'campaign', 'analytics', 'objects', 'tickets', 'inbox'], () => this.load(true), 2000);
  }

  protected setDays(d: RangeDays) {
    if (d === this.days()) return;
    void this.router.navigate([], { relativeTo: this.route, queryParams: { days: d }, queryParamsHandling: 'merge', replaceUrl: true });
  }

  protected load(quiet = false) {
    this.overviewReq.next(quiet);
    this.loadSources(quiet);
  }

  private loadSources(quiet = false) {
    if (!quiet) this.srcLoading.set(true);
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    // Each source fails alone: a tenant without a service gets 403 there and
    // that section simply does not render.
    const soft = <T>(o: Observable<T>) => o.pipe(catchError(() => of(null)));
    forkJoin({
      usage: soft(this.api.usage(period)),
      months: soft(this.api.usageHistory(6)),
      campaign: soft(this.api.campaignStats()),
      objects: soft(this.api.objectStats()),
      tickets: soft(this.api.ticketStats()),
      inbox: soft(this.api.inboxStats()),
    }).subscribe((res) => {
      this.data.set(res);
      this.srcLoading.set(false);
    });
  }

  protected exportDaily() {
    const o = this.overview();
    if (!o) return;
    downloadCsv(`daily-messages-${o.range.days}d-${today()}.csv`, toCsv(
      ['Date (UTC)', 'Total', 'Sent', 'Delivered', 'Read', 'Failed'],
      o.daily.map((d) => [d.date, d.total, d.sent, d.delivered, d.read, d.failed]),
    ));
  }

  protected statusLabel(s: string) {
    return human(s);
  }
}
