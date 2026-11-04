import { HttpClient } from '@angular/common/http';
import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import { Observable, catchError, map } from 'rxjs';

import type { CampaignStats, HistoryPage, MessageRecord, QueuedNext } from '../core/api';
import { Auth } from '../core/auth';
import { EMPTY_STATS } from '../core/store';
import { toMessage } from './plans-api';

/** Wuzie's own number, through its own API (server app.js /api/admin/wapzo/api, the system tenant's runtime). */
const BASE = '/api/admin/wapzo/api';

/**
 * What the send island needs from Wuzie's own number, live: its send counters, the wait between messages and a
 * bump on every send. The same events a business's number streams to Store, for the number the platform view has
 * no Store for. Opened by the island on the platform view, closed when it goes.
 */
@Injectable({ providedIn: 'root' })
export class WuzieFeed {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(Auth);
  private readonly zone = inject(NgZone);

  readonly stats = signal<CampaignStats>(EMPTY_STATS);
  readonly pacing = signal<{ seconds: number; resting: boolean; until: number } | null>(null);
  readonly historyRevision = signal(0);
  private readonly now = signal(Date.now());
  readonly pacingLeft = computed(() => {
    const wait = this.pacing();
    return wait ? Math.max(0, Math.ceil((wait.until - this.now()) / 1000)) : 0;
  });

  private source: EventSource | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private reopen: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    if (this.source) return;
    this.http.get<{ stats: CampaignStats }>(`${BASE}/campaign/stats`).subscribe({
      next: ({ stats }) => this.stats.set(stats),
      error: () => undefined,
    });
    this.listen();
    this.clock ??= setInterval(() => this.now.set(Date.now()), 1000);
  }

  stop(): void {
    this.source?.close();
    this.source = null;
    clearInterval(this.clock ?? undefined);
    this.clock = null;
    clearTimeout(this.reopen ?? undefined);
    this.reopen = null;
    this.stats.set(EMPTY_STATS);
    this.pacing.set(null);
  }

  queueNext(limit: number): Observable<{ next: QueuedNext[] }> {
    return this.http.get<{ next: QueuedNext[] }>(`${BASE}/campaign/queue`, { params: { limit } }).pipe(catchError(toMessage));
  }

  recent(limit: number): Observable<MessageRecord[]> {
    return this.http.get<HistoryPage>(`${BASE}/history`, { params: { limit } }).pipe(
      map((page) => page.records),
      catchError(toMessage),
    );
  }

  action(action: 'pause' | 'resume' | 'stop'): Observable<{ stats: CampaignStats }> {
    return this.http.post<{ stats: CampaignStats }>(`${BASE}/campaign/${action}`, {}).pipe(catchError(toMessage));
  }

  private listen(): void {
    // The token rides in the URL because EventSource takes no headers (as Store's and AdminFeed's streams do).
    const source = new EventSource(`${BASE}/events?${new URLSearchParams({ token: this.auth.token() ?? '' })}`);
    this.source = source;
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as { type: string; stats?: CampaignStats; seconds?: number; resting?: boolean };
      this.zone.run(() => {
        if (payload.type === 'stats' && payload.stats) this.stats.set(payload.stats);
        else if (payload.type === 'pacing') {
          const seconds = Number(payload.seconds);
          this.pacing.set({ seconds, resting: Boolean(payload.resting), until: Date.now() + seconds * 1000 });
        } else if (['status', 'message', 'receipt', 'historyDirty'].includes(payload.type)) {
          this.historyRevision.update((n) => n + 1);
        }
      });
    };
    // A refused or dropped stream (the API restarting) is closed for good by the browser: reopen it ourselves.
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = null;
      this.reopen ??= setTimeout(() => {
        this.reopen = null;
        if (this.auth.token() && this.clock) this.listen();
      }, 5000);
    };
  }
}
