import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

import type { ChannelDetail, PlanRow } from './ops-api';

/** One number in the platform health view, with the channels-policy fields (server: adminOps.health). */
export interface NumberHealth extends ChannelDetail {
  readonly online: boolean;
  readonly lastSeenAt: string | null;
  readonly qualityRating: string | null;
  readonly pausedReason: string | null;
  readonly pausedBy: 'admin' | 'ban_guard' | null;
  readonly pausedAt: string | null;
}

const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(
    () => new Error(Array.isArray(errors) && errors.length ? errors.join('\n') : error.message || 'Request failed'),
  );
};

/** Super admin actions on a single WhatsApp number (server: policy/channelOps.js). */
@Injectable({ providedIn: 'root' })
export class ChannelsOpsApi {
  private readonly http = inject(HttpClient);

  health(): Observable<{ generatedAt: string; channels: NumberHealth[] }> {
    return this.http
      .get<{ generatedAt: string; channels: NumberHealth[] }>('/api/admin/health-detail')
      .pipe(catchError(toMessage));
  }

  /** Every business with its number count and limit, for the move dialog. */
  tenants(): Observable<{ tenants: PlanRow[] }> {
    return this.http.get<{ tenants: PlanRow[] }>('/api/admin/plans').pipe(catchError(toMessage));
  }

  pause(id: number, reason = ''): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`/api/admin/numbers/${id}/pause`, { reason }).pipe(catchError(toMessage));
  }

  resume(id: number): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`/api/admin/numbers/${id}/resume`, {}).pipe(catchError(toMessage));
  }

  disconnect(id: number): Observable<{ ok: true }> {
    return this.http.post<{ ok: true }>(`/api/admin/numbers/${id}/disconnect`, {}).pipe(catchError(toMessage));
  }

  move(id: number, tenantId: number): Observable<{ ok: true; tenantId: number }> {
    return this.http
      .post<{ ok: true; tenantId: number }>(`/api/admin/numbers/${id}/move`, { tenantId })
      .pipe(catchError(toMessage));
  }
}
