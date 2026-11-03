import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import type { Tenant, TenantSubscriptionSummary } from '../core/auth';

/** The tenant limits a plan applies; same keys as the tenancy LIMIT_SPEC, 0 = no limit. */
/** null = no limit, 0 = none allowed. */
export interface PlanTenantLimits {
  readonly maxChannels: number | null;
  readonly maxUsers: number | null;
  readonly maxTemplates: number | null;
  readonly maxContactsPerCampaign: number | null;
  readonly maxMediaMb: number | null;
  readonly allowWhatsappWeb: boolean;
}

/**
 * The plan's metered quotas (server billing/plans.js `limits`). Unlike the tenant
 * limits, null is unlimited and 0 is none at all (Starter's 0 API requests = no API).
 */
export interface PlanQuotas {
  readonly messagesPerMonth: number | null;
  readonly apiRequests: number | null;
  readonly storageMb: number | null;
  readonly [key: string]: number | null;
}

/** Quotas shown on plan cards and in the editor; the rest are not enforced, so not offered. */
export const PLAN_QUOTA_FIELDS: readonly {
  readonly key: 'messagesPerMonth' | 'apiRequests' | 'storageMb';
  readonly label: string;
}[] = [
  { key: 'messagesPerMonth', label: 'Messages / month' },
  { key: 'apiRequests', label: 'API requests / month' },
  { key: 'storageMb', label: 'Storage MB' },
];

export interface Plan {
  readonly key: string;
  readonly name: string;
  /** Set on a business's own plan (Tenant settings > Create plan): only that business is ever on it. */
  readonly tenantId?: number | null;
  readonly tier: number;
  readonly description: string;
  /** Major units; 0 = free / custom pricing. */
  readonly price: number;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly trialDays: number;
  readonly services: readonly string[];
  readonly tenantLimits: PlanTenantLimits;
  readonly limits: PlanQuotas;
  /** False = archived: hidden from pickers, existing subscribers keep it. */
  readonly active: boolean;
  /** Only on the admin list endpoint. */
  readonly subscribers?: number;
  /** Only on the admin list endpoint: messages a day per number (the plan's channels.dailyCap rule); 0/null = none. */
  readonly dailyCap?: number | null;
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
  readonly payment?: Payment | null;
  /** The plan's end date; null = none (renews monthly). */
  readonly validUntil?: string | null;
  /** Extra messages topped up for this month. */
  readonly topupMessages?: number;
  /** What this business pays on a plan with no list price (Enterprise, custom); null = none agreed. */
  readonly customPrice?: number | null;
  /** How often the business is billed; the plan's own interval until one is chosen. */
  readonly billingCycle?: BillingCycle;
  /** When the next billing cycle starts: the start date plus one cycle. */
  readonly renewsAt?: string;
}

/** How often a business is billed (server billing/store.js BILLING_CYCLES), with the months in each. */
export type BillingCycle = 'month' | 'quarter' | 'year';
export const BILLING_CYCLES: readonly { readonly key: BillingCycle; readonly label: string; readonly every: string; readonly months: number }[] = [
  { key: 'month', label: 'Monthly', every: 'month', months: 1 },
  { key: 'quarter', label: 'Quarterly', every: 'quarter', months: 3 },
  { key: 'year', label: 'Annual', every: 'year', months: 12 },
];

/** One cycle's price from a price per `interval`, as the server charges it (billing/store.js cycleAmount). */
export function cycleAmount(price: number, interval: 'month' | 'year', cycle: BillingCycle): number {
  const months = BILLING_CYCLES.find((c) => c.key === cycle)?.months ?? 1;
  return Math.round((price / (interval === 'year' ? 12 : 1)) * months);
}

/** One row of Tenant settings > Limits: used against the limit (null = no limit, 0 = none allowed). */
export interface UsageRow {
  readonly key: string;
  readonly label: string;
  readonly used: number;
  readonly limit: number | null;
}

