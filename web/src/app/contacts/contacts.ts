import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Contact2, ContactFilter, ContactsApi, Segment, TimelineEntry } from '../core/api';
import { Store } from '../core/store';

@Component({
  selector: 'app-contacts',
  imports: [FormsModule],
  templateUrl: './contacts.html',
  styleUrl: './contacts.scss',
})
export class ContactsView {
  private readonly api = inject(ContactsApi);
  private readonly store = inject(Store);

  protected readonly contacts = signal<Contact2[]>([]);
  protected readonly total = signal(0);
  protected readonly tags = signal<{ tag: string; count: number }[]>([]);
  protected readonly fieldKeys = signal<string[]>([]);
  protected readonly segments = signal<Segment[]>([]);
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  protected readonly search = signal('');
  protected readonly activeTags = signal<string[]>([]);
  protected readonly hideOptedOut = signal(false);

  protected readonly openId = signal<number | null>(null);
  protected readonly timeline = signal<TimelineEntry[]>([]);
  protected readonly showForm = signal(false);
  protected readonly draft = signal({ phone: '', name: '', email: '', tags: '', fields: '' });

  protected readonly filter = computed<ContactFilter>(() => {
    const filter: ContactFilter = {};
    if (this.search().trim()) filter.search = this.search().trim();
    if (this.activeTags().length) filter.tags = this.activeTags();
    if (this.hideOptedOut()) filter.optedOut = false;
    return filter;
  });

  protected readonly open = computed(() => this.contacts().find((c) => c.id === this.openId()) ?? null);

  constructor() {
    this.refresh();
    this.store.watch(['contacts', 'segments'], () => this.refresh());
  }

  protected refresh() {
    this.api.list(this.filter()).subscribe({
      next: ({ contacts, total, tags, fieldKeys }) => {
        this.contacts.set(contacts);
        this.total.set(total);
        this.tags.set(tags);
        this.fieldKeys.set(fieldKeys);
      },
      error: (err: Error) => this.error.set(err.message),
    });
    this.api.segments().subscribe({ next: ({ segments }) => this.segments.set(segments) });
  }

  protected toggleTag(tag: string) {
    const next = this.activeTags().includes(tag)
      ? this.activeTags().filter((t) => t !== tag)
      : [...this.activeTags(), tag];
    this.activeTags.set(next);
    this.refresh();
  }

  protected clearFilters() {
    this.search.set('');
    this.activeTags.set([]);
    this.hideOptedOut.set(false);
    this.refresh();
  }

  protected create(event: Event) {
    event.preventDefault();
    const d = this.draft();
    this.busy.set(true);
    this.error.set('');
    this.api
      .save({
        phone: d.phone.trim(),
        name: d.name.trim(),
        email: d.email.trim(),
        tags: splitList(d.tags),
        customFields: parseFields(d.fields),
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.showForm.set(false);
          this.draft.set({ phone: '', name: '', email: '', tags: '', fields: '' });
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected inspect(contact: Contact2) {
    if (this.openId() === contact.id) {
      this.openId.set(null);
      return;
    }
    this.openId.set(contact.id);
    this.timeline.set([]);
    this.api.timeline(contact.id).subscribe({
      next: ({ timeline }) => this.timeline.set(timeline),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected addTag(contact: Contact2, raw: string) {
    const tag = raw.trim();
    if (!tag) return;
    this.api.tag(contact.id, [tag]).subscribe({ next: () => this.refresh(), error: (e: Error) => this.error.set(e.message) });
  }

  protected dropTag(contact: Contact2, tag: string) {
    this.api.tag(contact.id, [], [tag]).subscribe({ next: () => this.refresh(), error: (e: Error) => this.error.set(e.message) });
  }

  protected remove(contact: Contact2) {
    this.api.remove(contact.id).subscribe({ next: () => this.refresh(), error: (e: Error) => this.error.set(e.message) });
  }

  protected upload(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.busy.set(true);
    this.api.importFile(file).subscribe({
      next: () => {
        this.busy.set(false);
        input.value = '';
        this.refresh();
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  /** Save what is on screen as a reusable audience. */
  protected saveSegment(name: string) {
    if (!name.trim()) return;
    this.api.saveSegment({ name: name.trim(), filter: this.filter() }).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected applySegment(segment: Segment) {
    this.search.set(segment.filter.search ?? '');
    this.activeTags.set(segment.filter.tags ?? []);
    this.hideOptedOut.set(segment.filter.optedOut === false);
    this.refresh();
  }

  protected deleteSegment(segment: Segment) {
    this.api.deleteSegment(segment.id).subscribe({ next: () => this.refresh(), error: (e: Error) => this.error.set(e.message) });
  }

  protected fieldEntries(contact: Contact2) {
    return Object.entries(contact.customFields);
  }
}

const splitList = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);

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
