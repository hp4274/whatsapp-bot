import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, type ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { type PlanUsage, type PlanUsageMetric, TenancyApi, type TenantSubscriptionState } from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';
import { LimitRequestDrawer } from './limit-request';
import { type LimitRequest, LimitRequestsApi, REQUEST_STATUS } from './limit-requests-api';

interface Row {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly unit: string;
}

/**
 * The limits a business runs into, in the order it meets them. `agents`,
 * `campaigns` and `workflow_runs` are left out on purpose: team seats are
 * `users` (what the team page enforces), and nothing meters the other two, so
 * a "0 of 2" there would only mislead.
 */
const ROWS: readonly Row[] = [
  { key: 'messages', label: 'Messages this month', icon: 'message', unit: '' },
  { key: 'channels', label: 'WhatsApp numbers', icon: 'brand-whatsapp', unit: '' },
  { key: 'contacts', label: 'Contacts', icon: 'address-book', unit: '' },
  { key: 'templates', label: 'Templates', icon: 'template', unit: '' },
  { key: 'users', label: 'Team members', icon: 'users', unit: '' },
  { key: 'storage_mb', label: 'Storage', icon: 'database', unit: ' MB' },
  { key: 'api_requests', label: 'API requests this month', icon: 'api', unit: '' },
];

/** At or past this share of a limit, the bar turns to the warning tone. */
const WARN_AT = 0.8;

/** An answered request stays on the panel this long; a pending one until it is answered. */
const ANSWER_SHOWN_MS = 14 * 864e5;

/**
 * Every limit on the business's plan against what it has used, for every plan:
 * it reads `/api/plan-usage`, which (unlike /billing/*) the smallest plan can
 * see, and that is the plan most likely to hit its limits. Sends, uploads and
 * admin edits refresh it live.
 */
@Component({
  selector: 'app-plan-usage',
  imports: [DatePipe, DecimalPipe, LimitRequestDrawer],
  templateUrl: './plan-usage.html',
  styleUrl: './plan-usage.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanUsagePanel {
  private readonly api = inject(TenancyApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);
  private readonly asksApi = inject(LimitRequestsApi);

  /** Owners and admins ask for more (the server 403s agents); a super admin sets limits directly instead. */
  protected readonly canAsk = computed(() => this.auth.atLeast('admin') && !this.auth.isSuperAdmin());
  protected readonly asking = signal(false);
  protected readonly sentNotice = signal(false);
  private readonly latestAsk = signal<LimitRequest | null>(null);
  /** The newest request while it is pending or freshly answered, so the answer is seen without opening the drawer. */
  protected readonly latest = computed(() => {
    const r = this.latestAsk();
    if (!r) return null;
    const shown = r.status === 'pending' || Date.now() - Date.parse(r.decidedAt ?? '') < ANSWER_SHOWN_MS;
    return shown ? { ...r, ...REQUEST_STATUS[r.status] } : null;
  });
  private readonly askButton = viewChild<ElementRef<HTMLButtonElement>>('askButton');

  protected readonly usage = signal<PlanUsage | null>(null);
  protected readonly subscription = signal<TenantSubscriptionState | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly ended = computed(() => this.subscription()?.state === 'expired');

  /** The server's UTC month, so the label never disagrees with the count near midnight. */
  protected readonly periodLabel = computed(() => {
    const period = this.usage()?.period;
    return period
      ? new Date(`${period}-01T00:00:00Z`).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : '';
  });

  protected readonly rows = computed(() => {
    const byKey = new Map<string, PlanUsageMetric>(
      (this.usage()?.metrics ?? []).map((m) => [m.metric, m]),
    );
    return ROWS.flatMap((row) => {
      const m = byKey.get(row.key);
      if (!m) return [];
      const share = m.limit ? m.used / m.limit : 0;
      return [
        {
          ...row,
          used: m.used,
          limit: m.limit,
          pct: Math.min(100, Math.round(share * 1000) / 10),
          tone: share >= 1 ? 'full' : share >= WARN_AT ? 'warn' : 'ok',
        },
      ];
    });
  });

  constructor() {
    this.load();
    // Sends move the message count; uploads, contacts, templates and team edits the rest;
    // an admin's plan change arrives as `tenant` / `config`.
    this.store.watch(
      ['history', 'campaign', 'campaigns', 'tenant', 'config', 'channels', 'contacts', 'templates', 'storage', 'users', 'api-keys'],
      () => this.load(),
      2000,
    );
    if (this.canAsk()) {
      this.loadLatestAsk();
      // An admin's answer reaches open pages as `tenant` / `config`.
      this.store.watch(['tenant', 'config'], () => this.loadLatestAsk(), 1000);
    }
  }

  protected openAsk(): void {
    this.sentNotice.set(false);
    this.asking.set(true);
  }

  protected closeAsk(): void {
    this.asking.set(false);
    this.askButton()?.nativeElement.focus();
  }

  protected asked(request: LimitRequest): void {
    this.latestAsk.set(request);
    this.sentNotice.set(true);
    this.closeAsk();
  }

  private loadLatestAsk(): void {
    this.asksApi
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ requests }) => this.latestAsk.set(requests[0] ?? null),
        // The status line is extra: without it the panel still shows the limits.
        error: () => undefined,
      });
  }

  protected load(): void {
    this.api
      .planUsage()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ usage, subscription }) => {
          this.usage.set(usage);
          this.subscription.set(subscription);
          this.error.set(null);
        },
        error: (err: Error) => {
          // A failed background refresh keeps the figures already shown.
          if (!this.usage()) this.error.set(err.message);
        },
      });
  }
}