/** One entry of a business's plan history (the audit log, filtered to plan actions). */
export interface PlanLogEntry {
  readonly id: number;
  readonly summary: string;
  readonly createdAt: string;
  readonly actor: { readonly name: string; readonly email: string } | 'System';
}

/**
 * A business's plan history: the plan it started on, every plan put on, renewed or cancelled, and the top-ups and
 * end dates of it. Not limit edits, payment marks or activation: those are settings, not plan changes.
 */
const PLAN_LOG_ACTIONS = [
  'tenant.create',
  'tenant.subscription',
  'tenant.subscription.cancel',
  'tenant.topup',
  'tenant.validity',
  'tenant.price',
  'tenant.cycle',
  'tenant.start',
].join(',');

/** How a business pays (server billing/schema.js PAYMENTS): paid is charged for its plan and top-ups, free is not. */
export type Payment = 'paid' | 'free';
export const PAYMENTS: readonly { readonly key: Payment; readonly label: string; readonly tone: string }[] = [
  { key: 'paid', label: 'Paid', tone: 'tone-ok' },
  { key: 'free', label: 'Free', tone: 'tone-info' },
];

/** How a business is billed, as shown: Paid, Free, or Hybrid (a free plan whose top-ups are charged). */
export type Billing = Payment | 'hybrid';
export const BILLINGS: Record<Billing, { readonly label: string; readonly tone: string }> = {
  paid: { label: 'Paid', tone: 'tone-ok' },
  free: { label: 'Free', tone: 'tone-info' },
  hybrid: { label: 'Hybrid', tone: 'tone-info' },
};

/** Paid, Free, or Hybrid when a free plan has charged top-ups; null when how it pays was never recorded. */
export function billingOf(payment: Payment | null | undefined, topupCharged = 0): Billing | null {
  if (!payment) return null;
  return payment === 'free' ? (topupCharged > 0 ? 'hybrid' : 'free') : 'paid';
}

/** How a payment came in (server billing/ledger.js PAYMENT_METHODS). */
export type PaymentMethod = 'upi' | 'bank' | 'cash';
export const PAYMENT_METHODS: readonly { readonly key: PaymentMethod; readonly label: string; readonly icon: string }[] = [
  { key: 'upi', label: 'UPI', icon: 'qrcode' },
  { key: 'bank', label: 'Bank transfer', icon: 'building-bank' },
  { key: 'cash', label: 'Cash', icon: 'cash' },
];

/** Charged, paid and still due (server billing/ledger.js totals). */
export interface Balance {
  readonly planCharged: number;
  readonly topupCharged: number;
  readonly charged: number;
  readonly paid: number;
  readonly due: number;
}

/** One line of a business's payment history: a charge (plan, top-up) or a payment recorded. */
export interface LedgerEntry {
  readonly id: number;
  readonly kind: 'plan' | 'topup' | 'payment';
  readonly amount: number;
  readonly currency: string;
  readonly note: string;
  /** A payment's: how it came in. */
  readonly method?: PaymentMethod | null;
  readonly at: string;
}

/** Tenant settings > Payments: the business's statement. */
export interface Statement extends Balance {
  readonly entries: LedgerEntry[];
  readonly currency: string;
  readonly interval: 'month' | 'year';
  /** What its plan bills at: the list price, else the amount agreed; null for none. */
  readonly planPrice: number | null;
  readonly payment: Payment | null;
}

/** The Payments page: one business's money at a glance. */
export interface PaymentRow extends Balance {
  readonly tenantId: number;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly planKey: string | null;
  readonly planName: string | null;
  readonly planPrice: number | null;
  readonly currency: string;
  readonly interval: 'month' | 'year';
  readonly payment: Payment | null;
  readonly state: SubscriptionState | null;
  readonly validUntil: string | null;
  readonly lastPaidAt: string | null;
}

export type SubscriptionState = 'trialing' | 'active' | 'grace' | 'expired';

