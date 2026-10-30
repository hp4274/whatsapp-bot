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
  problems: { level: 'bad' | 'warn'; text: string }[];
  severity: Severity;
}

/**
 * What the ops tables print in place of a daily cap of 0. On a QR number with safety on, 0 is
 * the rest after a link or a ban (sending levels: 0 means none today), not "no cap".
 */
export function zeroCapLabel(c: Pick<ChannelDetail, 'provider' | 'quota'>): string {
  return c.provider === 'baileys' && c.quota.enabled ? 'Resting' : 'no cap';
}

export type AuditVerb = 'create' | 'change' | 'remove' | 'other';

/** How loud an audit entry or log line is; drives its dot colour. */
export type LogSeverity = 'info' | 'warn' | 'danger';

/** Who made a change: a signed-in user, or "System" for sweeps, alerts and finished runs. */
export type AuditActor = { readonly name: string; readonly email: string; readonly role: string } | 'System';

/** One audit row: the plain sentence (server: observability/auditText.js) and the raw record behind it. */
export interface AuditEntry {
  readonly id: number;
  readonly tenantId: number | null;
  readonly tenantName: string | null;
  readonly userId: number | null;
  readonly userEmail: string;
  readonly actor: AuditActor;
  readonly action: string;
  readonly verb: AuditVerb;
  readonly target: string;
  readonly detail: string;
  readonly summary: string;
  readonly severity: LogSeverity;
  readonly category: string;
  readonly ip: string | null;
  readonly requestId: string | null;
  readonly createdAt: string;
}

export interface AuditFilter {
  tenant?: string;
  user?: string;
  verb?: string;
  from?: string;
  to?: string;
  q?: string;
}

/** One backend log line (server: observability/logBuffer.js), already redacted. */
export interface LogLine {
  readonly id: number;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly time: string;
  readonly summary: string;
  readonly severity: LogSeverity;
  readonly requestId: string | null;
  readonly tenantId: number | null;
  readonly line: Readonly<Record<string, unknown>>;
}

export interface LogFilter {
  level?: string;
  q?: string;
  requestId?: string;
}

export interface LogPage {
  readonly lines: LogLine[];
  readonly nextBefore: number | null;
  readonly size: number;
  readonly capacity: number;
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

const filterParams = (
  filter: AuditFilter | LogFilter,
  extra: Record<string, string | number | undefined> = {},
) => {
  let params = new HttpParams();
  for (const [key, value] of Object.entries({ ...filter, ...extra })) {
    if (value !== undefined && value !== null && value !== '')
      params = params.set(key, String(value));
  }
  return params;
};

/** The last daily encrypted backup (server: backup.js lastBackup); null until the first run. */
export interface BackupStatus {
  readonly at: string;
  readonly day: string;
  readonly ok: boolean;
  readonly bytes?: number;
  readonly loginFiles?: number;
  readonly error?: string | null;
}

export interface HealthDetail {
  readonly generatedAt: string;
  readonly channels: ChannelDetail[];
  readonly backup?: BackupStatus | null;
}

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

  health(): Observable<HealthDetail> {
    return this.http
      .get<HealthDetail>('/api/admin/health-detail')
      .pipe(catchError(toMessage));
  }

  audit(filter: AuditFilter, before?: number | null, limit = 50): Observable<AuditPage> {
    const params = filterParams(filter, before ? { before, limit } : { limit });
    return this.http
      .get<AuditPage>('/api/admin/audit-logs', { params })
      .pipe(catchError(toMessage));
  }

  /** Entries newer than `after`, for prepending live without reloading what is shown. */
  auditSince(filter: AuditFilter, after: number, limit = 200): Observable<AuditPage> {
    return this.http
      .get<AuditPage>('/api/admin/audit-logs', { params: filterParams(filter, { after, limit }) })
      .pipe(catchError(toMessage));
  }

  /** Recent backend log lines, newest first; `after` returns only newer ones. */
  logs(filter: LogFilter, cursor: { before?: number; after?: number } = {}, limit = 100): Observable<LogPage> {
    return this.http
      .get<LogPage>('/api/admin/logs', { params: filterParams(filter, { ...cursor, limit }) })
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
