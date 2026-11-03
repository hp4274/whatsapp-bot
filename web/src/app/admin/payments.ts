import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { Pager, pageOf } from '../core/pager';
import { AdminFeed } from './admin-feed';
import { PaymentRow, PlansApi, money } from './plans-api';

/** Rows per page. */
const PAGE_SIZE = 20;

type Filter = 'all' | 'due' | 'paid' | 'free';

const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'due', label: 'Unpaid' },
  { key: 'paid', label: 'All paid' },
  { key: 'free', label: 'Free' },
];

const matches = (row: PaymentRow, filter: Filter): boolean =>
  filter === 'all' ||
  (filter === 'due' && row.due > 0) ||
  (filter === 'paid' && row.charged > 0 && row.due === 0) ||
  (filter === 'free' && row.payment === 'free');

/**
 * Every business's money in one table: what its plan costs, what it was charged (plans and top-ups), what it paid
 * and what is still unpaid, the largest balance first. Payments are recorded in the business's own Payments tab,
 * which "Open" goes to.
 */
@Component({
  selector: 'app-admin-payments',
  imports: [DatePipe, Pager, RouterLink],
  templateUrl: './payments.html',
  styleUrl: './payments.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentsView {
  private readonly api = inject(PlansApi);

  protected readonly filters = FILTERS;
  protected readonly pageSize = PAGE_SIZE;
  protected readonly rows = signal<PaymentRow[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly filter = signal<Filter>('all');
  protected readonly query = signal('');

  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.rows()
      .filter((r) => matches(r, this.filter()) && (!q || `${r.name} ${r.slug} ${r.planName ?? ''}`.toLowerCase().includes(q)))
      .sort((a, b) => b.due - a.due || a.name.localeCompare(b.name));
  });
  /** Back to the first page when the filter or search changes; a live reload keeps the page. */
  protected readonly page = linkedSignal(() => {
    this.filter();
    this.query();
    return 0;
  });
  protected readonly shown = computed(() => pageOf(this.visible(), this.page(), PAGE_SIZE));

  /** The totals across every business. shortcut: summed as one currency (every plan is INR today); split by currency if plans ever differ. */
  protected readonly totals = computed(() =>
    this.rows().reduce(
      (t, r) => ({
        charged: t.charged + r.charged,
        paid: t.paid + r.paid,
        due: t.due + r.due,
        topups: t.topups + r.topupCharged,
        owing: t.owing + (r.due > 0 ? 1 : 0),
      }),
      { charged: 0, paid: 0, due: 0, topups: 0, owing: 0 },
    ),
  );
  protected readonly currency = computed(() => this.rows()[0]?.currency ?? 'INR');

  constructor() {
    this.load();
    // A charge, a payment or a plan change anywhere shows here at once.
    inject(AdminFeed).watch(['tenants'], () => this.load(true));
  }

  protected load(quiet = false): void {
    this.api.payments().subscribe({
      next: ({ rows }) => {
        this.rows.set(rows);
        this.loading.set(false);
        if (quiet) this.error.set('');
      },
      error: (err: Error) => {
        this.loading.set(false);
        if (!quiet) this.error.set(err.message);
      },
    });
  }

  protected count(filter: Filter): number {
    return this.rows().filter((r) => matches(r, filter)).length;
  }

  protected money(amount: number, currency = this.currency()): string {
    return money(amount, currency);
  }
}
