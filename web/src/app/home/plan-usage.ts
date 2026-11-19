import { DecimalPipe, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { type PlanUsage, type PlanUsageMetric, TenancyApi, type TenantSubscriptionState } from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';

interface Row {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly unit: string;
  /** What a limit of 0 means for this row; "Not on your plan" when unset. */
  readonly none?: string;
}

/**
 * The limits a business runs into, in the order it meets them. `agents`, `campaigns` and `workflow_runs` are
 * left out on purpose: team seats are `users` (what the team page enforces), and nothing meters the other two,
 * so a "0 of 2" there would only mislead. API requests are left out too: the API is not offered yet.
 */
const MAIN: readonly Row[] = [
  { key: 'today', label: 'Messages today', icon: 'send', unit: '', none: 'None today' },
  { key: 'messages', label: 'Messages this month', icon: 'message', unit: '' },
  { key: 'contacts', label: 'Contacts', icon: 'address-book', unit: '' },
  { key: 'channels', label: 'WhatsApp numbers', icon: 'brand-whatsapp', unit: '' },
];

/** Limits a business rarely reaches; folded under "More limits" so the four above are read first. */
const MORE: readonly Row[] = [
  { key: 'templates', label: 'Templates', icon: 'template', unit: '' },
  { key: 'users', label: 'Team members', icon: 'users', unit: '' },
  { key: 'storage_mb', label: 'Storage', icon: 'database', unit: ' MB' },
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
  imports: [DecimalPipe, NgTemplateOutlet, RouterLink],
  templateUrl: './plan-usage.html',
  styleUrl: './plan-usage.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanUsagePanel {
  private readonly api = inject(TenancyApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);

  /** Owners and admins (and a super admin inside the business) ask for more, on the WhatsApp page; the server 403s agents. */
  protected readonly canAsk = computed(() => this.auth.atLeast('admin'));

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

  private readonly byKey = computed(
    () => new Map<string, PlanUsageMetric>((this.usage()?.metrics ?? []).map((m) => [m.metric, m])),
  );
  protected readonly main = computed(() => this.meters(MAIN));
  protected readonly more = computed(() => this.meters(MORE));
  /** A folded limit that is nearly or fully used opens the fold, so "full" is never hidden. */
  protected readonly moreNeedsLook = computed(() => this.more().some((r) => r.tone !== 'ok'));

  private meters(rows: readonly Row[]) {
    return rows.flatMap((row) => {
      const m = this.byKey().get(row.key);
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
  }

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
