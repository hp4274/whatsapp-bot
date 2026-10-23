import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { ContactsApi, WhatsappGroup } from '../core/api';
import { saveBlob, today } from './contact-util';

interface GroupRow {
  group: WhatsappGroup;
  /** A subgroup shown indented under its community. */
  child: boolean;
}

/**
 * Read the groups and communities the linked QR number belongs to, then download their
 * members as a CSV or save them as contacts. Broadcast lists are not readable.
 */
@Component({
  selector: 'app-groups-dialog',
  imports: [RouterLink],
  templateUrl: './groups-dialog.html',
  styleUrl: './groups-dialog.scss',
  host: { '(document:keydown.escape)': 'close()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroupsDialog {
  private readonly api = inject(ContactsApi);

  readonly closed = output<void>();
  /** Fired after members were saved as contacts, so the page can refresh. */
  readonly imported = output<void>();

  protected readonly groups = signal<WhatsappGroup[]>([]);
  protected readonly loading = signal(true);
  /** Set when the groups could not be read (no QR number linked, or the call failed). */
  protected readonly loadError = signal('');
  protected readonly query = signal('');
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly busy = signal<'' | 'download' | 'import'>('');
  protected readonly status = signal<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  /** Groups in display order: communities first with subgroups beneath, then the rest. */
  protected readonly rows = computed<GroupRow[]>(() => {
    const all = this.groups();
    const q = this.query().trim().toLowerCase();
    const hit = (g: WhatsappGroup) => !q || g.name.toLowerCase().includes(q);
    const communities = all.filter((g) => g.isCommunity);
    const ids = new Set(communities.map((c) => c.id));
    const out: GroupRow[] = [];
    for (const c of communities) {
      const subs = all.filter((g) => !g.isCommunity && g.community === c.id);
      const subHits = subs.filter(hit);
      if (!hit(c) && !subHits.length) continue;
      out.push({ group: c, child: false });
      for (const s of hit(c) ? subs : subHits) out.push({ group: s, child: true });
    }
    for (const g of all) {
      if (g.isCommunity) continue;
      if (g.community && ids.has(g.community)) continue;
      if (hit(g)) out.push({ group: g, child: false });
    }
    return out;
  });

  protected readonly selectedCount = computed(() => this.selected().size);
  protected readonly allVisibleSelected = computed(() => {
    const rows = this.rows();
    return rows.length > 0 && rows.every((r) => this.selected().has(r.group.id));
  });
  protected readonly someVisibleSelected = computed(
    () => !this.allVisibleSelected() && this.rows().some((r) => this.selected().has(r.group.id)),
  );
  /** Member numbers readable in the current selection. */
  protected readonly selectedMembers = computed(() =>
    this.groups()
      .filter((g) => this.selected().has(g.id))
      .reduce((n, g) => n + g.members, 0),
  );

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  /** Focus goes back here on close, so keyboard users land where they started. */
  private readonly opener = document.activeElement as HTMLElement | null;

  constructor() {
    afterNextRender(() =>
      queueMicrotask(() =>
        this.panel()?.nativeElement.querySelector<HTMLElement>('input, button')?.focus(),
      ),
    );
    this.api.whatsappGroups().subscribe({
      next: ({ groups }) => {
        this.groups.set(groups);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.loadError.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected isOn(id: string) {
    return this.selected().has(id);
  }

  protected toggle(id: string) {
    const next = new Set(this.selected());
    if (!next.delete(id)) next.add(id);
    this.selected.set(next);
  }

  /** Select (or clear) every group that is currently listed. */
  protected toggleAll() {
    const next = new Set(this.selected());
    const clear = this.allVisibleSelected();
    for (const r of this.rows()) {
      if (clear) next.delete(r.group.id);
      else next.add(r.group.id);
    }
    this.selected.set(next);
  }

  protected setQuery(value: string) {
    this.query.set(value);
  }

  /** Escape clears the search first; a second press closes the dialog. */
  protected clearQuery(event: Event) {
    if (!this.query()) return;
    event.stopPropagation();
    this.query.set('');
  }

  /** Every group picked means "all", so the server also covers groups joined meanwhile. */
  private target(): string[] | 'all' {
    const ids = [...this.selected()];
    return ids.length === this.groups().length ? 'all' : ids;
  }

  protected download() {
    if (this.busy() || !this.selectedCount()) return;
    this.busy.set('download');
    this.status.set(null);
    this.api.exportGroups(this.target()).subscribe({
      next: (blob) => {
        this.busy.set('');
        saveBlob(blob, `whatsapp-groups-${today()}.csv`);
        this.status.set({ tone: 'ok', text: 'CSV downloaded.' });
      },
      error: (err: Error) => {
        this.busy.set('');
        this.status.set({ tone: 'bad', text: err.message });
      },
    });
  }

  protected addToContacts() {
    if (this.busy() || !this.selectedCount()) return;
    this.busy.set('import');
    this.status.set(null);
    this.api.importGroups(this.target()).subscribe({
      next: ({ created, updated, failed }) => {
        this.busy.set('');
        const parts = [`${created} added`, `${updated} updated`];
        if (failed) parts.push(`${failed} failed`);
        this.status.set({ tone: failed && !created && !updated ? 'bad' : 'ok', text: parts.join(', ') + '.' });
        this.imported.emit();
      },
      error: (err: Error) => {
        this.busy.set('');
        this.status.set({ tone: 'bad', text: err.message });
      },
    });
  }

  protected close() {
    if (this.busy()) return;
    this.closed.emit();
    this.opener?.focus?.();
  }
}
