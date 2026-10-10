import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';

import { Tilt } from '../school/tilt';
import {
  QueuedTemplate,
  Starter,
  StarterCategory,
  TemplateReviewApi,
  TenantMetaStatus,
} from './template-review-api';

type Tab = 'queue' | 'library' | 'meta';
type Decision = 'approve' | 'reject';
type Id = string | number;

/** Loading, error and data for one lazily loaded tab, so each tab fails on its own. */
class Slot<T> {
  readonly data = signal<T | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
}

export const TABS: readonly { readonly key: Tab; readonly label: string; readonly icon: string }[] = [
  { key: 'queue', label: 'Review queue', icon: 'ti-inbox' },
  { key: 'library', label: 'Starter library', icon: 'ti-books' },
  { key: 'meta', label: 'Meta sync', icon: 'ti-cloud' },
];

/** The categories Meta accepts; starters use the same set so a copy can be submitted as-is. */
export const STARTER_CATEGORIES: readonly StarterCategory[] = ['marketing', 'utility', 'authentication'];

/** Spam score bands: below the first reads as clean, at or above the second as likely spam. */
const SPAM_WARN = 40;
const SPAM_BAD = 70;
const FLASH_MS = 3000;

let nextId = 0;

/**
 * Super-admin moderation for message templates.
 *
 * Meta reviews Cloud API templates itself, but Baileys numbers have no such
 * gate, so their templates queue here with a heuristic spam score to guide
 * the call. The starter library is the platform's curated set tenants copy
 * from, and Meta sync is a read-only view of the statuses stored per tenant.
 *
 * Each tab loads on first open and keeps its own error, so a failing Meta
 * endpoint never blanks the queue. A rejection always carries a note because
 * it is what the tenant reads to fix the template.
 */
