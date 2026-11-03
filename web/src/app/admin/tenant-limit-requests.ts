import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { catchError, throwError } from 'rxjs';

import type { Tenant } from '../core/auth';
import { AdminFeed } from './admin-feed';

/** One ask in a request: a limit, the value asked for, for how long; after approval, until when. */
export interface LimitAsk {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  /** 0 = until changed. */
  readonly days: number;
  readonly previous?: number | string | null;
  readonly expiresAt?: string | null;
  readonly reverted?: boolean;
}

export interface LimitRequest {
  readonly id: number;
  readonly items: readonly LimitAsk[];
  readonly note: string;
  readonly status: 'pending' | 'approved' | 'declined';
  readonly reason: string;
  readonly createdAt: string;
  readonly decidedAt: string | null;
}

const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(() => new Error(Array.isArray(errors) && errors.length ? errors.join('\n') : error.message || 'Request failed'));
};

const STATUS: Record<LimitRequest['status'], { label: string; tone: string }> = {
  pending: { label: 'Waiting', tone: 'tone-warn' },
  approved: { label: 'Approved', tone: 'tone-ok' },
  declined: { label: 'Declined', tone: 'tone-bad' },
};

/**
 * Tenant settings > General: what this business asked more of, waiting ones first. Approving applies every ask
 * at once, each for its own time; declining changes nothing. A reason is optional and shown to the business.
 */
@Component({
  selector: 'app-tenant-limit-requests',
  imports: [DatePipe],
  templateUrl: './tenant-limit-requests.html',
  styleUrl: './tenant-limit-requests.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantLimitRequests {
  private readonly http = inject(HttpClient);

  readonly tenantId = input.required<number>();
  /** Approved: the business's limits changed, so the drawer reads it again. */
  readonly answered = output<Tenant>();

  protected readonly requests = signal<LimitRequest[] | null>(null);
  protected readonly busyId = signal<number | null>(null);
  protected readonly error = signal('');
  /** The reason typed per request. */
  protected readonly reasons = signal<Record<number, string>>({});
  protected readonly status = STATUS;
  /** Waiting ones first, then the latest answered. */
  protected readonly sorted = computed(() =>
    [...(this.requests() ?? [])].sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.id - a.id),
  );
  protected readonly waiting = computed(() => (this.requests() ?? []).filter((r) => r.status === 'pending').length);

  constructor() {
    effect(() => {
      const id = this.tenantId();
      untracked(() => {
        this.requests.set(null);
        this.load(id);
      });
    });
    // A business sending a request (or another admin answering one) shows here at once.
    inject(AdminFeed).watch(['tenants'], () => this.load(this.tenantId()));
  }

  private load(id: number) {
    this.http
      .get<{ requests: LimitRequest[] }>(`/api/admin/tenants/${id}/limit-requests`)
      .pipe(catchError(toMessage))
      .subscribe({
        next: ({ requests }) => {
          if (id === this.tenantId()) this.requests.set(requests);
        },
        error: (err: Error) => this.error.set(err.message),
      });
  }

  /** "Templates to 80 for 30 days", and after approval what happens next. */
  protected askText(ask: LimitAsk): string {
    return `${ask.label} to ${ask.value.toLocaleString()} ${ask.days ? `for ${ask.days} days` : 'until changed'}`;
  }

  protected askAfter(ask: LimitAsk): string {
    if (!ask.expiresAt) return '';
    const day = new Date(ask.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    return ask.reverted ? `Ended ${day}` : `Until ${day}`;
  }

  protected setReason(id: number, text: string) {
    this.reasons.update((r) => ({ ...r, [id]: text }));
  }

  protected answer(request: LimitRequest, approve: boolean) {
    if (this.busyId()) return;
    this.busyId.set(request.id);
    this.error.set('');
    this.http
      .post<{ request: LimitRequest; tenant: Tenant }>(
        `/api/admin/tenants/${this.tenantId()}/limit-requests/${request.id}/${approve ? 'approve' : 'decline'}`,
        { reason: this.reasons()[request.id] ?? '' },
      )
      .pipe(catchError(toMessage))
      .subscribe({
        next: ({ request: done, tenant }) => {
          this.busyId.set(null);
          this.requests.update((list) => (list ?? []).map((r) => (r.id === done.id ? done : r)));
          if (approve) this.answered.emit(tenant);
        },
        error: (err: Error) => {
          this.busyId.set(null);
          this.error.set(err.message);
        },
      });
  }
}
