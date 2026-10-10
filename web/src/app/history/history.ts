import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Api, MessageRecord } from '../core/api';
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
  'SANDBOX',
];

/** Placeholder rows shown while the first page loads. */
const SKELETON_ROWS: readonly number[] = [0, 1, 2, 3, 4];

/** Pill tone per delivery status, matching the colour the global `.status-*` classes use. */
const STATUS_TONE: Readonly<Record<string, string>> = {
  SENT: 'tone-ok',
  DELIVERED: 'tone-ok',
  READ: 'tone-ok',
  SENDING: 'tone-info',
  FAILED: 'tone-bad',
  SANDBOX: 'tone-warn',
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
  imports: [FormsModule],
  templateUrl: './history.html',
  styleUrl: './history.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HistoryView {
  private readonly api = inject(Api);
  private readonly store = inject(Store);

  protected readonly statuses = STATUSES;
  protected readonly skeletonRows = SKELETON_ROWS;
  protected readonly status = signal('ALL');
  protected readonly recipient = signal('');
  protected readonly records = signal<MessageRecord[]>([]);
  protected readonly counts = signal<Record<string, number>>({});
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  /** The signature the browser already holds; the server 204s when it matches. */
  private signature = '';

  constructor() {
    // Refetch when the filters change, and whenever the server says the
    // history moved. Nothing polls: the event stream drives it.
    effect(() => {
      this.status();
      this.recipient();
      this.store.historyRevision();
      untracked(() => this.load());
    });
  }

  protected load(force = false): void {
    if (force) this.signature = '';
    this.loading.set(true);
    this.error.set('');
    this.api
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

  protected onFilter(): void {
    this.signature = ''; // a new filter always fetches
    this.load(true);
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
