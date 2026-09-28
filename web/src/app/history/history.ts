import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Api, MessageRecord } from '../core/api';
import { Store } from '../core/store';

const STATUSES = ['ALL', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SANDBOX'];

@Component({
  selector: 'app-history',
  imports: [FormsModule],
  templateUrl: './history.html',
  styleUrl: './history.scss',
})
export class HistoryView {
  private readonly api = inject(Api);
  private readonly store = inject(Store);

  protected readonly statuses = STATUSES;
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
}
