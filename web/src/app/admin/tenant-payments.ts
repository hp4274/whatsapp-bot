import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Observable } from 'rxjs';

import { ConfirmDialog } from '../core/confirm-dialog';
import { Pager, pageOf } from '../core/pager';
import { AdminFeed } from './admin-feed';
import { Balance, LedgerEntry, PAYMENT_METHODS, PaymentMethod, Plan, PlansApi, Statement, money } from './plans-api';

/** History lines per page. */
const PAGE_SIZE = 8;

const KIND_LABEL: Record<LedgerEntry['kind'], string> = { plan: 'Plan charge', topup: 'Top-up charge', payment: 'Payment' };

/** Today where the admin is, as a date box wants it (YYYY-MM-DD). */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Tenant settings > Payments: whether the business is charged at all (paid or free), the price of a plan with no
 * list price, what it owes (plan and top-up charges less payments), "they paid", and the history of both.
 * Charges are made by the Plan tab (choosing, renewing, a priced top-up); this tab records the money coming in.
 */
@Component({
  selector: 'app-tenant-payments',
  imports: [ConfirmDialog, DatePipe, Pager],
  templateUrl: './tenant-payments.html',
  styleUrl: './tenant-payments.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantPayments {
  private readonly api = inject(PlansApi);

  readonly tenantId = input.required<number>();
  readonly plan = input<Plan | undefined>(undefined);
  /** The totals after every load, for the left column. */
  readonly balance = output<Balance>();

  protected readonly pageSize = PAGE_SIZE;
  protected readonly statement = signal<Statement | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  protected readonly page = signal(0);
  protected readonly shown = computed(() => pageOf(this.statement()?.entries ?? [], this.page(), PAGE_SIZE));
  /** The line waiting on "remove it?". */
  protected readonly removing = signal<LedgerEntry | null>(null);

  protected readonly methods = PAYMENT_METHODS;
  /** Record a payment: amount, how it came in, day and note. */
  protected readonly method = signal<PaymentMethod>('upi');
  protected readonly amount = signal<number | null>(null);
  protected readonly paidOn = signal(today());
  protected readonly note = signal('');

  protected readonly currency = computed(() => this.statement()?.currency ?? this.plan()?.currency ?? 'INR');

  constructor() {
    effect(() => {
      const id = this.tenantId();
      untracked(() => {
        this.statement.set(null);
        this.page.set(0);
        this.load(id);
      });
    });
    // A charge from the Plan tab, or another admin recording a payment, shows here at once.
    inject(AdminFeed).watch(['tenants'], () => this.load(this.tenantId(), true));
  }

  private load(tenantId: number, quiet = false) {
    this.api.statement(tenantId).subscribe({
      next: (statement) => {
        if (tenantId !== this.tenantId()) return;
        this.statement.set(statement);
        this.balance.emit(statement);
      },
      error: (err: Error) => {
        if (!quiet) this.error.set(err.message);
      },
    });
  }

  protected money(amount: number | null | undefined): string {
    return money(amount ?? 0, this.currency());
  }

  protected kindLabel(entry: LedgerEntry): string {
    return KIND_LABEL[entry.kind];
  }

  /** "Payment · UPI": a payment says how it came in. */
  protected entryMeta(entry: LedgerEntry): string {
    const how = PAYMENT_METHODS.find((m) => m.key === entry.method)?.label;
    return how ? `${KIND_LABEL[entry.kind]} · ${how}` : KIND_LABEL[entry.kind];
  }

  protected setAmount(raw: string) {
    const n = Math.round(Number(raw));
    this.amount.set(raw.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : n);
  }

  /** "They paid": comes off what is remaining. */
  protected record(event: Event) {
    event.preventDefault();
    const amount = this.amount();
    if (!amount) {
      this.error.set('Enter the amount received.');
      return;
    }
    const body = {
      amount,
      method: this.method(),
      note: this.note().trim(),
      // Midday where the admin is, so the day picked is the day every screen shows.
      ...(this.paidOn() ? { paidAt: new Date(`${this.paidOn()}T12:00:00`).toISOString() } : {}),
    };
    this.run(this.api.recordPayment(this.tenantId(), body), (statement) => {
      this.take(statement);
      this.amount.set(null);
      this.note.set('');
      this.paidOn.set(today());
      this.notice.set(`Payment of ${this.money(amount)} recorded.`);
    });
  }

  protected remove(entry: LedgerEntry) {
    this.removing.set(null);
    this.run(this.api.removeEntry(this.tenantId(), entry.id), (rest) => {
      this.take(rest);
      this.notice.set(`${this.kindLabel(entry)} of ${this.money(entry.amount)} removed.`);
    });
  }

  /** A new statement from a write: the rows and totals change, the plan price and currency stay. */
  private take(rest: Balance & { entries: LedgerEntry[] }) {
    const cur = this.statement();
    if (!cur) return this.load(this.tenantId());
    const next = { ...cur, ...rest };
    this.statement.set(next);
    this.balance.emit(next);
  }

  private run<T>(request: Observable<T>, done: (result: T) => void) {
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    request.subscribe({
      next: (result) => {
        this.busy.set(false);
        done(result);
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }
}
