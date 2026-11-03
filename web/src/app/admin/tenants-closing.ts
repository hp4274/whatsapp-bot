import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';

import type { Tenant, TenantSubscriptionSummary } from '../core/auth';

const DAY_MS = 24 * 3600 * 1000;
/** How far ahead "closing soon" looks. */
const WINDOW_DAYS = 7;

/** What ends next for a subscription, and when; null when nothing ends (it renews monthly with no end date). */
export function nextEnd(sub: TenantSubscriptionSummary | null | undefined, now: number): { at: number; label: string } | null {
  if (!sub || sub.state === 'expired') return null;
  const ends: { at: number; label: string }[] = [];
  const add = (iso: string | null | undefined, label: string) => {
    const at = iso ? Date.parse(iso) : NaN;
    if (Number.isFinite(at)) ends.push({ at, label });
  };
  // Already past its end and in grace: the grace running out is what comes next.
  if (sub.state === 'grace') add(sub.graceEndsAt, 'Grace ends');
  if (sub.state === 'trialing') add(sub.trialEndsAt, 'Trial ends');
  if (sub.cancelAtPeriodEnd) add(sub.currentPeriodEnd, 'Cancels');
  add(sub.validUntil, 'Plan ends');
  const upcoming = ends.filter((e) => e.at >= now).sort((a, b) => a.at - b.at);
  return upcoming[0] ?? null;
}

/**
 * Under the tenant list: the businesses whose plan ends in the next 7 days (a trial, an end date, a cancellation,
 * or the grace after one), soonest first, each one click from its Plan tab to renew, top up or extend it.
 */
@Component({
  selector: 'app-tenants-closing',
  imports: [DatePipe],
  template: `
    @if (rows().length) {
      <section class="closing" aria-labelledby="closing-title">
        <div class="head">
          <h3 id="closing-title">Closing soon <span class="s-pill tone-warn">{{ rows().length }}</span></h3>
          <p>Plans ending in the next 7 days. Renew, top up or extend them under Plan.</p>
        </div>
        <ul>
          @for (r of rows(); track r.tenant.id) {
            <li [class.urgent]="r.days <= 1">
              <span class="avatar" aria-hidden="true">{{ r.tenant.name.charAt(0) }}</span>
              <span class="who">
                <b>{{ r.tenant.name }}</b>
                <small>#{{ serialOf()(r.tenant) }} &middot; {{ r.tenant.subscription?.planName }}</small>
              </span>
              <span class="when">
                <b>{{ r.label }} {{ r.at | date: 'd MMM' }}</b>
                <small>{{ r.days === 0 ? 'today' : r.days === 1 ? 'tomorrow' : 'in ' + r.days + ' days' }}</small>
              </span>
              <button class="btn sm" type="button" (click)="open.emit(r.tenant)">Open plan</button>
            </li>
          }
        </ul>
      </section>
    }
  `,
  styleUrl: './tenants-closing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantsClosing {
  readonly tenants = input.required<readonly Tenant[]>();
  /** The list's own numbering (1, 2, 3...), so a business carries the same number here as on its card. */
  readonly serialOf = input.required<(tenant: Tenant) => number>();
  readonly open = output<Tenant>();

  protected readonly rows = computed(() => {
    const now = Date.now();
    const until = now + WINDOW_DAYS * DAY_MS;
    return this.tenants()
      .filter((t) => t.status === 'active' || t.status === 'suspended')
      .map((tenant) => ({ tenant, end: nextEnd(tenant.subscription, now) }))
      .filter((r): r is { tenant: Tenant; end: { at: number; label: string } } => !!r.end && r.end.at <= until)
      .sort((a, b) => a.end.at - b.end.at)
      .map(({ tenant, end }) => ({
        tenant,
        at: end.at,
        label: end.label,
        // Whole days left, counted by calendar day, so "tomorrow" means tomorrow.
        days: Math.round((new Date(end.at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY_MS),
      }));
  });
}
