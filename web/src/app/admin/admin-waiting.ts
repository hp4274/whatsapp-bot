import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';

import { Auth } from '../core/auth';

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
 * How far the admin has read: `read` (Mark all as read), `cleared` (Clear: gone from the bell's list, still on its
 * page) and `leads` (the Leads page opened). Each is the newest item's time it covered, never the clock's, so an
 * item that arrives a moment later is still new.
 */
interface Marks {
  readonly read: number;
  readonly cleared: number;
  readonly leads: number;
}

const NONE: Marks = { read: 0, cleared: 0, leads: 0 };
const at = (iso: string): number => Date.parse(iso) || 0;

/**
 * One copy of what waits on the super admin, for the bell, the sidebar counts (Leads, Tenants) and anything else
 * that shows them, so they never disagree. The bell loads it and follows the live feed.
 *
 * shortcut: read marks live in this browser (per admin), not on the server; move them to the user's row if admins
 * work across several devices and expect the bell to agree.
 */
@Injectable({ providedIn: 'root' })
export class AdminWaiting {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(Auth);

  readonly waiting = signal<Waiting | null>(null);
  private readonly marks = signal<Marks>(NONE);

  /** New account requests not seen yet: opening Leads or Mark all as read sees them. */
  private readonly unseenLeads = computed(() => {
    const m = this.marks();
    return (this.waiting()?.leads ?? []).filter((l) => at(l.createdAt) > Math.max(m.read, m.leads));
  });
  private readonly unseenRequests = computed(() =>
    (this.waiting()?.limitRequests ?? []).filter((r) => at(r.createdAt) > this.marks().read),
  );

  /** Sidebar counts and the bell's badge: what is new since it was last seen. */
  readonly leads = computed(() => this.unseenLeads().length);
  readonly requests = computed(() => this.unseenRequests().length);
  readonly unread = computed(() => this.leads() + this.requests());

  /** What the bell lists: everything since the last Clear, new ones marked. */
  readonly listed = computed(() => {
    const w = this.waiting();
    const m = this.marks();
    return {
      leads: (w?.leads ?? []).filter((l) => at(l.createdAt) > m.cleared),
      limitRequests: (w?.limitRequests ?? []).filter((r) => at(r.createdAt) > m.cleared),
    };
  });

  constructor() {
    this.marks.set(this.stored());
    // Another tab read or cleared: this one follows.
    window.addEventListener('storage', (event) => {
      if (event.key === this.key()) this.marks.set(this.stored());
    });
  }

  load(): void {
    this.marks.set(this.stored());
    this.http.get<Waiting>('/api/admin/notifications').subscribe({
      next: (w) => this.waiting.set(w),
      error: () => undefined, // what was shown stays
    });
  }

  isNew(createdAt: string, kind: 'lead' | 'request'): boolean {
    const m = this.marks();
    return at(createdAt) > (kind === 'lead' ? Math.max(m.read, m.leads) : m.read);
  }

  markAllRead(): void {
    this.save({ read: this.newest() });
  }

  clear(): void {
    const newest = this.newest();
    this.save({ read: newest, cleared: newest });
  }

  /** The Leads page showed these requests (on opening, and live as more come): they have been seen. */
  seeLeads(shown: readonly { readonly createdAt: string }[]): void {
    const newest = Math.max(0, ...shown.map((l) => at(l.createdAt)));
    if (newest > this.marks().leads) this.save({ leads: newest });
  }

  private newest(): number {
    const w = this.waiting();
    return Math.max(this.marks().read, ...[...(w?.leads ?? []), ...(w?.limitRequests ?? [])].map((i) => at(i.createdAt)));
  }

  private key(): string {
    return `wapzo.bell.${this.auth.user()?.id ?? 'admin'}`;
  }

  private stored(): Marks {
    try {
      return { ...NONE, ...(JSON.parse(localStorage.getItem(this.key()) ?? '{}') as Partial<Marks>) };
    } catch {
      return NONE;
    }
  }

  private save(change: Partial<Marks>): void {
    const next = { ...this.marks(), ...change };
    this.marks.set(next);
    try {
      localStorage.setItem(this.key(), JSON.stringify(next));
    } catch {
      // Storage off: the marks last until the page reloads.
    }
  }
}
