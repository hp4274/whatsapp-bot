import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { Subscription } from 'rxjs';

import { localTime, statusLabel } from '../campaigns/campaign-format';
import { Api, MessageRecord } from '../core/api';
import { Pager, pageOf } from '../core/pager';
import { Store } from '../core/store';

/** Filter options; `ALL` is a UI-only value the server treats as "no filter". */
const STATUSES: readonly string[] = [
  'ALL',
  'QUEUED',
  'SENDING',
  'SENT',
  'DELIVERED',
  'READ',
  'FAILED',
  'CANCELLED',
  'SANDBOX',
  'NOT_ON_WHATSAPP',
];

/** Placeholder rows shown while the first page loads. */
const SKELETON_ROWS: readonly number[] = [0, 1, 2, 3, 4];
/** Message rows per page. */
const PAGE_SIZE = 20;

/** Pill tone per delivery status, matching the colour the global `.status-*` classes use. */
const STATUS_TONE: Readonly<Record<string, string>> = {
  SENT: 'tone-ok',
  DELIVERED: 'tone-ok',
  READ: 'tone-ok',
  SENDING: 'tone-info',
  FAILED: 'tone-bad',
  SANDBOX: 'tone-warn',
  NOT_ON_WHATSAPP: 'tone-warn',
};

/**
 * Every message the app sent, with the status the transport really reported.
 *
 * Nothing polls: the server's event stream bumps `Store.historyRevision`, and
 * a signature lets the server answer 204 when the page the browser holds is
 * still current.
 */
@Component({
  selector: 'app-history',
  imports: [FormsModule, Pager],
  templateUrl: './history.html',
  styleUrl: './history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryView {
  private readonly api = inject(Api);
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statuses = STATUSES;
  protected readonly skeletonRows = SKELETON_ROWS;
  protected readonly status = signal('ALL');
  /** The recipient filter in force. It changes on Enter, not per keystroke, so typing never refetches. */
  protected readonly recipient = signal('');
  /** What the recipient box holds right now; Enter copies it into `recipient`. */
  protected readonly recipientDraft = signal('');
  /** A filter narrows the list, so an empty result means "no match", not "nothing sent". */
  protected readonly filtered = computed(() => this.status() !== 'ALL' || this.recipient() !== '');
  protected readonly records = signal<MessageRecord[]>([]);
  protected readonly counts = signal<Record<string, number>>({});
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly pageSize = PAGE_SIZE;
  /** Back to the first page whenever a filter (which refetches) changes; a live update keeps the page. */
  protected readonly page = linkedSignal(() => {
    this.status();
    this.recipient();
    return 0;
  });
  protected readonly shown = computed(() => pageOf(this.records(), this.page(), PAGE_SIZE));

  /** The same short local date and time the campaign screens use. */
  protected readonly localTime = localTime;

  /** Sentence-case words for a status code; the filter's `ALL` reads "All statuses". */
  protected label(status: string): string {
    return status === 'ALL' ? 'All statuses' : statusLabel(status);
  }

  /** A recipient as typed may already carry its "+" (a pasted list); show exactly one. */
  protected phone(recipient: string): string {
    return `+${recipient.replace(/^\+/, '')}`;
  }

  /** The signature the browser already holds; the server 204s when it matches. */
  private signature = '';
  /** The filters `signature` was issued for; a new filter must fetch in full. */
  private signatureFor = '';
  /**
   * The request in flight. A newer load cancels it, so a slow answer for an
   * old filter can never land on top of the list for the new one.
   */
  private inflight?: Subscription;

  constructor() {
    // Refetch when the filters change, and whenever the server says the
    // history moved. Nothing polls: the event stream drives it. This is the
    // only trigger for a filter change, so one change sends one request.
    effect(() => {
      this.status();
      this.recipient();
      this.store.historyRevision();
      untracked(() => this.load());
    });
    this.destroyRef.onDestroy(() => this.inflight?.unsubscribe());
  }

  protected load(force = false): void {
    const filters = `${this.status()}|${this.recipient().trim()}`;
    if (force || filters !== this.signatureFor) this.signature = '';
    this.signatureFor = filters;
    this.loading.set(true);
    this.error.set('');
    this.inflight?.unsubscribe();
    this.inflight = this.api
      .history({
        status: this.status(),
        recipient: this.recipient().trim(),
        signature: this.signature,
      })
      .subscribe({
        next: (response) => {
          this.loading.set(false);
          if (response.status === 204 || !response.body) return; // nothing changed
          this.records.set(response.body.records);
          this.counts.set(response.body.counts);
          this.signature = response.body.signature;
        },
        error: (err: Error) => {
          this.loading.set(false);
          this.error.set(err.message);
        },
      });
  }

  /** Enter in the recipient box applies it; the effect then loads once. */
  protected applyRecipient(): void {
    this.recipient.set(this.recipientDraft().trim());
  }

  protected clearFilters(): void {
    this.status.set('ALL');
    this.recipientDraft.set('');
    this.recipient.set('');
  }

  protected countEntries(): { status: string; n: number }[] {
    return Object.entries(this.counts())
      .map(([status, n]) => ({ status, n }))
      .sort((a, b) => a.status.localeCompare(b.status));
  }

  protected toneFor(status: string): string {
    return STATUS_TONE[status] ?? 'tone-mute';
  }
}
