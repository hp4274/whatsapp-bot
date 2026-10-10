import { Component, ElementRef, afterNextRender, inject, input, output, signal, viewChild } from '@angular/core';

import { Contact2, ContactsApi, DuplicateGroup } from '../core/api';
import { displayPhone, hue, initials, relativeTime } from './contact-util';

/** Review numbers stored more than once and fold each group into one contact. */
@Component({
  selector: 'app-merge-dialog',
  templateUrl: './merge-dialog.html',
  styleUrl: './merge-dialog.scss',
  host: { '(document:keydown.escape)': 'close()' },
})
export class MergeDialog {
  private readonly api = inject(ContactsApi);

  readonly initial = input<DuplicateGroup[]>([]);
  readonly closed = output<void>();
  readonly merged = output<number>();

  protected readonly groups = signal<DuplicateGroup[]>([]);
  protected readonly keep = signal<Record<string, number>>({});
  protected readonly busyKey = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly removedTotal = signal(0);

  protected readonly displayPhone = displayPhone;
  protected readonly initials = initials;
  protected readonly hue = hue;
  protected readonly ago = relativeTime;

  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private readonly opener = document.activeElement as HTMLElement | null;
  private fresh = false;

  constructor() {
    afterNextRender(() => {
      if (!this.fresh) {
        this.groups.set(this.initial());
        this.keep.set(Object.fromEntries(this.initial().map((g) => [g.key, g.suggestedKeepId])));
      }
      queueMicrotask(() => this.panel()?.nativeElement.querySelector<HTMLElement>('input, button')?.focus());
    });
    // Always show the server's current view, not a stale banner count.
    this.api.duplicates().subscribe({
      next: ({ groups }) => {
        this.fresh = true;
        this.groups.set(groups);
        this.keep.set(Object.fromEntries(groups.map((g) => [g.key, this.keep()[g.key] ?? g.suggestedKeepId])));
      },
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected choose(group: DuplicateGroup, contact: Contact2) {
    this.keep.set({ ...this.keep(), [group.key]: contact.id });
  }

  protected mergeGroup(group: DuplicateGroup, then?: () => void) {
    const keepId = this.keep()[group.key] ?? group.suggestedKeepId;
    const mergeIds = group.contacts.map((c) => c.id).filter((id) => id !== keepId);
    this.busyKey.set(group.key);
    this.error.set('');
    this.api.merge(keepId, mergeIds).subscribe({
      next: ({ removed }) => {
        this.busyKey.set(null);
        this.groups.set(this.groups().filter((g) => g.key !== group.key));
        this.removedTotal.set(this.removedTotal() + removed.length);
        this.merged.emit(removed.length);
        then?.();
      },
      error: (err: Error) => {
        this.busyKey.set(null);
        this.error.set(err.message);
      },
    });
  }

  /** Merge every remaining group with its chosen survivor, one at a time. */
  protected mergeAll() {
    const next = this.groups()[0];
    if (next) this.mergeGroup(next, () => this.mergeAll());
  }

  protected skip(group: DuplicateGroup) {
    this.groups.set(this.groups().filter((g) => g.key !== group.key));
  }

  protected close() {
    if (this.busyKey()) return;
    this.closed.emit();
    this.opener?.focus?.();
  }

  protected fieldCount(c: Contact2) {
    return Object.keys(c.customFields).length;
  }
}
