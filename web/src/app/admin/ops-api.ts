import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import type { TenantLimits } from '../core/api';
import type { Tenant, TenantControls } from '../core/auth';

/** Read-only super admin endpoints behind the ops pages (Plans, Usage, Health, Audit, Channels). */

export interface PlanRow {
  tenantId: number;
  name: string;
  slug: string;
  status: Tenant['status'];
  services: string[];
  controls: TenantControls;
  limits: TenantLimits;
  safety: Record<string, number | boolean | string>;
  customSafetyActive: boolean;
  usage: { channels: number; users: number; templates: number };
}

export interface UsageBucket {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  queued: number;
  sandbox: number;
  total: number;
}

export interface UsageRow {
  tenantId: number;
  name: string;
  slug: string;
  status: Tenant['status'];
  today: UsageBucket;
  d7: UsageBucket;
  d30: UsageBucket;
  daily: number[];
  dailyFailed: number[];
  byType: Record<string, number>;
  campaigns: number;
  autoReplies: number;
  media: number;
}

export interface UsageSummary {
  generatedAt: string;
  days: string[];
  totals: { today: UsageBucket; d7: UsageBucket; d30: UsageBucket };
  tenants: UsageRow[];
}

export type LiveState =
  | 'connected'
  | 'connecting'
  | 'qr'
  | 'auth_failure'
  | 'error'
  | 'disconnected'
  | 'idle'
  | 'disabled';
export type Severity = 'bad' | 'warn' | 'ok' | 'off';

export interface ChannelDetail {
  tenantId: number;
  tenantName: string;
  tenantSlug: string;
  tenantStatus: Tenant['status'];
  id: number;
  displayName: string;
  phoneNumber: string;
  provider: string;
  status: 'active' | 'disabled';
  isDefault: boolean;
  state: LiveState;
  account: string;
  detail: string;
  error: string | null;
  withinSendingWindow: boolean;
  queue: number;
  waiting: number;
  lastSentAt: string | null;
  lastHour: { total: number; failed: number; failureRate: number };
  quota: { enabled: boolean; limit: number; used: number; remaining: number | null };
  warmup: { days: number; day: number; active: boolean; started: boolean } | null;
  problems: { level: 'bad' | 'warn'; text: string }[];
  severity: Severity;
}

export type AuditVerb = 'create' | 'change' | 'remove' | 'other';

export interface AuditEntry {
  id: number;
  tenantId: number | null;
  userId: number | null;
  userEmail: string;
  action: string;
  verb: AuditVerb;
  target: string;
  detail: string;
  createdAt: string;
}

export interface AuditFilter {
  tenant?: string;
  user?: string;
  verb?: string;
  from?: string;
  to?: string;
  q?: string;
}

export interface AuditPage {
  logs: AuditEntry[];
  nextBefore: number | null;
  users?: { id: number; email: string }[];
}

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

const filterParams = (filter: AuditFilter, extra: Record<string, string | number> = {}) => {
  let params = new HttpParams();
  for (const [key, value] of Object.entries({ ...filter, ...extra })) {
    if (value !== undefined && value !== null && value !== '')
      params = params.set(key, String(value));
  }
  return params;
};

@Injectable({ providedIn: 'root' })
export class OpsApi {
  private readonly http = inject(HttpClient);

  plans(): Observable<{ services: string[]; tenants: PlanRow[] }> {
    return this.http
      .get<{ services: string[]; tenants: PlanRow[] }>('/api/admin/plans')
      .pipe(catchError(toMessage));
  }

  usage(days = 14): Observable<UsageSummary> {
    return this.http
      .get<UsageSummary>('/api/admin/usage-summary', { params: { days } })
      .pipe(catchError(toMessage));
  }

  health(): Observable<{ generatedAt: string; channels: ChannelDetail[] }> {
    return this.http
      .get<{ generatedAt: string; channels: ChannelDetail[] }>('/api/admin/health-detail')
      .pipe(catchError(toMessage));
  }

  audit(filter: AuditFilter, before?: number | null, limit = 50): Observable<AuditPage> {
    const params = filterParams(filter, before ? { before, limit } : { limit });
    return this.http
      .get<AuditPage>('/api/admin/audit-logs', { params })
      .pipe(catchError(toMessage));
  }

  auditCsv(filter: AuditFilter): Observable<string> {
    return this.http
      .get('/api/admin/audit-logs', {
        params: filterParams(filter, { format: 'csv', limit: 10000 }),
        responseType: 'text',
      })
      .pipe(catchError(toMessage));
  }
}
