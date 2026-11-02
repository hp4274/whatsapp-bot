import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { Pager, pageOf } from '../core/pager';
import { AdminFeed } from './admin-feed';
import { Lead, LeadConversion, LeadStatus, LeadsApi } from './leads-api';
import { PAYMENTS, Payment, Plan, PlansApi, formatPrice } from './plans-api';

type Tab = LeadStatus | 'all';

const TABS: readonly { readonly key: Tab; readonly label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'converted', label: 'Converted' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
];

const PAGE_SIZE = 20;

/** No 0/O or 1/l/I, so a password read out over the phone survives. */
const PASSWORD_CHARS = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => PASSWORD_CHARS[b % PASSWORD_CHARS.length]).join('');
}

function slugFor(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Account requests from the public site, and the step that turns one into a business: name, owner,
 * plan and how they pay, in one dialog. The owner's password is generated here and shown once, so the
 * admin can send it with the welcome email.
 */
@Component({
  selector: 'app-admin-leads',
  imports: [DatePipe, FormsModule, RouterLink, Pager],
  templateUrl: './leads.html',
  styleUrl: './leads.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeadsView {
  private readonly api = inject(LeadsApi);
  private readonly plansApi = inject(PlansApi);

  protected readonly tabs = TABS;
  protected readonly payments = PAYMENTS;
  protected readonly formatPrice = formatPrice;
  protected readonly pageSize = PAGE_SIZE;

  protected readonly leads = signal<Lead[]>([]);
  protected readonly counts = signal<Record<LeadStatus, number>>({ new: 0, converted: 0, dismissed: 0 });
  protected readonly plans = signal<Plan[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly savingId = signal<number | null>(null);

  protected readonly tab = signal<Tab>('new');
  protected readonly query = signal('');
  protected readonly visible = computed(() => {
    const tab = this.tab();
    const q = this.query().trim().toLowerCase();
    return this.leads().filter(
      (lead) =>
        (tab === 'all' || lead.status === tab) &&
        (!q || `${lead.business} ${lead.name} ${lead.email} ${lead.phone}`.toLowerCase().includes(q)),
    );
  });
  /** Back to the first page when the tab or search changes; a live reload keeps the page. */
  protected readonly page = linkedSignal(() => {
    this.tab();
    this.query();
    return 0;
  });
  protected readonly shown = computed(() => pageOf(this.visible(), this.page(), PAGE_SIZE));

  /** The lead being converted, and the form for it. */
  protected readonly target = signal<Lead | null>(null);
  protected readonly draft = signal<LeadConversion | null>(null);
  protected readonly converting = signal(false);
  protected readonly convertError = signal('');
  /** After converting: what the admin sends the owner. */
  protected readonly created = signal<{
    business: string;
    email: string;
    password: string;
    tenantId: number;
    /** The welcome email: sent, or why not (null when the admin chose not to send it). */
    mail: { sent: boolean; reason?: string } | null;
  } | null>(null);
  protected readonly copied = signal(false);
  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('convertDialog');

  constructor() {
    this.load();
    this.plansApi.plans().subscribe({
      next: ({ plans }) => this.plans.set(plans.filter((p) => p.active).sort((a, b) => a.tier - b.tier)),
      error: () => this.plans.set([]),
    });
    // A visitor's request or another admin's action shows here at once.
    inject(AdminFeed).watch(['leads'], () => this.load(true));
    // The native <dialog> traps focus and closes on Escape; it only needs opening.
    effect(() => {
      const dialog = this.dialogRef()?.nativeElement;
      if (dialog && this.target() && !dialog.open) dialog.showModal();
    });
  }

  protected load(quiet = false): void {
    this.api.list().subscribe({
      next: ({ leads, counts }) => {
        this.leads.set(leads);
        this.counts.set(counts);
        this.loading.set(false);
        if (quiet) this.error.set('');
      },
      error: (err: Error) => {
        this.loading.set(false);
        if (!quiet) this.error.set(err.message);
      },
    });
  }

  protected count(tab: Tab): number {
    const c = this.counts();
    return tab === 'all' ? c.new + c.converted + c.dismissed : c[tab];
  }

  protected setStatus(lead: Lead, status: 'new' | 'dismissed'): void {
    this.savingId.set(lead.id);
    this.error.set('');
    this.api.setStatus(lead.id, status).subscribe({
      next: () => {
        this.savingId.set(null);
        this.load(true);
      },
      error: (err: Error) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected openConvert(lead: Lead): void {
    const plan = this.plans()[0];
    this.convertError.set('');
    this.created.set(null);
    this.copied.set(false);
    this.draft.set({
      name: lead.business,
      slug: slugFor(lead.business),
      planKey: plan?.key ?? '',
      trialDays: plan?.trialDays ?? 0,
      payment: 'unpaid',
      owner: { name: lead.name, email: lead.email, password: newPassword() },
      sendWelcome: true,
    });
    this.target.set(lead);
  }

  protected closeConvert(): void {
    this.dialogRef()?.nativeElement.close();
  }

  /** The dialog's own close event (Escape, the X, Done): clear everything it held. */
  protected closed(): void {
    this.target.set(null);
    this.draft.set(null);
    this.created.set(null);
  }

  protected patch(change: Partial<LeadConversion>): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, ...change });
  }

  protected patchOwner(change: Partial<LeadConversion['owner']>): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, owner: { ...d.owner, ...change } });
  }

  protected choosePlan(plan: Plan): void {
    this.patch({ planKey: plan.key, trialDays: plan.trialDays });
  }

  protected setPayment(payment: Payment): void {
    this.patch({ payment });
  }

  protected regenerate(): void {
    this.patchOwner({ password: newPassword() });
  }

  protected convert(event: Event): void {
    event.preventDefault();
    const lead = this.target();
    const d = this.draft();
    if (!lead || !d || this.converting()) return;
    if (!(event.target as HTMLFormElement).reportValidity()) return;
    this.converting.set(true);
    this.convertError.set('');
    this.api
      .convert(lead.id, {
        ...d,
        name: d.name.trim(),
        slug: slugFor(d.slug || d.name),
        owner: { name: d.owner.name.trim(), email: d.owner.email.trim(), password: d.owner.password },
      })
      .subscribe({
        next: ({ tenant, owner, email }) => {
          this.converting.set(false);
          this.created.set({
            business: tenant.name,
            email: owner.email,
            password: d.owner.password,
            tenantId: tenant.id,
            mail: d.sendWelcome ? email : null,
          });
          this.load(true);
        },
        error: (err: Error) => {
          this.converting.set(false);
          this.convertError.set(err.message);
        },
      });
  }

  /** The sign-in details as one block to paste into the welcome email. */
  protected copyCredentials(): void {
    const c = this.created();
    if (!c) return;
    const text = `Sign in at ${location.origin}/login\nEmail: ${c.email}\nPassword: ${c.password}`;
    navigator.clipboard.writeText(text).then(
      () => this.copied.set(true),
      () => this.copied.set(false),
    );
  }

  protected sourceLabel(lead: Lead): string {
    return lead.source === 'login' ? 'Sign-in page' : 'Landing page';
  }
}
