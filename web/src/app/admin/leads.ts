import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

import { ConfirmDialog } from '../core/confirm-dialog';
import { Pager, pageOf } from '../core/pager';
import { AdminFeed } from './admin-feed';
import { AdminWaiting } from './admin-waiting';
import { Lead, LeadStatus, LeadsApi } from './leads-api';

type Tab = LeadStatus | 'all';

const TABS: readonly { readonly key: Tab; readonly label: string }[] = [
  { key: 'new', label: 'New' },
  { key: 'hold', label: 'On hold' },
  { key: 'converted', label: 'Converted' },
  { key: 'dismissed', label: 'Dismissed' },
  { key: 'all', label: 'All' },
];

const PAGE_SIZE = 20;

/**
 * Account requests from the public site. Hold one that is read but waiting on the business; accept one and it
 * becomes a *pending* tenant, set up and activated from its Tenant settings (the same drawer as every business).
 */
@Component({
  selector: 'app-admin-leads',
  imports: [ConfirmDialog, DatePipe, RouterLink, Pager],
  templateUrl: './leads.html',
  styleUrl: './leads.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LeadsView {
  private readonly api = inject(LeadsApi);
  private readonly router = inject(Router);

  protected readonly tabs = TABS;
  protected readonly pageSize = PAGE_SIZE;

  protected readonly leads = signal<Lead[]>([]);
  protected readonly counts = signal<Record<LeadStatus, number>>({ new: 0, hold: 0, converted: 0, dismissed: 0 });
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly savingId = signal<number | null>(null);
  /** The lead waiting on the "accept as a pending tenant" confirmation. */
  protected readonly accepting = signal<Lead | null>(null);

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

  private readonly waiting = inject(AdminWaiting);

  constructor() {
    this.load();
    // A visitor's request or another admin's action shows here at once.
    inject(AdminFeed).watch(['leads'], () => this.load(true));
  }

  protected load(quiet = false): void {
    this.api.list().subscribe({
      next: ({ leads, counts }) => {
        this.leads.set(leads);
        this.counts.set(counts);
        // Shown here is seen: the bell and the sidebar's Leads count drop.
        this.waiting.seeLeads(leads.filter((l) => l.status === 'new'));
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
    return tab === 'all' ? c.new + c.hold + c.converted + c.dismissed : c[tab];
  }

  protected setStatus(lead: Lead, status: 'new' | 'hold' | 'dismissed'): void {
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

  /** Accepted: straight to the new business's settings, where it is set up and activated. */
  protected accept(lead: Lead): void {
    this.accepting.set(null);
    this.savingId.set(lead.id);
    this.error.set('');
    this.api.convert(lead.id).subscribe({
      next: ({ tenant }) => {
        this.savingId.set(null);
        this.router.navigate(['/admin/tenants'], { queryParams: { settings: tenant.id } });
      },
      error: (err: Error) => {
        this.savingId.set(null);
        this.error.set(err.message);
      },
    });
  }

  protected sourceLabel(lead: Lead): string {
    return lead.source === 'login' ? 'Sign-in page' : 'Landing page';
  }
}
