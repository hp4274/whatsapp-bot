import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import {
  BulkAction, Contact2, ContactFilter, ContactSort, ContactsApi, DuplicateGroup, Segment,
} from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';
import { Tilt } from '../school/tilt';
import { BulkBar, BulkRequest } from './bulk-bar';
import { ContactDrawer } from './contact-drawer';
import { displayPhone, hue, initials, relativeTime, absoluteTime, saveBlob, splitTags, today } from './contact-util';
import { ImportWizard } from './import-wizard';
import { MergeDialog } from './merge-dialog';

interface Draft { phone: string; name: string; email: string; tags: string; fields: string }

/** The consent filter the toolbar offers, mapped onto the server's filter keys. */
type ConsentFilter = '' | 'messageable' | 'opted_in' | 'unknown' | 'opted_out';

const VERB: Record<BulkAction, string> = {
  addTags: 'Tagged', removeTags: 'Untagged', optOut: 'Opted out', optIn: 'Opted in', delete: 'Deleted',
};

@Component({
  selector: 'app-contacts',
  imports: [FormsModule, Tilt, BulkBar, ContactDrawer, ImportWizard, MergeDialog],
  templateUrl: './contacts.html',
  styleUrl: './contacts.scss',
})
export class ContactsView {
  private readonly api = inject(ContactsApi);
  private readonly store = inject(Store);
  private readonly auth = inject(Auth);

  protected readonly pageSize = 50;
  protected readonly canWrite = computed(() => this.auth.atLeast('admin'));

  protected readonly rows = signal<Contact2[]>([]);
  protected readonly total = signal(0);
  protected readonly tags = signal<{ tag: string; count: number }[]>([]);
  protected readonly fieldKeys = signal<string[]>([]);
  protected readonly segments = signal<Segment[]>([]);
  protected readonly overall = signal<{ total: number; optedOut: number } | null>(null);
  protected readonly loading = signal(true);
  protected readonly refreshing = signal(false);
  protected readonly error = signal('');
  protected readonly notice = signal<{ tone: 'ok' | 'warn'; text: string } | null>(null);

  protected readonly searchInput = signal('');
  private readonly search = signal('');
  protected readonly tagFilter = signal<string[]>([]);
  protected readonly segmentId = signal<number | null>(null);
  protected readonly consent = signal<ConsentFilter>('');
  protected readonly sort = signal<ContactSort | ''>('');
  protected readonly dir = signal<'asc' | 'desc'>('asc');
  protected readonly page = signal(0);

  protected readonly selected = signal<ReadonlySet<number>>(new Set());
  protected readonly allMatching = signal(false);
  private anchor: number | null = null;

  protected readonly openId = signal<number | null>(null);
  protected readonly importOpen = signal(false);
  protected readonly mergeOpen = signal(false);
  protected readonly dupes = signal<DuplicateGroup[]>([]);
  protected readonly dupeTotal = signal(0);
  protected readonly dupeDismissed = signal(false);

  protected readonly showForm = signal(false);
  protected readonly busy = signal(false);
  protected readonly formError = signal('');
  protected readonly draft = signal<Draft>({ phone: '', name: '', email: '', tags: '', fields: '' });
  protected readonly segName = signal('');
  protected readonly confirmSegment = signal<number | null>(null);
  protected readonly exporting = signal(false);

  protected readonly segment = computed(() => this.segments().find((s) => s.id === this.segmentId()) ?? null);

  /** What the server is asked for: the segment's stored filter, narrowed by the toolbar. */
  protected readonly filter = computed<ContactFilter>(() => {
    const base: ContactFilter = { ...(this.segment()?.filter ?? {}) };
    const term = this.search().trim();
    if (term) base.search = term;
    const tags = [...new Set([...(base.tags ?? []), ...this.tagFilter()])];
    if (tags.length) base.tags = tags;
    const consent = this.consent();
    if (consent === 'messageable') base.optedOut = false;
    else if (consent === 'opted_out') base.optedOut = true;
    else if (consent) base.optInStatus = consent;
    return base;
  });

