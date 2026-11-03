import { HttpClient, type HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { type Observable, catchError, throwError } from 'rxjs';

/** The limits a business can ask more of (server limits/requests.js REQUESTABLE). */
export type LimitKey = 'maxChannels' | 'maxUsers' | 'maxTemplates' | 'messagesPerMonth' | 'dailyLimit';

export interface LimitAskItem {
  readonly key: LimitKey;
  readonly label: string;
  readonly value: number;
  /** 0 = until changed. */
  readonly days: number;
  /** Set on approval: when the increase goes back (null = until changed). */
  readonly expiresAt?: string | null;
  /** True once its time was up and the old limit came back. */
  readonly reverted?: boolean;
}

export interface LimitRequest {
  readonly id: number;
  readonly items: readonly LimitAskItem[];
  readonly note: string;
  readonly status: 'pending' | 'approved' | 'declined';
  /** The platform admin's answer, '' for none. */
  readonly reason: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

export interface RequestableLimit {
  readonly key: LimitKey;
  readonly label: string;
  /** null = no limit; 'plan' = follows the plan; for dailyLimit 0 = the plan's day. */
  readonly now: number | 'plan' | null;
}

export interface LimitRequestsState {
  readonly requests: readonly LimitRequest[];
  readonly limits: readonly RequestableLimit[];
  /** Days an increase can last; 0 = until changed. */
  readonly durations: readonly number[];
}

/** A business asking the platform admin for more of a limit (owners and admins; agents get 403). */
@Injectable({ providedIn: 'root' })
export class LimitRequestsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<LimitRequestsState> {
    return this.http.get<LimitRequestsState>('/api/limit-requests').pipe(catchError(toMessage));
  }

  create(body: {
    items: readonly { key: LimitKey; value: number; days: number }[];
    note: string;
  }): Observable<{ request: LimitRequest }> {
    return this.http.post<{ request: LimitRequest }>('/api/limit-requests', body).pipe(catchError(toMessage));
  }
}

/** A request's status as its pill reads, with the pill's tone class (school-shared `s.tones`). */
export const REQUEST_STATUS: Readonly<Record<LimitRequest['status'], { readonly label: string; readonly tone: string }>> = {
  pending: { label: 'Pending', tone: 'tone-info' },
  approved: { label: 'Approved', tone: 'tone-ok' },
  declined: { label: 'Declined', tone: 'tone-bad' },
};

/** How long an ask lasts, as the form and the history say it. */
export function durationLabel(days: number): string {
  if (!days) return 'Until changed';
  if (days === 365) return '1 year';
  return `${days} day${days === 1 ? '' : 's'}`;
}

/** One ask as a short line: "Templates to 80 for 30 days". */
export function askLine(item: LimitAskItem): string {
  const span = item.days ? `for ${durationLabel(item.days)}` : 'until changed';
  return `${item.label} to ${item.value.toLocaleString()} ${span}`;
}

/** Surface the server's own words, not "Http failure response for ...". */
function toMessage(error: HttpErrorResponse) {
  const errors: unknown = error.error?.errors;
  const message =
    Array.isArray(errors) && errors.length
      ? errors.join('\n')
      : error.error?.message || error.message || 'Request failed';
  return throwError(() => new Error(message));
}
