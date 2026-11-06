import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import type { WritableSignal } from '@angular/core';

import { TenancyApi } from '../core/api';
import type { Tenant } from '../core/auth';
import { ConfirmDialog } from '../core/confirm-dialog';
import { AdminFeed } from './admin-feed';
import { Lead, LeadsApi } from './leads-api';
import { planEnded } from './plans-api';
import { WapzoApi, WapzoBroadcastResult } from './wapzo-api';

/** Which businesses or leads get it; typed numbers can be added to any of them. */
type Audience = 'all' | 'choose' | 'leads' | 'none';

const AUDIENCES: readonly { value: Audience; label: string }[] = [
  { value: 'all', label: 'All businesses' },
  { value: 'choose', label: 'Choose businesses' },
  { value: 'leads', label: 'Leads' },
  { value: 'none', label: 'Only numbers' },
];

/** The image beside the text: uploaded at once, shown from the file the admin picked. */
interface Attachment {
  readonly name: string;
  readonly preview: string;
  readonly mediaId: string | null;
}

/** One line in the pick list: a business or an open lead. */
interface Row {
  readonly id: number;
  readonly name: string;
  readonly sub: string;
  readonly label: string;
  readonly tone: string;
}

/** The words a message to many fills in, per business (server app.js /wapzo/broadcast). */
const WORDS: readonly string[] = ['name', 'business'];

/**
 * One message from the Wuzie number to many people: every business, the ones picked, or numbers typed in. It
 * queues as bulk traffic on the server, so it goes out paced like a bulk send.
 */