  protected readonly hasFilters = computed(() =>
    Boolean(this.search().trim() || this.tagFilter().length || this.segmentId() || this.consent()));
  protected readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize)));
  protected readonly from = computed(() => (this.total() ? this.page() * this.pageSize + 1 : 0));
  protected readonly to = computed(() => Math.min(this.total(), (this.page() + 1) * this.pageSize));
  protected readonly selectedCount = computed(() => (this.allMatching() ? this.total() : this.selected().size));
  protected readonly pageAllSelected = computed(() =>
    this.rows().length > 0 && this.rows().every((r) => this.selected().has(r.id)));
  protected readonly pageSomeSelected = computed(() =>
    !this.pageAllSelected() && this.rows().some((r) => this.selected().has(r.id)));

  protected readonly displayPhone = displayPhone;
  protected readonly initials = initials;
  protected readonly hue = hue;
  protected readonly ago = relativeTime;
  protected readonly absolute = absoluteTime;

  private seq = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
    this.loadMeta();
    this.store.watch(['contacts', 'segments', 'optouts'], () => {
      this.load(true);
      this.loadMeta();
    });
    inject(DestroyRef).onDestroy(() => {
      if (this.searchTimer) clearTimeout(this.searchTimer);
      if (this.noticeTimer) clearTimeout(this.noticeTimer);
    });
  }

  // ------------------------------------------------------------ loading --
  protected load(quiet = false) {
    const seq = ++this.seq;
    if (!quiet) this.refreshing.set(true);
    this.api
      .list(this.filter(), this.pageSize, { offset: this.page() * this.pageSize, sort: this.sort(), dir: this.dir() })
      .subscribe({
        next: ({ contacts, total, tags, fieldKeys }) => {
          if (seq !== this.seq) return; // a newer request owns the table
          // Deleting the last rows of the last page: step back instead of showing nothing.
          if (!contacts.length && total > 0 && this.page() > 0) {
            this.page.set(Math.ceil(total / this.pageSize) - 1);
            this.load(quiet);
            return;
          }
          this.rows.set(contacts);
          this.total.set(total);
          this.tags.set(tags);
          this.fieldKeys.set(fieldKeys);
          this.error.set('');
          this.loading.set(false);
          this.refreshing.set(false);
        },
        error: (err: Error) => {
          if (seq !== this.seq) return;
          this.error.set(err.message);
          this.loading.set(false);
          this.refreshing.set(false);
        },
      });
  }

  private loadMeta() {
    this.api.segments().subscribe({ next: ({ segments }) => this.segments.set(segments), error: () => undefined });
    this.api.list({}, 1).subscribe({
      next: ({ total }) => this.api.list({ optedOut: true }, 1).subscribe({
        next: (out) => this.overall.set({ total, optedOut: out.total }),
        error: () => undefined,
      }),
      error: () => undefined,
    });
    if (this.canWrite()) {
      this.api.duplicates().subscribe({
        next: ({ groups, total }) => {
          this.dupes.set(groups);
          this.dupeTotal.set(total);
        },
        error: () => undefined,
      });
    }
  }

  /** Any change to what is being looked at: back to page one, selection cleared. */
  private refilter() {
    this.page.set(0);
    this.clearSelection();
    this.load();
  }

  // ------------------------------------------------------------ filters --
  protected onSearch(value: string) {
    this.searchInput.set(value);
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      if (this.search() === value.trim()) return;
      this.search.set(value.trim());
      this.refilter();
    }, 300);
  }

  protected clearSearch() {
    this.onSearch('');
  }

  protected toggleTag(tag: string) {
    const on = this.tagFilter().includes(tag);
    this.tagFilter.set(on ? this.tagFilter().filter((t) => t !== tag) : [...this.tagFilter(), tag]);
    this.refilter();
  }

  protected setConsent(value: ConsentFilter) {
    this.consent.set(value);
    this.refilter();
  }

  protected applySegment(segment: Segment | null) {
    this.segmentId.set(segment && this.segmentId() !== segment.id ? segment.id : null);
    this.refilter();
  }

  protected clearFilters() {
    if (this.searchTimer) clearTimeout(this.searchTimer);
    this.searchInput.set('');
    this.search.set('');
    this.tagFilter.set([]);
    this.segmentId.set(null);
    this.consent.set('');
    this.refilter();
  }

  protected sortBy(key: ContactSort) {
    if (this.sort() === key) this.dir.set(this.dir() === 'asc' ? 'desc' : 'asc');
    else {
      this.sort.set(key);
      this.dir.set(key === 'createdAt' ? 'desc' : 'asc');
    }
    this.page.set(0);
    this.load();
  }

  protected ariaSort(key: ContactSort) {
    if (this.sort() !== key) return 'none';
    return this.dir() === 'asc' ? 'ascending' : 'descending';
  }

  protected goTo(page: number) {
    const next = Math.min(Math.max(0, page), this.pageCount() - 1);
    if (next === this.page()) return;
    this.page.set(next);
    this.anchor = null;
    this.load();
  }

  // ---------------------------------------------------------- selection --
  protected toggleRow(contact: Contact2, index: number, event: MouseEvent) {
    event.stopPropagation();
    const next = new Set(this.allMatching() ? this.rows().map((r) => r.id) : this.selected());
    this.allMatching.set(false);
    if (event.shiftKey && this.anchor !== null && this.anchor !== index) {
      // Range select: everything between the last click and this one takes this row's new state.
      const on = !this.selected().has(contact.id);
      const [a, b] = this.anchor < index ? [this.anchor, index] : [index, this.anchor];
      for (const row of this.rows().slice(a, b + 1)) {
        if (on) next.add(row.id);
        else next.delete(row.id);
      }
    } else if (next.has(contact.id)) next.delete(contact.id);
    else next.add(contact.id);
    this.anchor = index;
    this.selected.set(next);
  }

  protected togglePage() {
    const next = new Set(this.selected());
    const all = this.pageAllSelected();
    for (const row of this.rows()) {
      if (all) next.delete(row.id);
      else next.add(row.id);
    }
    this.allMatching.set(false);
    this.selected.set(next);
  }

  protected selectAllMatching() {
    this.allMatching.set(true);
    this.selected.set(new Set(this.rows().map((r) => r.id)));
  }

  protected clearSelection() {
    this.selected.set(new Set());
    this.allMatching.set(false);
    this.anchor = null;
  }

  protected isSelected(id: number) {
    return this.allMatching() || this.selected().has(id);
  }

  // --------------------------------------------------------------- bulk --
  protected runBulk(request: BulkRequest) {
    const target = this.allMatching() ? { filter: this.filter() } : { ids: [...this.selected()] };
    this.busy.set(true);
    this.api.bulk({ ...target, ...request }).subscribe({
      next: (result) => {
        this.busy.set(false);
        this.flash('ok', `${VERB[result.action]} ${result.affected} contact${result.affected === 1 ? '' : 's'}.`);
        if (result.action === 'delete') this.clearSelection();
        if (result.action === 'delete' && this.openId() !== null && !this.rows().some((r) => r.id === this.openId())) {
          this.openId.set(null);
        }
        this.load(true);
        this.loadMeta();
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.flash('warn', err.message);
      },
    });
  }

  protected exportCsv(selectedOnly: boolean) {
    const target = selectedOnly && !this.allMatching()
      ? { ids: [...this.selected()] }
      : { filter: this.filter(), sort: this.sort(), dir: this.dir() };
    this.exporting.set(true);
    this.api.exportCsv(target).subscribe({
      next: (blob) => {
        this.exporting.set(false);
        saveBlob(blob, `contacts-${today()}.csv`);
      },
      error: (err: Error) => {
        this.exporting.set(false);
        this.flash('warn', err.message);
      },
    });
  }

  private flash(tone: 'ok' | 'warn', text: string) {
    this.notice.set({ tone, text });
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.notice.set(null), 5000);
  }

  // ------------------------------------------------------------- detail --
  protected open(contact: Contact2) {
    this.openId.set(contact.id);
  }

  protected rowKey(event: KeyboardEvent, contact: Contact2) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.open(contact);
    }
  }

  protected onDrawerChanged() {
    this.load(true);
    this.loadMeta();
  }

  protected onDrawerDeleted(id: number) {
    this.openId.set(null);
    const next = new Set(this.selected());
    next.delete(id);
    this.selected.set(next);
    this.flash('ok', 'Contact deleted.');
    this.load(true);
    this.loadMeta();
  }

  protected onImported() {
    this.page.set(0);
    this.load(true);
    this.loadMeta();
  }

  protected onMerged(count: number) {
    this.flash('ok', `Merged ${count} duplicate${count === 1 ? '' : 's'}.`);
    this.load(true);
    this.loadMeta();
  }

  // --------------------------------------------------------- add contact --
  protected create(event: Event) {
    event.preventDefault();
    const d = this.draft();
    if (!d.phone.trim()) {
      this.formError.set('A phone number is required.');
      return;
    }
    this.busy.set(true);
    this.formError.set('');
    this.api
      .save({
        phone: d.phone.trim(),
        name: d.name.trim(),
        email: d.email.trim(),
        tags: splitTags(d.tags),
        customFields: parseFields(d.fields),
      })
      .subscribe({
        next: ({ contact }) => {
          this.busy.set(false);
          this.showForm.set(false);
          this.draft.set({ phone: '', name: '', email: '', tags: '', fields: '' });
          this.flash('ok', `Saved ${contact.name || displayPhone(contact.phone)}.`);
          this.load(true);
          this.loadMeta();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.formError.set(err.message);
        },
      });
  }

  protected setDraft(patch: Partial<Draft>) {
    this.draft.set({ ...this.draft(), ...patch });
  }

  // ----------------------------------------------------------- segments --
  /** Save what is on screen as a reusable audience. */
  protected saveSegment() {
    const name = this.segName().trim();
    if (!name) return;
    this.api.saveSegment({ name, filter: this.filter() }).subscribe({
      next: ({ segment }) => {
        this.segName.set('');
        this.segments.set([...this.segments(), { ...segment, count: this.total() }]);
        this.flash('ok', `Segment "${segment.name}" saved.`);
      },
      error: (err: Error) => this.flash('warn', err.message),
    });
  }

  protected deleteSegment(segment: Segment) {
    this.confirmSegment.set(null);
    this.api.deleteSegment(segment.id).subscribe({
      next: () => {
        this.segments.set(this.segments().filter((s) => s.id !== segment.id));
        if (this.segmentId() === segment.id) this.applySegment(null);
      },
      error: (e: Error) => this.flash('warn', e.message),
    });
  }

  protected consentLabel(c: Contact2) {
    if (c.optedOut) return 'Opted out';
    if (c.status !== 'active') return c.status;
    return c.optInStatus === 'opted_in' ? 'Opted in' : 'Unknown';
  }

  protected consentTone(c: Contact2) {
    if (c.optedOut) return 'tone-bad';
    if (c.status !== 'active') return 'tone-mute';
    return c.optInStatus === 'opted_in' ? 'tone-ok' : 'tone-warn';
  }
}

/** `key=value` per line, which is faster to type than JSON and harder to break. */
function parseFields(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of value.split('\n')) {
    const at = line.indexOf('=');
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    if (key) out[key] = line.slice(at + 1).trim();
  }
  return out;
}