/** Number limits shown on plan cards and in the editor, in display order. */
// Uploads are not a plan limit: every business gets the platform's fixed 10 MB (server templates/policy.js).
export const PLAN_LIMIT_FIELDS: readonly {
  readonly key: 'maxChannels' | 'maxUsers' | 'maxTemplates' | 'maxContactsPerCampaign';
  readonly label: string;
}[] = [
  { key: 'maxChannels', label: 'WhatsApp numbers' },
  { key: 'maxUsers', label: 'Team members' },
  { key: 'maxTemplates', label: 'Templates' },
  { key: 'maxContactsPerCampaign', label: 'Contacts / campaign' },
];

/** The limits a single business's settings show and change (Plan tab), and that Limits shows usage against. */
export const TENANT_LIMIT_FIELDS: readonly {
  readonly key: 'maxChannels' | 'maxUsers' | 'maxTemplates';
  readonly label: string;
}[] = [
  { key: 'maxChannels', label: 'WhatsApp numbers' },
  { key: 'maxUsers', label: 'Team members' },
  { key: 'maxTemplates', label: 'Templates' },
];

/** A limit for reading: null is no limit, 0 is none allowed. */
export function limitText(value: number | null | undefined): string {
  return value === null || value === undefined ? 'No limit' : value.toLocaleString();
}

/** What a business pays: the agreed amount on a plan with no list price, else the plan's price ("Custom" if none). */
export function paidPrice(plan: Pick<Plan, 'price' | 'currency' | 'interval'>, customPrice?: number | null): string {
  if (!plan.price && customPrice !== null && customPrice !== undefined) {
    return `${money(customPrice, plan.currency)}/${plan.interval} (agreed)`;
  }
  return formatPrice(plan);
}

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
  // "15 Jan 2027", as the dates in Tenant settings read.
  const d = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  if (sub.state === 'trialing' && sub.trialEndsAt) return `Trial ends ${d(sub.trialEndsAt)}`;
  if (sub.state === 'grace' && sub.graceEndsAt) return `Grace until ${d(sub.graceEndsAt)}`;
  if (sub.state === 'expired') return 'Ended';
  // Cancelling ends with the usage period; otherwise the next billing renewal (start date plus one cycle).
  if (sub.cancelAtPeriodEnd) return sub.currentPeriodEnd ? `Ends ${d(sub.currentPeriodEnd)}` : '';
  const renews = sub.renewsAt ?? sub.currentPeriodEnd;
  return renews ? `Renews ${d(renews)}` : '';
}

