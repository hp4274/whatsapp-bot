import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import type { SafetyPolicy, TenantLimits } from '../core/api';
import type { Tenant, TenantControls, TenantSubscriptionSummary } from '../core/auth';
import { Lead, LeadsApi } from './leads-api';
import { PROFILE_FIELDS, TenantDetailsEdit } from './tenant-details-edit';
import { sentenceCase } from './text';
import {
  BILLINGS,
  PLAN_QUOTA_FIELDS,
  TENANT_LIMIT_FIELDS,
  Plan,
  Subscription,
  formatPrice,
  billingOf,
  limitText,
  planEnded,
  planStatus,
  money,
  paidPrice,
  stateTone,
  subscriptionWhen,
} from './plans-api';

/** No 0/O or 1/l/I, so a password read out over the phone survives. */
const PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('');
}

/** What activating returned, for the credentials panel: the password is shown this once. */
export type Activation = {
  readonly email: string;
  readonly password: string;
  /** The welcome email: sent, or why not; null when the admin chose not to send it. */
  readonly mail: { readonly sent: boolean; readonly reason?: string } | null;
};

/**
 * Tenant settings' left column: who the business is, the request it came from, its plan with the plan's numbers,
 * and what its settings say right now. Every value comes in from the drawer's working copy, so a change on the right
 * (a plan applied, a limit typed, a switch flipped) shows here at once, before Save. For a pending business it ends
 * with the step that switches it on.
 */
@Component({
  selector: 'app-tenant-summary',
  imports: [DatePipe, FormsModule, TenantDetailsEdit],
  templateUrl: './tenant-summary.html',
  styleUrl: './tenant-summary.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantSummary {
  private readonly api = inject(LeadsApi);

  readonly tenant = input.required<Tenant>();
  readonly sub = input<TenantSubscriptionSummary | Subscription | null>(null);
  readonly plan = input<Plan | undefined>(undefined);
  readonly controls = input.required<TenantControls>();
  readonly limits = input.required<TenantLimits>();
  readonly safety = input<SafetyPolicy | null>(null);
  readonly serviceCount = input(0);
  /** The drawer is saving or activating. */
  readonly busy = input(false);
  readonly activation = input<Activation | null>(null);
  /** Charged, paid and still due (Tenant settings > Payments keeps it current). */
  readonly balance = input<NonNullable<Tenant['balance']> | null>(null);
  /** "Open" beside the balance: the drawer switches to its Payments tab. */
  readonly openPayments = output<void>();
  /** Edit details saved here: the drawer shows the business as it is now. */
  readonly detailsSaved = output<Tenant>();
  /** Switch the business on with this owner password; the drawer saves the right side first. */
  readonly activate = output<{ password: string; sendWelcome: boolean }>();

  protected readonly lead = signal<Lead | null>(null);
  /** The business's owner, read per business (the tenant row does not carry it). */
  protected readonly owner = signal<{ readonly name: string; readonly email: string } | null>(null);
  /** The Request / Details lines are boxes being edited. */
  protected readonly editing = signal(false);
  /** Business details (GSTIN, address...) shown under View more. */
  protected readonly moreShown = signal(false);
  protected readonly profileFields = PROFILE_FIELDS;
  protected readonly profileCount = computed(() => Object.keys(this.tenant().profile ?? {}).length);
  protected readonly password = signal(newPassword());
  protected readonly sendWelcome = signal(true);
  protected readonly copied = signal(false);

  protected readonly quotaFields = PLAN_QUOTA_FIELDS;
  protected readonly limitFields = TENANT_LIMIT_FIELDS;
  protected readonly limit = limitText;
  protected readonly formatPrice = formatPrice;
  protected readonly paidPrice = paidPrice;
  protected readonly stateTone = stateTone;
  protected readonly sentence = sentenceCase;
  /** Pending / Active / Ends <date> / Plan ended, as the Plan tab says it. */
  protected readonly status = computed(() => planStatus(this.tenant().status, this.sub()));
  protected readonly when = subscriptionWhen;
  /** Paid, Free or Hybrid (free with charged top-ups), beside the plan's name. */
  protected readonly payment = computed(() => {
    const billing = billingOf(this.sub()?.payment, this.balance()?.topupCharged ?? 0);
    return billing ? { key: billing, ...BILLINGS[billing] } : null;
  });
  protected readonly pending = computed(() => this.tenant().status === 'pending');
  /** Active, but its plan has ended: it can do nothing until renewed. */
  protected readonly inactive = computed(() => this.tenant().status === 'active' && planEnded(this.tenant().subscription));

  protected money(amount: number): string {
    return money(amount, this.plan()?.currency ?? 'INR');
  }

  constructor() {
    // Per business, not per edit: the request and the owner only change when the drawer shows another business.
    const id = computed(() => this.tenant().id);
    effect(() => {
      const tenantId = id();
      untracked(() => {
        this.lead.set(null);
        this.owner.set(null);
        this.editing.set(false);
        this.api.forTenant(tenantId).subscribe({ next: ({ lead }) => this.lead.set(lead), error: () => undefined });
        this.loadOwner(tenantId);
      });
    });
  }

  private loadOwner(tenantId: number): void {
    this.api.users(tenantId).subscribe({
      next: ({ users }) => {
        const owner = users.find((u) => u.role === 'owner');
        this.owner.set(owner ? { name: owner.name ?? '', email: owner.email } : null);
      },
      error: () => undefined,
    });
  }

  /** Saved in place (each box as it is left): the owner is read again, as their email may have changed. */
  protected saved(tenant: Tenant): void {
    this.loadOwner(tenant.id);
    this.detailsSaved.emit(tenant);
  }

  /** A plan quota for reading: null is unlimited, 0 is none. */
  protected quota(value: number | null | undefined): string {
    if (value === null || value === undefined) return 'Unlimited';
    return value === 0 ? 'None' : value.toLocaleString();
  }

  protected regenerate(): void {
    this.password.set(newPassword());
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy() || !(event.target as HTMLFormElement).reportValidity()) return;
    this.activate.emit({ password: this.password(), sendWelcome: this.sendWelcome() });
  }

  /** The sign-in details as one block to paste into a message. */
  protected copy(done: Activation): void {
    const text = `Sign in at ${location.origin}/login\nEmail: ${done.email}\nPassword: ${done.password}`;
    navigator.clipboard.writeText(text).then(
      () => this.copied.set(true),
      () => this.copied.set(false),
    );
  }
}
