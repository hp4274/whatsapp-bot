import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import type { Tenant, TenantSubscriptionSummary } from '../core/auth';

/** The tenant limits a plan applies; same keys as the tenancy LIMIT_SPEC, 0 = no limit. */
export interface PlanTenantLimits {
  readonly maxChannels: number;
  readonly maxUsers: number;
  readonly maxTemplates: number;
  readonly maxContactsPerCampaign: number;
  readonly maxMediaMb: number;
  readonly allowCloudApi: boolean;
  readonly allowWhatsappWeb: boolean;
}

export interface Plan {
  readonly key: string;
  readonly name: string;
  readonly tier: number;
  readonly description: string;
  /** Major units; 0 = free / custom pricing. */
  readonly price: number;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly trialDays: number;
  readonly services: readonly string[];
  readonly tenantLimits: PlanTenantLimits;
  /** False = archived: hidden from pickers, existing subscribers keep it. */
  readonly active: boolean;
  /** Only on the admin list endpoint. */
  readonly subscribers?: number;
}

/** What `PUT /tenants/:id/subscription` and `DELETE` return. */
export interface Subscription {
  readonly planKey: string;
  readonly state: SubscriptionState;
  readonly status: string;
  readonly startsAt: string | null;
  readonly trialEndsAt: string | null;
  readonly currentPeriodEnd: string | null;
  readonly pendingPlanKey: string | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly cancelledAt: string | null;
  readonly graceEndsAt: string | null;
}

export type SubscriptionState = 'trialing' | 'active' | 'grace' | 'expired';

/** Number limits shown on plan cards and in the editor, in display order. */
export const PLAN_LIMIT_FIELDS: readonly {
  readonly key: 'maxChannels' | 'maxUsers' | 'maxTemplates' | 'maxContactsPerCampaign' | 'maxMediaMb';
  readonly label: string;
}[] = [
  { key: 'maxChannels', label: 'WhatsApp numbers' },
  { key: 'maxUsers', label: 'Team members' },
  { key: 'maxTemplates', label: 'Templates' },
  { key: 'maxContactsPerCampaign', label: 'Contacts / campaign' },
  { key: 'maxMediaMb', label: 'Upload MB' },
];

/** "₹999/month", or "Custom" for price 0 (enterprise is quoted, not listed). */
export function formatPrice(plan: Pick<Plan, 'price' | 'currency' | 'interval'>): string {
  if (!plan.price) return 'Custom';
  return `${money(plan.price, plan.currency)}/${plan.interval}`;
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // unknown currency code: still show the number
    return `${currency} ${amount}`;
  }
}

/** Pill tone class per state, shared by the plans page, tenant cards and settings drawer. */
export function stateTone(state: SubscriptionState | undefined | null): string {
  switch (state) {
    case 'active':
      return 'tone-ok';
    case 'trialing':
      return 'tone-info';
    case 'grace':
      return 'tone-warn';
    case 'expired':
      return 'tone-bad';
    default:
      return 'tone-mute';
  }
}

/** The one date that matters for a subscription right now, as a short sentence. */
export function subscriptionWhen(sub: TenantSubscriptionSummary | Subscription): string {
  const d = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');
  if (sub.state === 'trialing' && sub.trialEndsAt) return `Trial ends ${d(sub.trialEndsAt)}`;
  if (sub.state === 'grace' && sub.graceEndsAt) return `Grace until ${d(sub.graceEndsAt)}`;
  if (sub.state === 'expired') return 'Ended';
  if (!sub.currentPeriodEnd) return '';
  return `${sub.cancelAtPeriodEnd ? 'Ends' : 'Renews'} ${d(sub.currentPeriodEnd)}`;
}

function toMessage(error: HttpErrorResponse) {
  const errors = error.error?.errors;
  const message =
    Array.isArray(errors) && errors.length
      ? errors.join('\n')
      : error.error?.message || error.error?.error || error.message || 'Request failed';
  return throwError(() => new Error(message));
}

/** Super admin plan catalogue and per-business subscriptions. */
@Injectable({ providedIn: 'root' })
export class PlansApi {
  private readonly http = inject(HttpClient);

  plans(): Observable<{ plans: Plan[]; services: string[] }> {
    return this.http
      .get<{ plans: Plan[]; services: string[] }>('/api/admin/billing/plans')
      .pipe(catchError(toMessage));
  }

  savePlan(plan: Plan): Observable<{ plan: Plan }> {
    return this.http
      .put<{ plan: Plan }>(`/api/admin/billing/plans/${encodeURIComponent(plan.key)}`, plan)
      .pipe(catchError(toMessage));
  }

  /** Reverts a built-in plan to its constant, or removes a custom one (409 with subscribers). */
  deletePlan(key: string): Observable<{ plan?: Plan; removed?: boolean }> {
    return this.http
      .delete<{ plan?: Plan; removed?: boolean }>(
        `/api/admin/billing/plans/${encodeURIComponent(key)}`,
      )
      .pipe(catchError(toMessage));
  }

  /** Change plan or renew (same key): immediate, resets the period, applies services + limits. */
  subscribe(
    tenantId: number,
    planKey: string,
    trialDays?: number,
  ): Observable<{ subscription: Subscription; tenant: Tenant }> {
    return this.http
      .put<{ subscription: Subscription; tenant: Tenant }>(
        `/api/admin/tenants/${tenantId}/subscription`,
        trialDays === undefined ? { planKey } : { planKey, trialDays },
      )
      .pipe(catchError(toMessage));
  }

  cancel(tenantId: number, immediate: boolean): Observable<{ subscription: Subscription }> {
    return this.http
      .delete<{ subscription: Subscription }>(`/api/admin/tenants/${tenantId}/subscription`, {
        params: immediate ? { immediate: 'true' } : {},
      })
      .pipe(catchError(toMessage));
  }
}
