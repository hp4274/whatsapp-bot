import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

/**
 * Platform policy endpoints (`server/src/policy`). Fields are data sent by the
 * server, so the editor renders whatever rules a service declares.
 */

/** One cell of a `table` field: a number, flag, name, `[from, to]` pair or `{ days, delivered, bulk }`. */
export type PolicyCell = number | boolean | string | null | number[] | Readonly<Record<string, number>>;
export type PolicyTableRow = Readonly<Record<string, PolicyCell>>;
/** `null` only where a field defaults to null (shown as its `nullLabel`). */
export type PolicyValue = number | boolean | string | string[] | PolicyTableRow[] | null;
export type PolicyValues = Readonly<Record<string, PolicyValue>>;
/** Where an effective value came from, most specific first. */
export type PolicySource = 'tenant' | 'plan' | 'global' | 'default';

/** A column of a `table` field. A `fixed` column (and a cell whose default is null) is read-only. */
export interface PolicyColumn {
  readonly key: string;
  readonly type: 'int' | 'num' | 'bool' | 'text' | 'range' | 'need';
  readonly label: string;
  readonly min?: number;
  readonly max?: number;
  readonly fixed?: boolean;
}

export interface PolicyField {
  readonly key: string;
  readonly service: string;
  readonly group: string;
  readonly label: string;
  readonly hint?: string;
  readonly type: 'int' | 'bool' | 'enum' | 'text' | 'list' | 'table';
  readonly default: PolicyValue;
  /**
   * Where it is set; omitted = everywhere. A value with its own home elsewhere (a plan's quotas, a business's own
   * limits and anti-ban) is not offered as a rule there, so nothing shows two values.
   */
  readonly scopes?: readonly ('global' | 'plan' | 'tenant')[];
  readonly min?: number;
  readonly max?: number;
  readonly options?: readonly { readonly value: string; readonly label: string }[];
  /** An int equal to this reads as "no limit". */
  readonly unlimitedAt?: number;
  /** What a null value reads as, e.g. "Plan limit" or "No cap". */
  readonly nullLabel?: string;
  /** `table` only; the row count is fixed by `default`. */
  readonly columns?: readonly PolicyColumn[];
}

export interface PolicyPlan {
  readonly key: string;
  readonly name: string;
  readonly tier: number;
  /** Set on a business's own plan: edited from that business (Tenants), not as a plan tab. */
  readonly tenantId?: number | null;
}

export interface AutoReplyUsage {
  readonly rules: number;
  readonly activeRules: number;
  readonly replies: number;
  readonly failed: number;
}

export interface PolicyOverview {
  readonly fields: readonly PolicyField[];
  readonly global: PolicyValues;
  /** Overrides per plan key; a plan with none is absent. */
  readonly plans: Readonly<Record<string, PolicyValues>>;
  readonly planList: readonly PolicyPlan[];
}

export interface TenantPolicy {
  readonly overrides: PolicyValues;
  readonly planKey: string | null;
  readonly values: PolicyValues;
  readonly sources: Readonly<Record<string, PolicySource>>;
}

/** `global`, `plan:<key>` or `tenant:<id>`. */
export type PolicyScope = string;

/** Services that declare policy fields; every other service has no Rules section. */
export const POLICY_SERVICES: readonly string[] = [
  'whatsapp_channels',
  'templates',
  'contacts',
  'auto_replies',
  'campaigns',
  'orders',
  'appointments',
  'leads',
  'payment_reminders',
  'faq',
  'tickets',
  'otp',
  'catalog',
  'account',
];

/** Modules whose admin page shows a usage line per business (`GET /api/admin/services/:service/usage`). */
export const USAGE_SERVICES: readonly string[] = ['orders', 'appointments', 'leads', 'payment_reminders', 'faq', 'tickets', 'otp', 'catalog', 'templates', 'contacts'];

const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(
    () =>
      new Error(
        Array.isArray(errors) && errors.length
          ? errors.join('\n')
          : error.error?.message || error.message || 'Request failed',
      ),
  );
};

@Injectable({ providedIn: 'root' })
export class PolicyApi {
  private readonly http = inject(HttpClient);

  /** Auto replies per business, last 7 days: rules, replies sent, failures (keyed by tenant id). */
  autoReplyUsage(): Observable<{ usage: Record<number, AutoReplyUsage> }> {
    return this.http.get<{ usage: Record<number, AutoReplyUsage> }>('/api/admin/auto-replies/usage');
  }

  /** One line per business for a module, keyed by tenant id; a business with nothing to show is absent. */
  serviceUsage(service: string): Observable<{ usage: Record<number, string> }> {
    return this.http.get<{ usage: Record<number, string> }>(`/api/admin/services/${service}/usage`);
  }

  overview(): Observable<PolicyOverview> {
    return this.http.get<PolicyOverview>('/api/admin/policy').pipe(catchError(toMessage));
  }

  tenant(id: number): Observable<TenantPolicy> {
    return this.http
      .get<TenantPolicy>(`/api/admin/policy/tenant/${id}`)
      .pipe(catchError(toMessage));
  }

  /** `null` removes an override. Returns the overrides now stored at that scope. */
  save(
    scope: PolicyScope,
    values: Record<string, PolicyValue | null>,
  ): Observable<{ values: PolicyValues }> {
    return this.http
      .put<{ values: PolicyValues }>(`/api/admin/policy/${encodeURIComponent(scope)}`, { values })
      .pipe(catchError(toMessage));
  }
}
