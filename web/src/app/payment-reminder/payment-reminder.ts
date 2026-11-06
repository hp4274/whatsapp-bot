import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';

import { Api, PaymentReminder, SafetyStatus } from '../core/api';
import { Pager, pageOf } from '../core/pager';
import { Store } from '../core/store';

/** Imported rows per page. */
const PAGE_SIZE = 20;

/**
 * Turns an Excel sheet of payment dues into queued WhatsApp reminders.
 *
 * Import and send are separate steps so the operator can read the generated
 * messages and the daily-budget forecast before anything leaves the building.
 */
@Component({
  selector: 'app-payment-reminder',
  imports: [Pager],
  templateUrl: './payment-reminder.html',
  styleUrl: './payment-reminder.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentReminderView {
  private readonly api = inject(Api);
  private readonly store = inject(Store);

  protected readonly reminders = signal<PaymentReminder[]>([]);
  protected readonly fileName = signal('');
  protected readonly importErrors = signal<string[]>([]);
  protected readonly duplicates = signal(0);
  protected readonly busy = signal(false);
  protected readonly notice = signal('');
  protected readonly plan = signal<SafetyStatus | null>(null);

  protected readonly pageSize = PAGE_SIZE;
  /** Back to the first page on every import; nothing else replaces the rows. */
  protected readonly page = linkedSignal(() => {
    this.reminders();
    return 0;
  });
  protected readonly shown = computed(() => pageOf(this.reminders(), this.page(), PAGE_SIZE));
  protected readonly connected = computed(() => this.store.connection().connected);
  protected readonly validCount = computed(() => this.reminders().length);
  protected readonly firstPreview = computed(() => this.reminders()[0]?.finalMessage ?? '');
  protected readonly overQuota = computed(() => {
    const plan = this.plan();
    if (!plan || plan.remaining === null) return 0;
    return Math.max(0, this.validCount() - plan.remaining);
  });

  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.fileName.set(file.name);
    this.busy.set(true);
    this.notice.set('');
    this.api.importPaymentReminders(file).subscribe({
      next: (result) => {
        this.reminders.set(result.reminders);
        this.importErrors.set(result.errors);
        this.duplicates.set(result.duplicates);
        this.busy.set(false);
        this.planFor(result.reminders.length);
        this.store.setStatus(
          `Loaded ${result.reminders.length} payment reminder(s); ${result.duplicates} duplicate(s) skipped`,
        );
      },
      error: (err: Error) => {
        this.reminders.set([]);
        this.importErrors.set(err.message.split('\n'));
        this.duplicates.set(0);
        this.busy.set(false);
      },
    });
    input.value = '';
  }

  protected send(): void {
    if (!this.connected()) {
      this.notice.set('Link your WhatsApp number on the WhatsApp page first.');
      return;
    }
    if (!this.reminders().length) {
      this.notice.set('Import a payment Excel file first.');
      return;
    }

    this.busy.set(true);
    this.notice.set('');
    this.api.sendPaymentReminders(this.reminders()).subscribe({
      next: ({ queued, skipped, safety }) => {
        this.busy.set(false);
        this.plan.set(safety);
        this.store.setStatus(
          `Payment reminders started: ${queued} queued, ${skipped} skipped`,
          'primary',
        );
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.notice.set(err.message);
      },
    });
  }

  private planFor(count: number): void {
    this.api.safety(count).subscribe({
      next: ({ safety }) => this.plan.set(safety),
      error: () => this.plan.set(null),
    });
  }
}
