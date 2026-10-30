import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { AdminFeed } from './admin-feed';
import { OpsAudit } from './ops-audit';
import { OpsLogs } from './ops-logs';
import {
  type BackupStatus,
  ChannelDetail,
  LiveState,
  OpsApi,
  PlanRow,
  UsageBucket,
  UsageSummary,
  zeroCapLabel,
} from './ops-api';
import { serviceMeta } from './service-meta';

/** Which ops page the route renders; one component serves all five. */
type PageKind = 'plans' | 'usage' | 'health' | 'audit' | 'channels';
type Range = 'today' | 'd7' | 'd30';
/** The audit page's two views: what people changed, and what the server logged (`?view=logs`). */
type AuditTab = 'activity' | 'logs';

/**
 * Least time between two live reloads of one page. The feed sends `usage`/`campaigns` up to every 700 ms while a
 * campaign sends, and health-detail reads every number: once per few seconds is live enough and cheap.
 */
const LIVE_MIN_GAP_MS = 5000;
/** Safety-net reload for anything the feed does not carry (a clock-driven change such as a sending window opening). */
const FALLBACK_POLL_MS = 90_000;

const COPY: Record<PageKind, { title: string; lede: string; icon: string }> = {
  plans: {
    title: 'Plans',
    lede: 'What each business may use, and how close it is to its limits.',
    icon: 'crown',
  },
  usage: {
    title: 'Usage',
    lede: 'Messages sent, delivered, read and failed per business. Days are UTC.',
    icon: 'chart-histogram',
  },
  health: {
    title: 'Health',
    lede: 'Live state of every number. Problems are listed first; updates as numbers connect, drop or send.',
    icon: 'heart-rate-monitor',
  },
  audit: {
    title: 'Audit logs',
    lede: 'Every change made on the platform in plain words, newest first, with the backend record behind it.',
    icon: 'list-search',
  },
  channels: {
    title: 'Channels',
    lede: "Every WhatsApp number on the platform, its transport and today's sending budget.",
    icon: 'device-mobile',
  },
};

const STATE_COPY: Record<LiveState, { label: string; icon: string }> = {
  connected: { label: 'Connected', icon: 'circle-check' },
  connecting: { label: 'Connecting', icon: 'refresh' },
  qr: { label: 'QR scan needed', icon: 'qrcode' },
  auth_failure: { label: 'Login rejected', icon: 'shield-x' },
  error: { label: 'Error', icon: 'alert-circle' },
  disconnected: { label: 'Disconnected', icon: 'link-off' },
  idle: { label: 'Not started', icon: 'player-pause' },
  disabled: { label: 'Disabled', icon: 'ban' },
};

/** The sparkline's drawing box; the SVG stretches it to the cell, strokes stay 2px (non-scaling). */
const SPARK_BOX = { w: 120, h: 40, pad: 4 } as const;

/** Narrow enough that 14 day labels would rotate and collide under the platform chart. */
const NARROW_QUERY = '(max-width: 720px)';

/**
 * One business's days as SVG paths. All zero: a flat baseline, not a full-height band. One day with data: a stem
 * and a dot, not the thin triangle an area chart draws towards a lone point. Otherwise a line over a soft area.
 */
function sparkline(values: readonly number[]): { line: string; area: string; dot: string; flat: boolean } {
  const { w, h, pad } = SPARK_BOX;
  const base = h - pad;
  const max = Math.max(0, ...values);
  if (!max) return { line: `M0 ${base} H${w}`, area: '', dot: '', flat: true };
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = values.map((v, i) => [pad + i * step, base - (v / max) * (h - pad * 2)] as const);
  const lit = values.flatMap((v, i) => (v ? [i] : []));
  if (lit.length === 1) {
    const [x, y] = pts[lit[0]];
    return { line: `M0 ${base} H${w} M${x} ${base} V${y}`, area: '', dot: `M${x} ${y} h0`, flat: false };
  }
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return { line, area: `${line} L${pts.at(-1)![0]} ${base} L${pad} ${base} Z`, dot: '', flat: false };
}

