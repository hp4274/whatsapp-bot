/**
 * Typed client for the read-only endpoints the Analytics page aggregates.
 * Shapes mirror the server handlers - change both together:
 *   /api/billing/usage[/history]  server/src/billing/routes.js + store.js (gated by `analytics`)
 *   /api/history                  server/src/app.js + db.js history()/countsByStatus()
 *   /api/campaign/stats           server/src/campaign/manager.js statsSnapshot()
 *   /api/objects-stats            server/src/objects/store.js stats()
 *   /api/tickets/stats            server/src/tickets/store.js stats()
 *   /api/inbox/stats              server/src/inbox/store.js stats()
 *   /api/analytics/overview       server/src/analytics/store.js overview() (definitions live there)
 */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export type MessageStatus = 'QUEUED' | 'SENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED' | 'SANDBOX';

export interface UsageMetric { metric: string; used: number; limit: number | null; remaining: number | null }
export interface Usage { period: string; planKey: string | null; metrics: UsageMetric[] }
/** Newest period first. `metrics` only holds counters that were ever written. */
export interface UsagePeriod { period: string; metrics: Record<string, number> }

export interface MessageRecord {
  messageId: string;
  messageType: string;
  direction: string;
  channelId: number | null;
  recipient: string;
  status: MessageStatus;
  error: string | null;
  campaignId: string;
  createdAt: string;
  updatedAt: string;
}
export interface MessageHistory {
  records: MessageRecord[];
  counts: Partial<Record<MessageStatus, number>>;
  signature: string;
}

export interface CampaignStats {
  total: number;
  successful: number;
  failed: number;
  processed: number;
  skippedOptOut: number;
  pending: number;
  duplicates: number;
  state: string;
  safety: { enabled: boolean; limit: number; used: number; remaining: number | null; resetsAt: string };
}

export interface ObjectStats { total: number; byType: Record<string, { total: number; byStatus: Record<string, number> }> }

export interface TicketStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  overdue: number;
  resolved: number;
  medianResolveSeconds: number | null;
}

export interface InboxStats {
  byStatus: Record<string, number>;
  total: number;
  unassigned: number;
  unread: number;
  oldestUnansweredAt: string | null;
}

export type RangeDays = 7 | 30 | 90;
export const RANGE_DAYS: readonly RangeDays[] = [7, 30, 90];

/** Outbound counts. delivered = DELIVERED+READ; attempted = not QUEUED/SENDING; sent = attempted - failed. */
export interface Counts {
  total: number;
  attempted: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  sandbox: number;
  pending: number;
  /** delivered / attempted, percent, one decimal. */
  deliveryRate: number | null;
  /** read / delivered. */
  readRate: number | null;
  /** failed / attempted. */
  failureRate: number | null;
}
export interface DailyPoint { date: string; total: number; sent: number; delivered: number; read: number; failed: number }
export interface CampaignRow extends Counts {
  campaignId: string;
  recordId: number | null;
  name: string;
  campaignStatus: string | null;
  firstSentAt: string | null;
  lastSentAt: string | null;
}
export interface RuleHit { rule: string; count: number }
export interface ResponseTimes {
  conversations: number;
  answered: number;
  unanswered: number;
  medianSeconds: number | null;
  p90Seconds: number | null;
  averageSeconds: number | null;
  within5m: number;
  within1h: number;
  /** Shares of ALL conversations, unanswered included. */
  within5mPct: number | null;
  within1hPct: number | null;
  buckets: { key: string; label: string; count: number }[];
}
export interface Overview {
  range: { days: RangeDays; since: string; until: string };
  totals: Counts & { byStatus: Record<string, number>; byType: Record<string, number> };
  daily: DailyPoint[];
  campaigns: CampaignRow[];
  autoReplies: { messages: number; inbound: number; matched: number; matchRate: number | null; topRules: RuleHit[] };
  responseTimes: ResponseTimes;
}

@Injectable({ providedIn: 'root' })
export class AnalyticsApi {
  private readonly http = inject(HttpClient);

  private get<T>(path: string, query: Record<string, string | number> = {}): Observable<T> {
    let params = new HttpParams();
    for (const [k, v] of Object.entries(query)) params = params.set(k, v);
    return this.http.get<T>(`/api${path}`, { params }).pipe(catchError(toMessage));
  }

  usage(period: string) { return this.get<{ usage: Usage }>('/billing/usage', { period }).pipe(map((r) => r.usage)); }
  usageHistory(months = 6) {
    return this.get<{ history: UsagePeriod[] }>('/billing/usage/history', { months }).pipe(map((r) => r.history));
  }
  /** Never pass `signature`: a match answers 204 with no body. */
  history(limit = 1000) { return this.get<MessageHistory>('/history', { limit }); }
  campaignStats() { return this.get<{ stats: CampaignStats }>('/campaign/stats').pipe(map((r) => r.stats)); }
  objectStats() { return this.get<ObjectStats>('/objects-stats'); }
  ticketStats() { return this.get<{ stats: TicketStats }>('/tickets/stats').pipe(map((r) => r.stats)); }
  inboxStats() { return this.get<{ stats: InboxStats }>('/inbox/stats').pipe(map((r) => r.stats)); }
  overview(days: RangeDays) {
    return this.get<{ overview: Overview }>('/analytics/overview', { days }).pipe(map((r) => r.overview));
  }
}

function toMessage(error: HttpErrorResponse) {
  const body = error.error as { errors?: string[] } | null;
  return throwError(() => new Error(body?.errors?.join(' ') || error.message || 'Request failed'));
}
