import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';

/** What waits on the super admin (GET /api/admin/notifications). */
export interface Waiting {
  readonly count: number;
  readonly leadCount: number;
  readonly requestCount: number;
  readonly leads: readonly { readonly id: number; readonly name: string; readonly business: string; readonly createdAt: string }[];
  readonly limitRequests: readonly {
    readonly id: number;
    readonly tenantId: number;
    readonly tenantName: string;
    readonly createdAt: string;
    readonly items: readonly { readonly label: string; readonly value: number; readonly days: number }[];
  }[];
}

/**
 * One copy of what waits on the super admin, for the bell, the sidebar counts (Leads, Tenants) and anything else
 * that shows them, so they never disagree. The bell loads it and follows the live feed.
 */
@Injectable({ providedIn: 'root' })
export class AdminWaiting {
  private readonly http = inject(HttpClient);

  readonly waiting = signal<Waiting | null>(null);
  readonly leads = computed(() => this.waiting()?.leadCount ?? 0);
  readonly requests = computed(() => this.waiting()?.requestCount ?? 0);

  load(): void {
    this.http.get<Waiting>('/api/admin/notifications').subscribe({
      next: (w) => this.waiting.set(w),
      error: () => undefined, // what was shown stays
    });
  }
}
