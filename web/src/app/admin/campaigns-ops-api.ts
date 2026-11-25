import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

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

/** The AI behind the campaign editor's "Make variations" (server: /api/admin/campaigns/ai). Never holds the key. */
export interface AiSettings {
  readonly provider: string;
  readonly baseUrl: string;
  readonly model: string;
  /** Whether businesses see the Make variations buttons at all. */
  readonly enabled: boolean;
  readonly hasKey: boolean;
  /** Last 4 characters of the saved key, so the admin can tell which one it is. */
  readonly keyEnd: string;
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

  aiSettings(): Observable<AiSettings> {
    return this.http.get<AiSettings>('/api/admin/campaigns/ai').pipe(catchError(toMessage));
  }

  /** Chat models the key (or the saved key, when left out) can use on `provider`. */
  aiModels(ask: { provider: string; apiKey?: string; baseUrl?: string }): Observable<string[]> {
    return this.http
      .post<{ models: string[] }>('/api/admin/campaigns/ai/models', ask)
      .pipe(map((r) => r.models), catchError(toMessage));
  }

  /** `apiKey`: a new key, '' to remove it, left out to keep it. */
  saveAiSettings(patch: {
    provider?: string;
    apiKey?: string;
    model?: string;
    baseUrl?: string;
    enabled?: boolean;
  }): Observable<AiSettings> {
    return this.http.put<AiSettings>('/api/admin/campaigns/ai', patch).pipe(catchError(toMessage));
  }

  stopAll(): Observable<StopAllResult> {
    return this.http.post<StopAllResult>('/api/admin/bulk/stop-all', {}).pipe(catchError(toMessage));
  }
}
