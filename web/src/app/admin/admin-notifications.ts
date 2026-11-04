import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router } from '@angular/router';

import { Auth } from '../core/auth';
import { AdminFeed } from './admin-feed';
import { AdminWaiting, Waiting } from './admin-waiting';

/**
 * The super admin's bell, in the top-right corner of every platform page: new account requests (leads) and limit
 * requests waiting for an answer. Each line opens where it is answered; it leaves the list once it is.
 */
@Component({
  selector: 'app-admin-notifications',
  imports: [DatePipe],
  templateUrl: './admin-notifications.html',
  styleUrl: './admin-notifications.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(document:click)': 'outside($event)',
    '(document:keydown.escape)': 'open.set(false)',
  },
})
export class AdminNotifications {
  private readonly store = inject(AdminWaiting);
  private readonly router = inject(Router);
  private readonly el = inject(ElementRef<HTMLElement>);

  protected readonly waiting = this.store.waiting;
  protected readonly listed = this.store.listed;
  protected readonly open = signal(false);
  /** The badge: what is new since the admin last read. */
  protected readonly count = this.store.unread;
  protected readonly shownCount = computed(() => this.listed().leads.length + this.listed().limitRequests.length);

  constructor() {
    this.load();
    // A visitor asking for an account, or a business asking for more, rings at once.
    inject(AdminFeed).watch(['leads', 'tenants'], () => this.load());
    // Here because the bell is on every platform page: a staff role changed in Settings reaches its holder at once.
    const auth = inject(Auth);
    inject(AdminFeed).watch(['staff', 'roles'], () => auth.refresh());
  }

  private load() {
    this.store.load();
  }

  protected toggle() {
    this.open.set(!this.open());
    if (this.open()) this.load();
  }

  protected outside(event: MouseEvent) {
    if (this.open() && !this.el.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  protected isNew(createdAt: string, kind: 'lead' | 'request'): boolean {
    return this.store.isNew(createdAt, kind);
  }

  protected markAllRead() {
    this.store.markAllRead();
  }

  /** Off the list; each is still waiting on its own page (Leads, the business's General tab). */
  protected clear() {
    this.store.clear();
  }

  protected asks(items: Waiting['limitRequests'][number]['items']): string {
    return items.map((i) => `${i.label} to ${i.value.toLocaleString()}`).join(', ');
  }

  protected openLeads() {
    this.open.set(false);
    this.router.navigate(['/admin/leads']);
  }

  protected openRequest(tenantId: number) {
    this.open.set(false);
    this.router.navigate(['/admin/tenants'], { queryParams: { settings: tenantId, tab: 'general' } });
  }
}
