import { Component, DestroyRef, computed, effect, inject, signal, untracked, viewChild } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';

import { OpsAudit } from './ops-audit';
import { ChannelDetail, LiveState, OpsApi, PlanRow, UsageBucket, UsageSummary } from './ops-api';
import { serviceMeta } from './service-meta';

type PageKind = 'plans' | 'usage' | 'health' | 'audit' | 'channels';
type Range = 'today' | 'd7' | 'd30';

const COPY: Record<PageKind, { title: string; lede: string; icon: string }> = {
  plans: { title: 'Plans', lede: 'What each business may use, and how close it is to its limits.', icon: 'workspace_premium' },
  usage: { title: 'Usage', lede: 'Messages sent, delivered, read and failed per business. Days are UTC.', icon: 'monitoring' },
  health: { title: 'Health', lede: 'Live state of every number. Problems are listed first; refreshes every 30 seconds.', icon: 'health_and_safety' },
  audit: { title: 'Audit logs', lede: 'Every change made on the platform, newest first.', icon: 'manage_search' },
  channels: { title: 'Channels', lede: 'Every WhatsApp number on the platform, its transport and today\'s sending budget.', icon: 'smartphone' },
};

const STATE_COPY: Record<LiveState, { label: string; icon: string }> = {
  connected: { label: 'Connected', icon: 'check_circle' },
  connecting: { label: 'Connecting', icon: 'sync' },
  qr: { label: 'QR scan needed', icon: 'qr_code_2' },
  auth_failure: { label: 'Login rejected', icon: 'gpp_bad' },
  error: { label: 'Error', icon: 'error' },
  disconnected: { label: 'Disconnected', icon: 'link_off' },
  idle: { label: 'Not started', icon: 'pause_circle' },
  disabled: { label: 'Disabled', icon: 'block' },
};

const PROVIDERS: Record<string, string> = { cloud_api: 'Cloud API', whatsapp_web: 'WhatsApp Web', sandbox: 'Sandbox' };

@Component({
  selector: 'app-admin-ops',
  imports: [RouterLink, OpsAudit],
  templateUrl: './ops.html',
  styleUrl: './ops.scss',
})
export class AdminOpsView {
  private readonly api = inject(OpsApi);
  private readonly auditView = viewChild(OpsAudit);
  protected readonly kind = toSignal(
    inject(ActivatedRoute).data.pipe(map((data) => data['kind'] as PageKind)),
    { initialValue: 'plans' as PageKind },
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

  // ---- plans ----
  protected readonly shownPlans = computed(() => this.match(this.plans(), (p) => `${p.name} ${p.slug}`));
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
  protected readonly usageTotals = computed<UsageBucket | null>(() => this.usage()?.totals[this.range()] ?? null);
  protected readonly ranked = computed(() => {
    const w = this.range();
    return this.match([...(this.usage()?.tenants ?? [])], (t) => `${t.name} ${t.slug}`)
      .sort((a, b) => b[w].total - a[w].total || a.name.localeCompare(b.name));
  });
  protected readonly maxWindow = computed(() => Math.max(1, ...this.ranked().map((t) => t[this.range()].total)));
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
      all: c.length, bad: of('bad'), warn: of('warn'), ok: of('ok'), off: of('off'),
      connected: c.filter((x) => x.state === 'connected').length,
      warming: c.filter((x) => x.warmup?.active).length,
      waiting: c.reduce((n, x) => n + x.waiting, 0),
    };
  });
  protected readonly shownHealth = computed(() =>
    this.problemsOnly() ? this.channels().filter((c) => c.severity === 'bad' || c.severity === 'warn') : this.channels());
  protected readonly providers = computed(() => [...new Set(this.channels().map((c) => c.provider))].sort());
  protected readonly shownChannels = computed(() => {
    const p = this.provider();
    return this.match(this.channels(), (c) => `${c.displayName} ${c.tenantName} ${c.phoneNumber} ${c.account}`)
      .filter((c) => !p || c.provider === p)
      .sort((a, b) => a.tenantName.localeCompare(b.tenantName) || a.id - b.id);
  });

  constructor() {
    effect(() => {
      this.kind();
      untracked(() => this.load());
    });
    // /api/admin is not broadcast; poll the live pages quietly.
    const timer = setInterval(() => {
      if (['usage', 'health', 'channels'].includes(this.kind()) && !document.hidden) this.load(true);
    }, 30_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected load(quiet = false) {
    const kind = this.kind();
    if (kind === 'audit') {
      this.loading.set(false);
      this.auditView()?.reload();
      return;
    }
    if (!quiet) {
      this.loading.set(true);
      this.error.set('');
    }
    const fail = (err: Error) => { this.error.set(err.message); this.loading.set(false); };
    const done = (at: string) => { this.updatedAt.set(at); this.loading.set(false); if (quiet) this.error.set(''); };
    if (kind === 'plans') {
      this.api.plans().subscribe({
        next: ({ services, tenants }) => { this.services.set(services); this.plans.set(tenants); done(new Date().toISOString()); },
        error: fail,
      });
    } else if (kind === 'usage') {
      this.api.usage(14).subscribe({ next: (u) => { this.usage.set(u); done(u.generatedAt); }, error: fail });
    } else {
      this.api.health().subscribe({ next: (h) => { this.channels.set(h.channels); done(h.generatedAt); }, error: fail });
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
    return STATE_COPY[s] ?? { label: s, icon: 'help' };
  }

  /** Usage against a plan cap. A cap of 0 means no limit. */
  protected planMeters(p: PlanRow) {
    const meter = (label: string, icon: string, used: number, cap: number) => ({
      label, icon, used, cap, pct: cap ? Math.min(100, Math.round((used / cap) * 100)) : 0,
    });
    return [
      meter('Numbers', 'smartphone', p.usage.channels, p.limits.maxChannels),
      meter('Users', 'group', p.usage.users, p.limits.maxUsers),
      meter('Templates', 'description', p.usage.templates, p.limits.maxTemplates),
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

  protected quotaPct(c: ChannelDetail): number {
    return c.quota.limit ? Math.min(100, Math.round((c.quota.used / c.quota.limit) * 100)) : 0;
  }

  /** SVG paths for a sparkline in a 140x36 box (2px inset so the stroke is not clipped). */
  protected spark(values: number[], failed: number[] = []) {
    const w = 140, h = 36, pad = 2;
    const max = Math.max(1, ...values);
    const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
    const pts = values.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)]);
    const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
    const area = pts.length ? `${line}L${pts[pts.length - 1][0].toFixed(1)},${h}L${pad},${h}Z` : '';
    const bars = failed.map((f, i) => ({ x: pad + i * step - 1.5, hgt: (f / max) * (h - pad * 2) })).filter((b) => b.hgt > 0);
    const last = pts[pts.length - 1];
    return { line, area, bars, last, h };
  }

  protected sparkLabel(values: number[]): string {
    const total = values.reduce((a, b) => a + b, 0);
    return `${values.length}-day volume: ${total} messages, peak ${Math.max(0, ...values)} a day, ${values.at(-1) ?? 0} today`;
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