export function toMessage(error: HttpErrorResponse) {
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
    payment?: Payment,
    amount?: number | null,
  ): Observable<{ subscription: Subscription; tenant: Tenant }> {
    return this.http
      .put<{ subscription: Subscription; tenant: Tenant }>(
        `/api/admin/tenants/${tenantId}/subscription`,
        {
          planKey,
          ...(trialDays === undefined ? {} : { trialDays }),
          ...(payment ? { payment } : {}),
          // The price on a plan without one (Enterprise, custom); charged now, unpaid until paid.
          ...(amount ? { amount } : {}),
        },
      )
      .pipe(catchError(toMessage));
  }

  /** The agreed amount on a plan with no list price, or null to remove it. */
  setCustomPrice(tenantId: number, amount: number | null): Observable<{ subscription: Subscription; tenant: Tenant }> {
    return this.http
      .put<{ subscription: Subscription; tenant: Tenant }>(`/api/admin/tenants/${tenantId}/price`, { amount })
      .pipe(catchError(toMessage));
  }

  /** The plan's end date (YYYY-MM-DD), or null to remove it. */
  /** Create plan: the business's own plan, made from what it has now; it moves onto it in the same period. */
  createOwnPlan(tenantId: number): Observable<{ subscription: Subscription; plan: Plan; tenant: Tenant }> {
    return this.http
      .post<{ subscription: Subscription; plan: Plan; tenant: Tenant }>(`/api/admin/tenants/${tenantId}/own-plan`, {})
      .pipe(catchError(toMessage));
  }

  /** Billed monthly, quarterly or annually; charged now when nothing was this period. */
  setCycle(tenantId: number, cycle: BillingCycle): Observable<{ subscription: Subscription; tenant: Tenant }> {
    return this.http
      .put<{ subscription: Subscription; tenant: Tenant }>(`/api/admin/tenants/${tenantId}/cycle`, { cycle })
      .pipe(catchError(toMessage));
  }

  /** When the plan started (YYYY-MM-DD); the next renewal counts from it. */
  setStart(tenantId: number, startsAt: string): Observable<{ subscription: Subscription; tenant: Tenant }> {
    return this.http
      .put<{ subscription: Subscription; tenant: Tenant }>(`/api/admin/tenants/${tenantId}/start`, { startsAt })
      .pipe(catchError(toMessage));
  }

  setValidity(tenantId: number, validUntil: string | null): Observable<{ subscription: Subscription; tenant: Tenant }> {
    return this.http
      .put<{ subscription: Subscription; tenant: Tenant }>(`/api/admin/tenants/${tenantId}/validity`, { validUntil })
      .pipe(catchError(toMessage));
  }

  /** More days of validity and/or more messages this month; `amount` (optional) is charged for it. */
  topUp(
    tenantId: number,
    body: { days: number; messages: number; amount?: number },
  ): Observable<{ subscription: Subscription; tenant: Tenant }> {
    return this.http
      .post<{ subscription: Subscription; tenant: Tenant }>(`/api/admin/tenants/${tenantId}/topup`, body)
      .pipe(catchError(toMessage));
  }

  /** What the business has used against each limit, this month. */
  usage(tenantId: number): Observable<{ period: string; rows: UsageRow[]; uploadMb: number }> {
    return this.http
      .get<{ period: string; rows: UsageRow[]; uploadMb: number }>(`/api/admin/tenants/${tenantId}/usage`)
      .pipe(catchError(toMessage));
  }

  /** The business's plan history, newest first. */
  history(tenantId: number): Observable<{ logs: PlanLogEntry[] }> {
    return this.http
      .get<{ logs: PlanLogEntry[] }>('/api/admin/audit-logs', {
        params: { tenant: tenantId, actions: PLAN_LOG_ACTIONS, limit: 30 },
      })
      .pipe(catchError(toMessage));
  }

  /** Paid or free; leaves the plan and its period alone, and charges nothing. */
  setPayment(tenantId: number, payment: Payment): Observable<{ subscription: Subscription }> {
    return this.http
      .put<{ subscription: Subscription }>(`/api/admin/tenants/${tenantId}/payment`, { payment })
      .pipe(catchError(toMessage));
  }

  /** The business's charges and payments, newest first, with the totals. */
  statement(tenantId: number): Observable<Statement> {
    return this.http.get<Statement>(`/api/admin/tenants/${tenantId}/payments`).pipe(catchError(toMessage));
  }

  /** "They paid": the amount, an optional note (how, a reference) and the day (default today). */
  recordPayment(
    tenantId: number,
    body: { amount: number; method: PaymentMethod; note?: string; paidAt?: string },
  ): Observable<Statement> {
    return this.http.post<Statement>(`/api/admin/tenants/${tenantId}/payments`, body).pipe(catchError(toMessage));
  }

  /** Remove a charge or payment entered by mistake. */
  removeEntry(tenantId: number, entryId: number): Observable<Balance & { entries: LedgerEntry[] }> {
    return this.http
      .delete<Balance & { entries: LedgerEntry[] }>(`/api/admin/tenants/${tenantId}/payments/${entryId}`)
      .pipe(catchError(toMessage));
  }

  /** Every business's plan price, charges, payments and balance. */
  payments(): Observable<{ rows: PaymentRow[] }> {
    return this.http.get<{ rows: PaymentRow[] }>('/api/admin/payments').pipe(catchError(toMessage));
  }

  cancel(tenantId: number, immediate: boolean): Observable<{ subscription: Subscription }> {
    return this.http
      .delete<{ subscription: Subscription }>(`/api/admin/tenants/${tenantId}/subscription`, {
        params: immediate ? { immediate: 'true' } : {},
      })
      .pipe(catchError(toMessage));
  }
}
