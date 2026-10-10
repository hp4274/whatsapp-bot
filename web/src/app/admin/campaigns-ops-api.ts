import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

export type CampaignStatus = 'draft' | 'scheduled' | 'running' | 'paused' | 'done' | 'cancelled';
export type CampaignFilter = 'all' | 'running' | 'paused' | 'scheduled' | 'done' | 'cancelled';

/** One bulk campaign in the cross-tenant view (server: GET /api/admin/campaigns). */
export interface OpsCampaign {
  readonly id: number;
  readonly tenantId: number;
  readonly tenantName: string;
  readonly name: string;
  readonly status: CampaignStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly scheduledAt: string | null;
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  /** Percent, one decimal. */
  readonly failureRate: number;
  readonly statusReason: string | null;
}

export interface CampaignActionResult {
  readonly campaign: {
    readonly id: number;
    readonly status: CampaignStatus;
    readonly options: { readonly statusReason?: string | null };
  };
}

export interface StopAllResult {
  readonly dropped: number;
  readonly cancelled: number;
  readonly killSwitch: boolean;
}

const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(
    () => new Error(Array.isArray(errors) && errors.length ? errors.join('\n') : error.message || 'Request failed'),
  );
};

/** Super admin control over every business's bulk sends. */
@Injectable({ providedIn: 'root' })
export class CampaignsOpsApi {
  private readonly http = inject(HttpClient);

  list(status: CampaignFilter): Observable<{ killSwitch: boolean; campaigns: OpsCampaign[] }> {
    return this.http
      .get<{ killSwitch: boolean; campaigns: OpsCampaign[] }>('/api/admin/campaigns', { params: { status } })
      .pipe(catchError(toMessage));
  }

  act(id: number, action: 'pause' | 'resume' | 'cancel'): Observable<CampaignActionResult> {
    return this.http
      .post<CampaignActionResult>(`/api/admin/campaigns/${id}/${action}`, {})
      .pipe(catchError(toMessage));
  }

  stopAll(): Observable<StopAllResult> {
    return this.http.post<StopAllResult>('/api/admin/bulk/stop-all', {}).pipe(catchError(toMessage));
  }
}