@Component({
  selector: 'app-template-review',
  imports: [DatePipe, Tilt],
  templateUrl: './template-review.html',
  styleUrl: './template-review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplateReview {
  private readonly api = inject(TemplateReviewApi);
  private readonly destroyRef = inject(DestroyRef);
  private flashTimer?: ReturnType<typeof setTimeout>;

  protected readonly uid = `tr${nextId++}`;
  protected readonly tabs = TABS;
  protected readonly categories = STARTER_CATEGORIES;
  /** Kept in code: literal braces in a template would parse as an ICU expression. */
  protected readonly bodyHint = 'Use {variable} placeholders, e.g. {studentName}';
  protected readonly tab = signal<Tab>('queue');
  protected readonly flash = signal('');

  protected readonly queue = new Slot<readonly QueuedTemplate[]>();
  protected readonly library = new Slot<readonly Starter[]>();
  protected readonly meta = new Slot<readonly TenantMetaStatus[]>();

  /** The card whose approve/reject note is open, keyed by `tenantId:id`. */
  protected readonly deciding = signal<{ readonly key: string; readonly action: Decision } | null>(null);
  protected readonly note = signal('');
  protected readonly decidingBusy = signal(false);
  protected readonly decideError = signal('');
  protected readonly canDecide = computed(() => {
    const d = this.deciding();
    return !!d && !this.decidingBusy() && (d.action === 'approve' || !!this.note().trim());
  });

  protected readonly formOpen = signal(false);
  /** `null` while creating a new starter. */
  protected readonly editId = signal<Id | null>(null);
  protected readonly fName = signal('');
  protected readonly fCategory = signal<StarterCategory>('utility');
  protected readonly fDescription = signal('');
  protected readonly fBody = signal('');
  protected readonly saving = signal(false);
  protected readonly formError = signal('');
  protected readonly canSave = computed(
    () => !this.saving() && !!this.fName().trim() && !!this.fBody().trim(),
  );
  /** Starter waiting on its inline "Delete?" confirmation. */
  protected readonly confirmDelete = signal<Id | null>(null);
  protected readonly deleting = signal(false);
  protected readonly deleteError = signal('');

  constructor() {
    this.loadQueue();
    this.destroyRef.onDestroy(() => clearTimeout(this.flashTimer));
  }

  protected open(tab: Tab) {
    this.tab.set(tab);
    const slot = this.slotFor(tab);
    if (slot.data() == null && !slot.loading() && !slot.error()) this.reload(tab);
  }

  protected reload(tab: Tab) {
    if (tab === 'queue') this.loadQueue();
    else if (tab === 'library') this.fetch(this.library, this.api.starters());
    else this.fetch(this.meta, this.api.meta());
  }

  protected key(t: QueuedTemplate): string {
    return `${t.tenantId}:${t.id}`;
  }

  protected spamTone(score: number): string {
    return score >= SPAM_BAD ? 'tone-bad' : score >= SPAM_WARN ? 'tone-warn' : 'tone-ok';
  }

  protected spamTitle(t: QueuedTemplate): string {
    return t.spam.reasons.length
      ? t.spam.reasons.map((r) => `+${r.points} ${r.reason}`).join('\n')
      : 'No spam signals found';
  }

  protected startDecision(t: QueuedTemplate, action: Decision) {
    this.deciding.set({ key: this.key(t), action });
    this.note.set('');
    this.decideError.set('');
  }

  protected cancelDecision() {
    this.deciding.set(null);
    this.decideError.set('');
  }

  protected confirmDecision(t: QueuedTemplate) {
    const d = this.deciding();
    if (!d || !this.canDecide()) return;
    this.decidingBusy.set(true);
    this.decideError.set('');
    this.api
      .decide(t, d.action, this.note().trim())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          const key = this.key(t);
          this.queue.data.update((list) => list?.filter((x) => this.key(x) !== key) ?? list);
          this.deciding.set(null);
          this.decidingBusy.set(false);
          this.showFlash(`${t.name} ${d.action === 'approve' ? 'approved' : 'rejected'}`);
        },
        error: (err: Error) => {
          this.decidingBusy.set(false);
          this.decideError.set(err.message);
        },
      });
  }

  protected newStarter() {
    this.fill(null, { name: '', category: 'utility', description: '', body: '' });
  }

  protected editStarter(s: Starter) {
    this.fill(s.id, s);
  }

  protected closeForm() {
    this.formOpen.set(false);
    this.formError.set('');
  }

  protected saveStarter() {
    if (!this.canSave()) return;
    const id = this.editId();
    this.saving.set(true);
    this.formError.set('');
    this.api
      .saveStarter(id, {
        name: this.fName().trim(),
        category: this.fCategory(),
        description: this.fDescription().trim(),
        body: this.fBody(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (starter) => {
          this.library.data.update((list) =>
            id == null
              ? [starter, ...(list ?? [])]
              : (list ?? []).map((s) => (s.id === id ? starter : s)),
          );
          this.saving.set(false);
          this.formOpen.set(false);
          this.showFlash(id == null ? 'Starter added' : 'Starter saved');
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.formError.set(err.message);
        },
      });
  }

  protected askDelete(id: Id | null) {
    this.confirmDelete.set(id);
    this.deleteError.set('');
  }

  protected deleteStarter(s: Starter) {
    if (this.deleting()) return;
    this.deleting.set(true);
    this.deleteError.set('');
    this.api
      .deleteStarter(s.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.library.data.update((list) => list?.filter((x) => x.id !== s.id) ?? list);
          if (this.editId() === s.id) this.formOpen.set(false);
          this.confirmDelete.set(null);
          this.deleting.set(false);
          this.showFlash(`${s.name} deleted`);
        },
        error: (err: Error) => {
          this.deleting.set(false);
          this.deleteError.set(err.message);
        },
      });
  }

  private fill(id: Id | null, s: Pick<Starter, 'name' | 'category' | 'description' | 'body'>) {
    this.editId.set(id);
    this.fName.set(s.name);
    this.fCategory.set(s.category);
    this.fDescription.set(s.description);
    this.fBody.set(s.body);
    this.formError.set('');
    this.formOpen.set(true);
  }

  private loadQueue() {
    this.deciding.set(null);
    this.fetch(this.queue, this.api.queue());
  }

  private slotFor(tab: Tab): Slot<unknown> {
    return tab === 'queue' ? this.queue : tab === 'library' ? this.library : this.meta;
  }

  private fetch<T>(slot: Slot<T>, source: Observable<T>) {
    slot.loading.set(true);
    slot.error.set('');
    source.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (data) => {
        slot.data.set(data);
        slot.loading.set(false);
      },
      error: (err: Error) => {
        slot.error.set(err.message);
        slot.loading.set(false);
      },
    });
  }

  private showFlash(text: string) {
    clearTimeout(this.flashTimer);
    this.flash.set(text);
    this.flashTimer = setTimeout(() => this.flash.set(''), FLASH_MS);
  }
}
