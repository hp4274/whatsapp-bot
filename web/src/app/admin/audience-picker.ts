import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import type { WritableSignal } from '@angular/core';

import { TenancyApi } from '../core/api';
import type { Tenant } from '../core/auth';
import { AdminFeed } from './admin-feed';
import { Lead, LeadsApi } from './leads-api';
import { planEnded } from './plans-api';

/** Which businesses or leads get it; typed numbers or addresses can be added to any of them. */
type Audience = 'all' | 'choose' | 'leads' | 'none';

/** One line in the pick list: a business or an open lead. */
interface Row {
  readonly id: number;
  readonly name: string;
  readonly sub: string;
  readonly label: string;
  readonly tone: string;
}

/** Who was chosen, in the shape the send endpoints take, with the words the page shows for it. */
export interface AudienceChoice {
  readonly tenants: 'all' | readonly number[];
  readonly leads: readonly number[];
  readonly typed: readonly string[];
  readonly count: number;
  /** "5 businesses and 2 numbers", or "nobody yet". */
  readonly what: string;
  /** The first business or lead, for a preview. */
  readonly first: string | undefined;
}

/** Puts `{word}` where the cursor was and returns the box's new text. */
export function insertWord(box: HTMLTextAreaElement, word: string): string {
  const token = `{${word}}`;
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  box.value = box.value.slice(0, start) + token + box.value.slice(end);
  box.focus();
  box.setSelectionRange(start + token.length, start + token.length);
  return box.value;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Who a message from Wuzie goes to: every business, the ones picked, open leads, or numbers/addresses typed in.
 * Shared by the WhatsApp and email sends, so both choose people the same way and "all" means the same thing.
 */
@Component({
  selector: 'app-audience-picker',
  templateUrl: './audience-picker.html',
  styleUrl: './audience-picker.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AudiencePicker {
  private readonly tenancy = inject(TenancyApi);
  private readonly leadsApi = inject(LeadsApi);

  /** What the typed box takes, and which contact detail the lists show. */
  readonly kind = input<'whatsapp' | 'email'>('whatsapp');

  protected readonly email = computed(() => this.kind() === 'email');
  protected readonly audiences = computed<readonly { value: Audience; label: string }[]>(() => [
    { value: 'all', label: 'All businesses' },
    { value: 'choose', label: 'Choose businesses' },
    { value: 'leads', label: 'Leads' },
    { value: 'none', label: this.email() ? 'Only addresses' : 'Only numbers' },
  ]);
  protected readonly audience = signal<Audience>('all');
  private readonly tenants = signal<readonly Tenant[]>([]);
  private readonly picked = signal<ReadonlySet<number>>(new Set());
  private readonly leads = signal<readonly Lead[]>([]);
  private readonly pickedLeads = signal<ReadonlySet<number>>(new Set());
  protected readonly error = signal('');
  /** Shown in the Leads tab only: an admin without leads access can still send to businesses. */
  protected readonly leadsError = signal('');
  protected readonly search = signal('');
  protected readonly entered = signal('');

  /** Archived businesses get nothing. */
  private readonly live = computed(() => this.tenants().filter((t) => t.status !== 'archived'));
  /** "All" leaves out those that switched Wuzie updates off, as the server does. */
  protected readonly everyone = computed(() => this.live().filter((t) => t.wapzoUpdates !== false));
  protected readonly optedOut = computed(() => this.live().length - this.everyone().length);
  /** Only requests still waiting on us: new or on hold. Converted ones are businesses; dismissed ones said no. */
  protected readonly openLeads = computed(() => this.leads().filter((l) => l.status === 'new' || l.status === 'hold'));
  /** Picked leads that are still open: one converted or dismissed meanwhile drops out. */
  private readonly chosenLeads = computed(() => this.openLeads().filter((l) => this.pickedLeads().has(l.id)));
  /** The list in view for the open tab, businesses or open leads, narrowed by the search. */
  protected readonly shown = computed<readonly Row[]>(() => {
    const q = this.search().trim().toLowerCase();
    const email = this.email();
    const rows: readonly (Row & { readonly find: string })[] =
      this.audience() === 'leads'
        ? this.openLeads().map((l) => ({
            id: l.id,
            name: l.business || l.name,
            sub: [l.name, email ? l.email : l.phone].filter(Boolean).join(', ') || 'No number given',
            label: l.status === 'hold' ? 'On hold' : 'New',
            tone: l.status === 'hold' ? 'tone-warn' : 'tone-info',
            find: `${l.business} ${l.name} ${l.email} ${l.phone}`,
          }))
        : this.live().map((t) => ({
            id: t.id,
            name: t.name,
            sub: email ? t.slug : t.contactPhone || 'No number on file',
            ...this.state(t),
            find: `${t.name} ${t.slug} ${t.contactPhone ?? ''}`,
          }));
    return q ? rows.filter((r) => r.find.toLowerCase().includes(q)) : rows;
  });
  /** The picks the open tab adds to and clears. */
  protected readonly pick = computed<WritableSignal<ReadonlySet<number>>>(() =>
    this.audience() === 'leads' ? this.pickedLeads : this.picked,
  );
  /** Each one once, however it was written (a number's last ten digits, an address in any case), as the server counts them. */
  protected readonly typed = computed(() => {
    const seen = new Map<string, string>();
    for (const part of this.entered().split(/[\n,;]+/)) {
      const value = part.trim();
      const key = this.email() ? value.toLowerCase() : value.replace(/\D/g, '').slice(-10) || value;
      if (value && !seen.has(key)) seen.set(key, value);
    }
    return [...seen.values()];
  });

  readonly choice = computed<AudienceChoice>(() => {
    const who = this.audience();
    const businesses = who === 'all' ? this.everyone().length : who === 'choose' ? this.picked().size : 0;
    const leads = who === 'leads' ? this.chosenLeads() : [];
    const typed = this.typed();
    const first =
      who === 'leads'
        ? leads[0]?.business
        : (who === 'all' ? this.everyone()[0] : who === 'choose' ? this.live().find((t) => this.picked().has(t.id)) : undefined)?.name;
    return {
      tenants: who === 'all' ? 'all' : who === 'choose' ? [...this.picked()] : [],
      leads: leads.map((l) => l.id),
      typed,
      count: businesses + leads.length + typed.length,
      what:
        [
          businesses ? plural(businesses, 'business', 'businesses') : '',
          leads.length ? plural(leads.length, 'lead', 'leads') : '',
          typed.length ? (this.email() ? plural(typed.length, 'address', 'addresses') : plural(typed.length, 'number', 'numbers')) : '',
        ]
          .filter(Boolean)
          .join(' and ') || 'nobody yet',
      first,
    };
  });

  constructor() {
    this.tenancy.tenants().subscribe({
      next: ({ tenants }) => this.tenants.set(tenants),
      error: (err: Error) => this.error.set(err.message),
    });
    this.loadLeads();
    // A lead accepted, held or dismissed elsewhere moves in or out of the Leads list at once.
    inject(AdminFeed).watch(['leads'], () => this.loadLeads());
  }

  private loadLeads(): void {
    this.leadsApi.list().subscribe({
      next: ({ leads }) => {
        this.leads.set(leads);
        this.leadsError.set('');
      },
      error: (err: Error) => this.leadsError.set(err.message),
    });
  }

  protected toggle(id: number): void {
    this.pick().update((set) => {
      const next = new Set(set);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  /** Select every row in view, or clear them if all are already picked. */
  protected toggleShown(): void {
    const ids = this.shown().map((r) => r.id);
    const all = ids.every((id) => this.pick()().has(id));
    this.pick().update((set) => {
      const next = new Set(set);
      for (const id of ids) {
        if (all) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  protected allShownPicked(): boolean {
    const shown = this.shown();
    return shown.length > 0 && shown.every((r) => this.pick()().has(r.id));
  }

  private state(tenant: Tenant): { label: string; tone: string } {
    if (tenant.status === 'pending') return { label: 'Pending', tone: 'tone-info' };
    if (tenant.status === 'suspended') return { label: 'Suspended', tone: 'tone-warn' };
    if (planEnded(tenant.subscription)) return { label: 'Inactive', tone: 'tone-mute' };
    return { label: 'Active', tone: 'tone-ok' };
  }
}