@Component({
  selector: 'app-wapzo-broadcast',
  imports: [ConfirmDialog],
  templateUrl: './wapzo-broadcast.html',
  styleUrl: './wapzo-broadcast.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WapzoBroadcast {
  private readonly api = inject(WapzoApi);
  private readonly tenancy = inject(TenancyApi);
  private readonly leadsApi = inject(LeadsApi);

  /** Sending needs the number linked. */
  readonly linked = input(false);
  /** Queued: the page reloads its log. */
  readonly sent = output<void>();

  protected readonly audiences = AUDIENCES;
  protected readonly words = WORDS;
  protected readonly audience = signal<Audience>('all');
  protected readonly tenants = signal<readonly Tenant[]>([]);
  protected readonly picked = signal<ReadonlySet<number>>(new Set());
  protected readonly leads = signal<readonly Lead[]>([]);
  protected readonly pickedLeads = signal<ReadonlySet<number>>(new Set());
  /** Shown in the Leads tab only: an admin without leads access can still send to businesses. */
  protected readonly leadsError = signal('');
  protected readonly search = signal('');
  protected readonly numbers = signal('');
  protected readonly text = signal('');
  protected readonly busy = signal(false);
  protected readonly confirming = signal(false);
  protected readonly error = signal('');
  protected readonly result = signal<WapzoBroadcastResult | null>(null);
  protected readonly image = signal<Attachment | null>(null);
  protected readonly uploading = computed(() => !!this.image() && !this.image()!.mediaId);

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
    const rows: readonly (Row & { readonly find: string })[] =
      this.audience() === 'leads'
        ? this.openLeads().map((l) => ({
            id: l.id,
            name: l.business || l.name,
            sub: [l.name, l.phone].filter(Boolean).join(', ') || 'No number given',
            label: l.status === 'hold' ? 'On hold' : 'New',
            tone: l.status === 'hold' ? 'tone-warn' : 'tone-info',
            find: `${l.business} ${l.name} ${l.email} ${l.phone}`,
          }))
        : this.live().map((t) => ({
            id: t.id,
            name: t.name,
            sub: t.contactPhone || 'No number on file',
            ...this.state(t),
            find: `${t.name} ${t.slug} ${t.contactPhone ?? ''}`,
          }));
    return q ? rows.filter((r) => r.find.toLowerCase().includes(q)) : rows;
  });
  /** The picks the open tab adds to and clears. */
  protected readonly pick = computed<WritableSignal<ReadonlySet<number>>>(() =>
    this.audience() === 'leads' ? this.pickedLeads : this.picked,
  );
  /** Each number once, however it was written (its last ten digits), as the server counts them. */
  protected readonly typed = computed(() => {
    const seen = new Map<string, string>();
    for (const n of this.numbers().split(/[\n,;]+/)) {
      const value = n.trim();
      const digits = value.replace(/\D/g, '').slice(-10);
      if (value && !seen.has(digits || value)) seen.set(digits || value, value);
    }
    return [...seen.values()];
  });
  protected readonly businesses = computed(() => {
    const who = this.audience();
    return who === 'all' ? this.everyone().length : who === 'choose' ? this.picked().size : 0;
  });
  protected readonly leadCount = computed(() => (this.audience() === 'leads' ? this.chosenLeads().length : 0));
  protected readonly count = computed(() => this.businesses() + this.leadCount() + this.typed().length);
  /** "5 businesses and 2 numbers", leaving out a part that is zero. */
  protected readonly what = computed(() => {
    const b = this.businesses();
    const l = this.leadCount();
    const n = this.typed().length;
    const parts = [
      b ? `${b} ${b === 1 ? 'business' : 'businesses'}` : '',
      l ? `${l} ${l === 1 ? 'lead' : 'leads'}` : '',
      n ? `${n} ${n === 1 ? 'number' : 'numbers'}` : '',
    ].filter(Boolean);
    return parts.join(' and ') || 'nobody yet';
  });
  /** The business name in the first message, which the preview shows. */
  protected readonly first = computed(() => {
    const who = this.audience();
    if (who === 'leads') return this.chosenLeads()[0]?.business;
    return (who === 'all' ? this.everyone()[0] : who === 'choose' ? this.live().find((t) => this.picked().has(t.id)) : undefined)?.name;
  });
  /** As near as the page can fill it: the owner's name is not in the list, so {name} stays for the server to fill. */
  protected readonly preview = computed(() => this.text().replace(/\{business\}/g, this.first() || '{business}').trim());
  protected readonly ready = computed(
    () => this.linked() && !this.busy() && !this.uploading() && (!!this.text().trim() || !!this.image()) && this.count() > 0,
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dropImage());
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

  /** Put `{word}` where the cursor was. */
  protected insert(box: HTMLTextAreaElement, word: string): void {
    const token = `{${word}}`;
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? start;
    this.text.set(box.value.slice(0, start) + token + box.value.slice(end));
    box.value = this.text();
    box.focus();
    box.setSelectionRange(start + token.length, start + token.length);
  }

  /** Images only: WhatsApp shows them in the chat with the text as their caption. */
  protected attach(box: HTMLInputElement): void {
    const file = box.files?.[0];
    box.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.error.set('Choose an image (JPG, PNG or WebP).');
      return;
    }
    this.dropImage();
    this.error.set('');
    const preview = URL.createObjectURL(file);
    this.image.set({ name: file.name, preview, mediaId: null });
    this.api.uploadImage(file).subscribe({
      next: ({ mediaId }) => {
        if (this.image()?.preview === preview) this.image.set({ name: file.name, preview, mediaId });
      },
      error: (err: Error) => {
        if (this.image()?.preview === preview) this.dropImage();
        this.error.set(err.message);
      },
    });
  }

  protected dropImage(): void {
    const image = this.image();
    if (image) URL.revokeObjectURL(image.preview);
    this.image.set(null);
  }

  protected send(): void {
    this.confirming.set(false);
    this.busy.set(true);
    this.error.set('');
    this.result.set(null);
    const who = this.audience();
    this.api
      .broadcast({
        text: this.text().trim(),
        tenants: who === 'all' ? 'all' : who === 'choose' ? [...this.picked()] : [],
        leads: who === 'leads' ? this.chosenLeads().map((l) => l.id) : [],
        numbers: this.typed(),
        mediaId: this.image()?.mediaId ?? null,
      })
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.result.set(result);
          if (result.queued) {
            this.text.set('');
            this.dropImage();
          }
          this.sent.emit();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }
}
