import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { toMessage } from './utils';
import { NumberDetails } from './number-details';

export interface NumberHealth extends ChannelDetail {
  readonly online: boolean;
  readonly lastSeenAt: string | null;
  readonly pausedReason: string | null;
  readonly pausedBy: 'admin' | 'ban_guard' | null;
  readonly pausedAt: string | null;
  /** QR numbers only (else null): running level, earned level, top level, admin pin, tenant cap and how it started. */
  readonly level: NumberLevel | null;
  /** QR numbers only (else null): the delivery / stuck / unstable brakes and their last 7 days. */
  readonly brakeHealth: BrakeHealth | null;
}

export interface BrakeHealth {
  readonly mode: 'shadow' | 'enforce';
  /** Messages sent 2-24h ago and how they ended. */
  readonly delivery: {
    readonly sentWin: number;
    readonly deliveredWin: number;
    readonly failedWin: number;
    readonly stuckWin: number;
  } | null;
  /** Newest first. `until` is when an enforced brake ends; `detail` is the reason text. */
  readonly events: readonly {
    readonly kind: 'brake' | 'shadow';
    readonly code: string;
    readonly until: string | null;
    readonly detail: string | null;
    readonly at: string;
  }[];
}

export interface LevelEvent {
  readonly shadow: boolean;
  readonly reason: string;
  readonly from: number | null;
  readonly to: number | null;
  readonly text: string;
  readonly at: string;
}

export interface NumberLevel {
  readonly level: number;
  readonly earned: number;
  /** The highest level there is. */
  readonly of: number;
  readonly pinned: number | null;
  readonly cap: number | null;
  /** The level the number started at and why; null if never answered, or voided by a ban or new number. */
  readonly start: NumberLevelStart | null;
  /** False only while safety is on and the start questions are unanswered (bulk held). */
  readonly asked: boolean;
  /** When the wait after a fresh link ends (ISO); null when not waiting. A ban's rest is never this. */
  readonly linkWaitUntil?: string | null;
  /** While the admin has this number's brakes off: until when, and who (WhatsApp's own restriction still applies). */
  readonly brakesOff?: BrakesOff | null;
  /** Level changes of the last 30 days, newest first. */
  readonly events?: readonly LevelEvent[];
}

/** How a number's start was set: its 2 answers (each 0-3), a skip, or linked before the questions existed. */
export interface NumberLevelStart {
  readonly level: number;
  readonly answers:
    | { readonly age: number; readonly usage: number }
    | { readonly skipped: true }
    | { readonly legacy: true }
    | null;
  readonly at: string;
}

export interface BrakesOff {
  readonly until: string;
  readonly by: string | null;
  readonly at: string | null;
}

/** What `PUT /numbers/:id/level` returns (server: policy/channelOps.js). */
export interface LevelPinResult {
  readonly earned: number;
  readonly pinned: number | null;
  readonly cap: number | null;
  readonly effective: number;
  readonly aboveEarned: boolean;
}

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

  /** Pin a QR number to a sending level, or `null` to go back to the level it earned. */
  pinLevel(id: number, level: number | null): Observable<LevelPinResult> {
    return this.http
      .put<LevelPinResult>(`/api/admin/numbers/${id}/level`, { level })
      .pipe(catchError(toMessage));
  }

  /** Turn a QR number's brakes off for `hours` (1-720), or back on with `null`. */
  setBrakesOff(id: number, hours: number | null): Observable<{ brakesOff: BrakesOff | null }> {
    return this.http
      .put<{ brakesOff: BrakesOff | null }>(`/api/admin/numbers/${id}/brakes`, { hours })
      .pipe(catchError(toMessage));
  }

  /** End a QR number's wait after linking; a ban's rest still applies. */
  endLinkWait(id: number): Observable<{ level: number; resting: boolean }> {
    return this.http
      .post<{ level: number; resting: boolean }>(`/api/admin/numbers/${id}/end-link-wait`, {})
      .pipe(catchError(toMessage));
  }

  move(id: number, tenantId: number): Observable<{ ok: true; tenantId: number }> {
    return this.http
      .post<{ ok: true; tenantId: number }>(`/api/admin/numbers/${id}/move`, { tenantId })
      .pipe(catchError(toMessage));
  }

  fetchNumberDetails(id: number): Observable<NumberDetails> {
    return this.http
      .get<NumberDetails>(`/api/admin/numbers/${id}/details`)
      .pipe(catchError(toMessage));
  }
}
