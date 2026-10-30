import { DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { type PlanUsage, type PlanUsageMetric, TenancyApi, type TenantSubscriptionState } from '../core/api';
import { Store } from '../core/store';

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

/**
 * Every limit on the business's plan against what it has used, for every plan:
 * it reads `/api/plan-usage`, which (unlike /billing/*) the smallest plan can
 * see, and that is the plan most likely to hit its limits. Sends, uploads and
 * admin edits refresh it live.
 */
@Component({
  selector: 'app-plan-usage',
  imports: [DecimalPipe],
  templateUrl: './plan-usage.html',
  styleUrl: './plan-usage.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanUsagePanel {
  private readonly api = inject(TenancyApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly store = inject(Store);

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