/** A round axis step (1, 2 or 5 times a power of ten) at least `raw`, so the scale reads 0, 10, 20, 30. */
function niceStep(raw: number): number {
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  return ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
}

/** Transport ids from the server mapped to what an operator would call them. */
const PROVIDERS: Record<string, string> = { baileys: 'WhatsApp QR' };

/**
 * Read-only platform pages for the super admin: plans, usage, health,
 * audit logs and channels.
 *
 * The pages follow the super admin's live feed (`AdminFeed`): a change to
 * usage, numbers, businesses or campaigns reloads the page shown, at most
 * every few seconds, with a slow poll as a safety net. Live reloads are quiet:
 * they never flash the skeleton or clear a shown error until they succeed.
 */
@Component({
  selector: 'app-admin-ops',
  imports: [RouterLink, OpsAudit, OpsLogs],
  templateUrl: './ops.html',
  styleUrl: './ops.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminOpsView {
  private readonly api = inject(OpsApi);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly router = inject(Router);
  private readonly feed = inject(AdminFeed);
  private readonly auditView = viewChild(OpsAudit);
  private readonly logsView = viewChild(OpsLogs);
  protected readonly kind = toSignal(
    this.route.data.pipe(map((data) => data['kind'] as PageKind)),
    { initialValue: 'plans' as PageKind },
  );
  protected readonly auditTab = toSignal(
    this.route.queryParamMap.pipe(map((q): AuditTab => (q.get('view') === 'logs' ? 'logs' : 'activity'))),
    { initialValue: 'activity' as AuditTab },
  );
  /** `?requestId=` from an audit entry's "Show backend logs for this request". */
  protected readonly requestId = toSignal(
    this.route.queryParamMap.pipe(map((q) => q.get('requestId') ?? '')),
    { initialValue: '' },
  );

  protected readonly copy = computed(() => COPY[this.kind()]);
  protected readonly error = signal('');
  protected readonly loading = signal(true);
  protected readonly filter = signal('');
  protected readonly plans = signal<PlanRow[]>([]);
  protected readonly services = signal<string[]>([]);
  protected readonly usage = signal<UsageSummary | null>(null);
  protected readonly range = signal<Range>('d7');
  protected readonly channels = signal<ChannelDetail[]>([]);
  protected readonly problemsOnly = signal(false);
  protected readonly provider = signal('');
  protected readonly updatedAt = signal('');
  /** Last daily backup, shown on the health page; null until one has run. */
  protected readonly backup = signal<BackupStatus | null>(null);

  // ---- plans ----
  protected readonly shownPlans = computed(() =>
    this.match(this.plans(), (p) => `${p.name} ${p.slug}`),
  );
  protected readonly planTotals = computed(() => {
    const p = this.plans();
    return {
      tenants: p.length,
      active: p.filter((x) => x.status === 'active').length,
      near: p.filter((x) => this.planMeters(x).some((m) => m.pct >= 80)).length,
      custom: p.filter((x) => x.customSafetyActive).length,
    };
  });

  // ---- usage ----
  protected readonly usageTotals = computed<UsageBucket | null>(
    () => this.usage()?.totals[this.range()] ?? null,
  );
  protected readonly ranked = computed(() => {
    const w = this.range();
    return this.match([...(this.usage()?.tenants ?? [])], (t) => `${t.name} ${t.slug}`).sort(
      (a, b) => b[w].total - a[w].total || a.name.localeCompare(b.name),
    );
  });
  protected readonly maxWindow = computed(() =>
    Math.max(1, ...this.ranked().map((t) => t[this.range()].total)),
  );
  protected readonly sparkBox = SPARK_BOX;
  /** True on a phone-width screen, where the platform chart labels every third day. */
  private readonly narrow = signal(typeof matchMedia === 'function' && matchMedia(NARROW_QUERY).matches);

  /**
   * The platform chart: one stacked column per day (sent under failed) on a rounded scale. Drawn in plain CSS: the
   * ngx-charts stacked bars need an animations provider this app does not load, and threw instead of drawing.
   */
  protected readonly hero = computed(() => {
    const days = this.usage()?.days ?? [];
    const daily = this.platformDaily();
    const failed = this.platformFailed();
    const step = niceStep(Math.max(1, ...daily) / 3);
    const top = Math.ceil(Math.max(1, ...daily) / step) * step;
    const every = this.narrow() ? 3 : 1;
    return {
      ticks: Array.from({ length: Math.round(top / step) + 1 }, (_, i) => ({ value: i * step, pct: ((i * step) / top) * 100 })),
      days: days.map((day, i) => {
        const bad = failed[i] ?? 0;
        const sent = Math.max(0, (daily[i] ?? 0) - bad);
        return {
          day,
          label: day.slice(5),
          showLabel: (days.length - 1 - i) % every === 0,
          sent,
          failed: bad,
          sentPct: (sent / top) * 100,
          failedPct: (bad / top) * 100,
        };
      }),
    };
  });

  /** Each business's sparkline paths, keyed by tenant. */
  protected readonly sparks = computed(
    () => new Map((this.usage()?.tenants ?? []).map((t) => [t.tenantId, sparkline(t.daily)])),
  );

  protected readonly platformDaily = computed(() => {
    const u = this.usage();
    if (!u) return [];
    return u.days.map((_, i) => u.tenants.reduce((n, t) => n + t.daily[i], 0));
  });
  protected readonly platformFailed = computed(() => {
    const u = this.usage();
    if (!u) return [];
    return u.days.map((_, i) => u.tenants.reduce((n, t) => n + t.dailyFailed[i], 0));
  });

  // ---- health / channels ----
  protected readonly healthCounts = computed(() => {
    const c = this.channels();
    const of = (s: string) => c.filter((x) => x.severity === s).length;
    return {
      all: c.length,
      bad: of('bad'),
      warn: of('warn'),
      ok: of('ok'),
      off: of('off'),
      connected: c.filter((x) => x.state === 'connected').length,
      waiting: c.reduce((n, x) => n + x.waiting, 0),
    };
  });
  protected readonly shownHealth = computed(() =>
    this.problemsOnly()
      ? this.channels().filter((c) => c.severity === 'bad' || c.severity === 'warn')
      : this.channels(),
  );
  protected readonly providers = computed(() =>
    [...new Set(this.channels().map((c) => c.provider))].sort(),
  );
  protected readonly shownChannels = computed(() => {
    const p = this.provider();
    return this.match(
      this.channels(),
      (c) => `${c.displayName} ${c.tenantName} ${c.phoneNumber} ${c.account}`,
    )
      .filter((c) => !p || c.provider === p)
      .sort((a, b) => a.tenantName.localeCompare(b.tenantName) || a.id - b.id);
  });

  constructor() {
    effect(() => {
      this.kind();
      untracked(() => this.load());
    });
    // Live: the audit views follow their own topics; the data pages reload on these, throttled.
    this.feed.watch(['usage', 'channels', 'tenants', 'campaigns', 'plans'], () => this.liveReload());
    const timer = setInterval(() => {
      if (this.kind() !== 'audit' && !document.hidden) this.load(true);
    }, FALLBACK_POLL_MS);
    const media = typeof matchMedia === 'function' ? matchMedia(NARROW_QUERY) : null;
    const onMedia = (e: MediaQueryListEvent) => this.narrow.set(e.matches);
    media?.addEventListener('change', onMedia);
    this.destroyRef.onDestroy(() => {
      media?.removeEventListener('change', onMedia);
      clearInterval(timer);
      clearTimeout(this.liveTimer);
    });
  }

  private liveTimer?: ReturnType<typeof setTimeout>;
  private lastLive = 0;

  /** At most one quiet reload per LIVE_MIN_GAP_MS, trailing, so a busy campaign never starves or floods the page. */
  private liveReload() {
    if (this.kind() === 'audit' || this.liveTimer) return;
    const wait = Math.max(0, this.lastLive + LIVE_MIN_GAP_MS - Date.now());
    this.liveTimer = setTimeout(() => {
      this.liveTimer = undefined;
      this.lastLive = Date.now();
      if (!document.hidden) this.load(true);
    }, wait);
  }

  protected setTab(tab: AuditTab) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { view: tab === 'logs' ? 'logs' : null, requestId: null },
    });
  }

  protected clearRequest() {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { requestId: null },
      queryParamsHandling: 'merge',
    });
  }

  protected load(quiet = false) {
    const kind = this.kind();
    if (kind === 'audit') {
      this.loading.set(false);
      if (this.auditTab() === 'logs') this.logsView()?.reload();
      else this.auditView()?.reload();
      return;
    }
    if (!quiet) {
      this.loading.set(true);
      this.error.set('');
    }
    const fail = (err: Error) => {
      this.error.set(err.message);
      this.loading.set(false);
    };
    const done = (at: string) => {
      this.updatedAt.set(at);
      this.loading.set(false);
      if (quiet) this.error.set('');
    };
    if (kind === 'plans') {
      this.api.plans().subscribe({
        next: ({ services, tenants }) => {
          this.services.set(services);
          this.plans.set(tenants);
          done(new Date().toISOString());
        },
        error: fail,
      });
    } else if (kind === 'usage') {
      this.api.usage(14).subscribe({
        next: (u) => {
          this.usage.set(u);
          done(u.generatedAt);
        },
        error: fail,
      });
    } else {
      this.api.health().subscribe({
        next: (h) => {
          this.channels.set(h.channels);
          this.backup.set(h.backup ?? null);
          done(h.generatedAt);
        },
        error: fail,
      });
    }
  }

  protected setFilter(e: Event) {
    this.filter.set((e.target as HTMLInputElement).value);
  }

  protected setProvider(e: Event) {
    this.provider.set((e.target as HTMLSelectElement).value);
  }

  private match<T>(rows: T[], text: (row: T) => string): T[] {
    const q = this.filter().trim().toLowerCase();
    return q ? rows.filter((r) => text(r).toLowerCase().includes(q)) : rows;
  }

  // ---- view helpers ----
  protected initial(name: string): string {
    return (name.trim()[0] ?? '?').toUpperCase();
  }

  protected meta(key: string) {
    return serviceMeta(key);
  }

  protected providerLabel(p: string): string {
    return PROVIDERS[p] ?? p.replace(/_/g, ' ');
  }

  protected stateCopy(s: LiveState) {
    return STATE_COPY[s] ?? { label: s, icon: 'help-circle' };
  }

  /** Usage against a plan cap. A cap of 0 means no limit. */
  protected planMeters(p: PlanRow) {
    const meter = (label: string, icon: string, used: number, cap: number) => ({
      label,
      icon,
      used,
      cap,
      pct: cap ? Math.min(100, Math.round((used / cap) * 100)) : 0,
    });
    return [
      meter('Numbers', 'device-mobile', p.usage.channels, p.limits.maxChannels),
      meter('Users', 'users', p.usage.users, p.limits.maxUsers),
      meter('Templates', 'file-text', p.usage.templates, p.limits.maxTemplates),
    ];
  }

  protected tone(pct: number): string {
    return pct >= 100 ? 'bad' : pct >= 80 ? 'warn' : 'ok';
  }

  protected capText(n: number, unit = ''): string {
    return n ? `${n.toLocaleString()}${unit}` : 'No limit';
  }

  protected rate(part: number, whole: number): string {
    return whole ? `${Math.round((part / whole) * 1000) / 10}%` : '–';
  }

  protected bar(n: number): number {
    return (n / this.maxWindow()) * 100;
  }

  protected readonly zeroCap = zeroCapLabel;

  protected quotaPct(c: ChannelDetail): number {
    return c.quota.limit ? Math.min(100, Math.round((c.quota.used / c.quota.limit) * 100)) : 0;
  }

  /** "12.4 MB": backup size on the health page. */
  protected size(bytes: number | undefined): string {
    if (!bytes) return '0 KB';
    return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  /** "5 min ago" for recent times, a date after a day. */
  protected ago(iso: string | null): string {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
}
