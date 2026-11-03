import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';

import { Observable } from 'rxjs';

import { TenancyApi } from '../core/api';
import type { Tenant } from '../core/auth';
import { ConfirmDialog } from '../core/confirm-dialog';
import { PhoneInput } from '../core/phone-input';
import { AdminFeed } from './admin-feed';
import { money } from './plans-api';
import { CommissionType, ReferrerDetail, ReferralsApi, referralLink } from './referrals-api';

const STATUS: Record<string, { label: string; tone: string }> = {
  pending: { label: 'To pay', tone: 'tone-warn' },
  paid: { label: 'Paid', tone: 'tone-ok' },
  reversed: { label: 'Reversed', tone: 'tone-mute' },
};

/**
 * One marketer, in a side drawer: their details and rate, their referral link, the businesses they brought, every
 * commission, and paying what is owed. With no `referrerId` it is the "Add marketer" form; saving opens the new one.
 */
@Component({
  selector: 'app-referral-drawer',
  imports: [ConfirmDialog, DatePipe, PhoneInput],
  templateUrl: './referral-drawer.html',
  styleUrl: './referral-drawer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class ReferralDrawer {
  private readonly api = inject(ReferralsApi);
  private readonly tenancy = inject(TenancyApi);

  readonly referrerId = input<number | null>(null);
  /** Added or saved: the marketer's id. */
  readonly saved = output<number>();
  readonly closed = output<void>();

  protected readonly detail = signal<ReferrerDetail | null>(null);
  protected readonly tenants = signal<readonly Tenant[]>([]);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal('');

  // The form.
  protected readonly name = signal('');
  protected readonly email = signal('');
  protected readonly phone = signal('');
  protected readonly code = signal('');
  protected readonly type = signal<CommissionType>('percent');
  protected readonly value = signal<number | null>(10);
  protected readonly paused = signal(false);

  protected readonly pick = signal('');
  protected readonly reference = signal('');
  protected readonly confirming = signal(false);
  protected readonly copied = signal(false);

  protected readonly link = computed(() => {
    const ref = this.detail()?.referrer;
    return ref ? referralLink(ref.code) : '';
  });
  /** What a ₹1,000 payment would earn at the rate typed, so the admin sees the rate as money. */
  protected readonly example = computed(() => {
    const v = Number(this.value());
    if (!v || v <= 0) return '';
    const earned = this.type() === 'percent' ? Math.round((1000 * v) / 100) : Math.round(v);
    return `On a ${money(1000, 'INR')} payment they earn ${money(earned, 'INR')}.`;
  });
  /** Businesses not tied to this marketer yet; the server refuses one another marketer already has. */
  protected readonly free = computed(() => {
    const mine = new Set(this.detail()?.clients.map((c) => c.tenantId));
    return this.tenants().filter((t) => t.status !== 'archived' && !mine.has(t.id));
  });

  constructor() {
    // Opened on another marketer (or saved as a new one): load it and fill the form from it.
    effect(() => {
      const id = this.referrerId();
      untracked(() => this.load(id, true));
    });
    // A payment recorded elsewhere earns here at once; the form keeps what is being typed.
    inject(AdminFeed).watch(['referrals'], () => this.load(this.referrerId(), false));
  }

  private load(id: number | null, fill: boolean): void {
    this.error.set('');
    if (id === null) {
      this.detail.set(null);
      return;
    }
    this.api.get(id).subscribe({
      next: (detail) => {
        this.detail.set(detail);
        if (fill) {
          const r = detail.referrer;
          this.name.set(r.name);
          this.email.set(r.email);
          this.phone.set(r.phone);
          this.code.set(r.code);
          this.type.set(r.commissionType);
          this.value.set(r.commissionValue);
          this.paused.set(r.status === 'paused');
        }
      },
      error: (err: Error) => this.error.set(err.message),
    });
    if (!this.tenants().length) this.tenancy.tenants().subscribe({ next: ({ tenants }) => this.tenants.set(tenants) });
  }

  protected save(event: Event): void {
    event.preventDefault();
    if (this.busy() || !(event.target as HTMLFormElement).reportValidity()) return;
    const id = this.referrerId();
    const body = {
      name: this.name().trim(),
      email: this.email().trim(),
      phone: this.phone().trim(),
      code: this.code().trim(),
      commissionType: this.type(),
      commissionValue: Number(this.value()),
      status: this.paused() ? ('paused' as const) : ('active' as const),
    };
    this.run(id === null ? this.api.create(body) : this.api.update(id, body), ({ referrer }) => {
      this.notice.set(id === null ? '' : 'Saved. New payments earn at this rate; earlier ones keep theirs.');
      if (id === null) this.saved.emit(referrer.id);
      else this.load(id, true);
    });
  }

  protected addClient(): void {
    const id = this.referrerId();
    if (id === null || !this.pick()) return;
    this.run(this.api.addClient(id, Number(this.pick())), () => {
      this.pick.set('');
      this.load(id, false);
    });
  }

  protected removeClient(tenantId: number): void {
    const id = this.referrerId();
    if (id !== null) this.run(this.api.removeClient(id, tenantId), () => this.load(id, false));
  }

  protected pay(): void {
    const id = this.referrerId();
    this.confirming.set(false);
    if (id === null) return;
    this.run(this.api.payout(id, this.reference().trim()), ({ amount }) => {
      this.reference.set('');
      this.notice.set(`Marked ${money(amount, 'INR')} as paid.`);
      this.load(id, false);
    });
  }

  protected copy(): void {
    void navigator.clipboard?.writeText(this.link()).then(() => {
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1800);
    });
  }

  protected close(): void {
    if (!this.confirming()) this.closed.emit();
  }

  protected money(amount: number): string {
    return money(amount, 'INR');
  }

  /** A commission's rate, short: "10%" or "₹500 flat". */
  protected rate(type: CommissionType, value: number): string {
    return type === 'percent' ? `${value}%` : `${money(value, 'INR')} flat`;
  }

  protected status(s: string): { label: string; tone: string } {
    return STATUS[s] ?? { label: s, tone: 'tone-mute' };
  }

  private run<T>(call: Observable<T>, done: (result: T) => void): void {
    this.busy.set(true);
    this.error.set('');
    this.notice.set('');
    call.subscribe({
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
