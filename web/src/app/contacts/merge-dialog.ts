import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { Contact2, ContactsApi, DuplicateGroup } from '../core/api';
import { Auth } from '../core/auth';
import {
  displayPhone,
  dupeSignature,
  hue,
  initials,
  markNotDupe,
  notDupes,
  relativeTime,
} from './contact-util';

/**
 * Review numbers stored more than once and fold each group into one contact.
 *
 * Opens on the banner's cached groups so it is never empty on first paint, then
 * swaps in the server's current list; a group merged elsewhere simply vanishes.
 */
@Component({
  selector: 'app-merge-dialog',
  templateUrl: './merge-dialog.html',
  styleUrl: './merge-dialog.scss',
  host: { '(document:keydown.escape)': 'close()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MergeDialog {
  private readonly api = inject(ContactsApi);
  private readonly auth = inject(Auth);

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
  /** Focus goes back here on close, so keyboard users land where they started. */
  private readonly opener = document.activeElement as HTMLElement | null;
  /** Set once the server answered, so the cached `initial` groups never overwrite it. */
  private fresh = false;

  constructor() {
    afterNextRender(() => {
      if (!this.fresh) {
        this.groups.set(this.initial());
        this.keep.set(Object.fromEntries(this.initial().map((g) => [g.key, g.suggestedKeepId])));
      }
      queueMicrotask(() =>
        this.panel()?.nativeElement.querySelector<HTMLElement>('input, button')?.focus(),
      );
    });
    // Always show the server's current view, not a stale banner count.
    this.api.duplicates().subscribe({
      next: (res) => {
        const skipped = notDupes(this.auth.tenantId());
        const groups = res.groups.filter((g) => !skipped.has(dupeSignature(g)));
        this.fresh = true;
        this.groups.set(groups);
        this.keep.set(
          Object.fromEntries(groups.map((g) => [g.key, this.keep()[g.key] ?? g.suggestedKeepId])),
        );
      },
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected choose(group: DuplicateGroup, contact: Contact2) {
    this.keep.set({ ...this.keep(), [group.key]: contact.id });
  }

  protected mergeGroup(group: DuplicateGroup, then?: () => void) {
    if (this.busyKey()) return; // one merge at a time; the buttons are disabled too
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

  /** Remembered in this browser (the server keeps no such list), so the group stays away on reload. */
  protected skip(group: DuplicateGroup) {
    markNotDupe(this.auth.tenantId(), dupeSignature(group));
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
