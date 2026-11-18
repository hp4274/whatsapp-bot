import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { localTime, relativeTime } from '../campaigns/campaign-format';
import { Store } from '../core/store';
import { AutoRepliesApi, LogLine, LogOutcome } from './auto-replies.api';

const FILTERS: readonly { readonly value: LogOutcome | null; readonly label: string }[] = [
  { value: null, label: 'All' },
  { value: 'replied', label: 'Replied' },
  { value: 'none', label: 'No reply' },
  { value: 'skipped', label: 'Skipped' },
  { value: 'failed', label: 'Failed' },
];

const OUTCOME: Record<LogOutcome, { readonly label: string; readonly icon: string }> = {
  replied: { label: 'Replied', icon: 'message-check' },
  none: { label: 'No reply', icon: 'message-off' },
  skipped: { label: 'Skipped', icon: 'circle-minus' },
  failed: { label: 'Failed', icon: 'alert-circle' },
};

/**
 * What the automation did with each incoming message, newest first: the rule that replied and what it said, or
 * why nothing went out. Reloads as messages arrive (the server announces `auto-replies` after each one).
 */
@Component({
  selector: 'ar-activity-log',
  templateUrl: './activity-log.html',
  styleUrl: './activity-log.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActivityLog {
  private readonly api = inject(AutoRepliesApi);
  protected readonly store = inject(Store);

  protected readonly filters = FILTERS;
  protected readonly outcomes = OUTCOME;
  protected readonly filter = signal<LogOutcome | null>(null);
  protected readonly lines = signal<LogLine[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly localTime = localTime;

  constructor() {
    this.load();
    this.store.watch(['auto-replies'], () => this.load());
  }

  protected pick(value: LogOutcome | null): void {
    this.filter.set(value);
    this.load();
  }

  protected ago(iso: string): string {
    return relativeTime(iso, this.store.now());
  }

  protected load(): void {
    this.api.log(this.filter()).subscribe({
      next: ({ log }) => {
        this.lines.set(log);
        this.error.set('');
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }
}
