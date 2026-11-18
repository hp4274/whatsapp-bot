import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ArSwitch } from '../auto-replies/ar-fields';
import { Api, PaymentReminder, SafetyStatus } from '../core/api';
import { Pager, pageOf } from '../core/pager';
import { Store } from '../core/store';
import { Due, DueSettings, DuesState, PaymentReminderApi } from './payment-reminder-api';

/** Imported rows and dues per page. */
const PAGE_SIZE = 20;

/** The ledger's filter tabs. `claimed` is a customer who replied PAID and is waiting to be checked. */
type DueFilter = 'open' | 'overdue' | 'claimed' | 'paid' | 'all';
const FILTERS: readonly { key: DueFilter; label: string }[] = [
  { key: 'open', label: 'Open' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'claimed', label: 'Says paid' },
  { key: 'paid', label: 'Paid' },
  { key: 'all', label: 'All' },
];

/** The placeholders the server fills (server/src/paymentReminders.js), shown under the message box. */
const PLACEHOLDERS: readonly string[] = ['{name}', '{amount}', '{due_date}', '{invoice}', '{upi_link}'];

/** A due's state for the pill: a claim or a passed date says more than the stored status. */
type DueState = 'pending' | 'overdue' | 'claimed' | 'paid' | 'closed';
const STATE_LABEL: Record<DueState, string> = {
  pending: 'Pending',
  overdue: 'Overdue',
  claimed: 'Says paid',
  paid: 'Paid',
  closed: 'Cancelled',
};
const STATE_TONE: Record<DueState, string> = {
  pending: 'tone-info',
  overdue: 'tone-bad',
  claimed: 'tone-warn',
  paid: 'tone-ok',
  closed: 'tone-mute',
};

/**
 * Payment dues: a sheet is imported once and kept as a ledger, so the page answers "who still owes me" long
 * after the send. Reminders go by hand (the sheet's send) or on their own before, on and after the due date;
 * a customer who replies PAID is shown as "Says paid" until the business checks and marks it.
 *
 * Import and send stay separate steps so the operator can read the generated messages and the daily-budget
 * forecast before anything leaves the building.
 */
@Component({
  selector: 'app-payment-reminder',
  imports: [Pager, ArSwitch],
  templateUrl: './payment-reminder.html',
  styleUrl: './payment-reminder.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PaymentReminderView {
  private readonly api = inject(Api);
  private readonly duesApi = inject(PaymentReminderApi);
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filters = FILTERS;
  protected readonly placeholders = PLACEHOLDERS;
  protected readonly stateLabel = STATE_LABEL;
  protected readonly stateTone = STATE_TONE;
  protected readonly pageSize = PAGE_SIZE;

  // ---- ledger ----
  protected readonly ledger = signal<DuesState | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly query = signal('');
  protected readonly filter = signal<DueFilter>('open');
  protected readonly moving = signal<number | null>(null);

  private readonly money = computed(() => {
    const currency = this.ledger()?.settings.currency || 'INR';
    const format = new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    });
    return (n: number) => format.format(n || 0);
  });

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const filter = this.filter();
    return (this.ledger()?.dues ?? []).filter((d) => {
      const state = this.stateOf(d);
      const open = state === 'pending' || state === 'overdue' || state === 'claimed';
      const wanted =
        filter === 'all' ||
        (filter === 'open' && open) ||
        (filter === 'overdue' && state === 'overdue') ||
        (filter === 'claimed' && state === 'claimed') ||
        (filter === 'paid' && state === 'paid');
      if (!wanted) return false;
      if (!q) return true;
      return [d.metadata.name, d.metadata.phone, d.data.invoiceId].some((v) =>
        String(v ?? '').toLowerCase().includes(q),
      );
    });
  });
  protected readonly duesPage = linkedSignal(() => {
    this.filtered();
    return 0;
  });
  protected readonly shownDues = computed(() =>
    pageOf(this.filtered(), this.duesPage(), PAGE_SIZE),
  );
  /** "12 open · ₹48,000 pending" over every due, whatever the filter. */
  protected readonly summary = computed(() => {
    const open = (this.ledger()?.dues ?? []).filter((d) => d.status === 'pending' || d.status === 'overdue');
    const total = open.reduce((sum, d) => sum + (d.data.amount || 0), 0);
    return `${open.length} open · ${this.money()(total)} pending`;
  });

  // ---- message, UPI and automatic reminders: drafts reset whenever the saved settings change ----
  /** By value: a live reload of the dues must not wipe a message being typed. */
  private readonly saved = computed(() => this.ledger()?.settings ?? null, {
    equal: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  protected readonly rules = computed(() => this.ledger()?.rules ?? null);
  protected readonly template = linkedSignal(() => this.saved()?.template ?? '');
  protected readonly upiId = linkedSignal(() => this.saved()?.upiId ?? '');
  protected readonly payeeName = linkedSignal(() => this.saved()?.payeeName ?? '');
  protected readonly auto = linkedSignal(() => this.saved()?.auto ?? false);
  protected readonly daysBefore = linkedSignal(() => this.saved()?.daysBefore ?? 2);
  protected readonly onDueDay = linkedSignal(() => this.saved()?.onDueDay ?? true);
  protected readonly everyDays = linkedSignal(() => this.saved()?.everyDays ?? 3);
  protected readonly maxFollowUps = linkedSignal(() => this.saved()?.maxFollowUps ?? 3);
  protected readonly saving = signal(false);
  protected readonly settingsError = signal<string | null>(null);

  private readonly draft = computed<DueSettings | null>(() => {
    const saved = this.saved();
    if (!saved) return null;
    return {
      ...saved,
      template: this.template(),
      upiId: this.upiId().trim(),
      payeeName: this.payeeName(),
      auto: this.auto(),
      daysBefore: this.daysBefore(),
      onDueDay: this.onDueDay(),
      everyDays: this.everyDays(),
      maxFollowUps: this.maxFollowUps(),
    };
  });
  protected readonly dirty = computed(() => {
    const saved = this.saved();
    const draft = this.draft();
    return !!saved && !!draft && JSON.stringify(saved) !== JSON.stringify(draft);
  });

  /** The message as a customer would read it, filled the way the server fills it. */
  protected readonly preview = computed(() => {
    const draft = this.draft();
    if (!draft) return '';
    const allowUpi = this.rules()?.allowUpi !== false;
    const e = encodeURIComponent;
    const link =
      allowUpi && draft.upiId
        ? `upi://pay?pa=${e(draft.upiId)}&pn=${e(draft.payeeName || 'Payment')}&am=2500&cu=${e(draft.currency || 'INR')}&tn=INV-101`
        : '';
    const values: Record<string, string> = {
      name: 'Asha',
      amount: this.money()(2500),
      remaining: this.money()(2500),
      due_date: '25 Nov 2026',
      invoice: 'INV-101',
      upi_link: link,
    };
    const text = draft.template.trim();
    const filled = text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match).trim();
    return link && !text.includes('{upi_link}') ? `${filled}\nPay by UPI: ${link}` : filled;
  });

  // ---- sheet import and one-off send ----
  protected readonly reminders = signal<PaymentReminder[]>([]);
  protected readonly fileName = signal('');
  protected readonly importErrors = signal<string[]>([]);
  protected readonly duplicates = signal(0);
  protected readonly busy = signal(false);
  protected readonly notice = signal('');
  protected readonly plan = signal<SafetyStatus | null>(null);

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

  constructor() {
    this.reload();
    this.store.watch(['payment-reminders', 'objects'], () => this.reload());
  }

  protected stateOf(d: Due): DueState {
    if (d.status === 'paid') return 'paid';
    if (d.status !== 'pending' && d.status !== 'overdue') return 'closed';
    if (d.metadata.payment === 'claimed') return 'claimed';
    const today = this.ledger()?.today ?? '';
    return d.status === 'overdue' || d.data.dueAt.slice(0, 10) < today ? 'overdue' : 'pending';
  }

  protected amountOf(d: Due): string {
    // One format down the column; the sheet's own text ("Rs 1,250", "18500") only when there is no number.
    return Number.isFinite(d.data.amount) ? this.money()(d.data.amount) : d.metadata.amountText || '-';
  }

  protected dueDateOf(d: Due): string {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(new Date(d.data.dueAt));
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement | HTMLTextAreaElement).value;
  }

  protected num(event: Event): number {
    return Math.max(0, Math.floor(Number((event.target as HTMLInputElement).value) || 0));
  }

  protected move(d: Due, status: 'paid' | 'pending'): void {
    this.moving.set(d.id);
    this.duesApi
      .move(d.id, status)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.moving.set(null);
          this.store.setStatus(
            status === 'paid'
              ? `Marked ${d.metadata.name || '+' + d.metadata.phone} paid`
              : 'Reminders start again for this due',
          );
          this.reload();
        },
        error: (err: Error) => {
          this.moving.set(null);
          this.notice.set(err.message);
        },
      });
  }

  protected saveSettings(): void {
    const draft = this.draft();
    if (!draft) return;
    this.saving.set(true);
    this.settingsError.set(null);
    this.duesApi
      .saveSettings(draft)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ settings }) => {
          this.saving.set(false);
          this.ledger.update((l) => (l ? { ...l, settings } : l));
          this.store.setStatus('Payment reminder settings saved', 'primary');
        },
        error: (err: Error) => {
          this.saving.set(false);
          this.settingsError.set(err.message);
        },
      });
  }

  protected resetSettings(): void {
    const s = this.saved();
    if (!s) return;
    this.template.set(s.template);
    this.upiId.set(s.upiId);
    this.payeeName.set(s.payeeName);
    this.auto.set(s.auto);
    this.daysBefore.set(s.daysBefore);
    this.onDueDay.set(s.onDueDay);
    this.everyDays.set(s.everyDays);
    this.maxFollowUps.set(s.maxFollowUps);
  }

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
        const { created, updated } = result.saved;
        this.store.setStatus(
          `Loaded ${result.reminders.length} payment reminder(s): ${created} new due(s), ${updated} updated; ${result.duplicates} duplicate(s) skipped`,
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

  private reload(): void {
    this.duesApi
      .dues()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (state) => {
          this.ledger.set(state);
          this.loadError.set(null);
        },
        error: (err: Error) => this.loadError.set(err.message),
      });
  }

  private planFor(count: number): void {
    this.api.safety(count).subscribe({
      next: ({ safety }) => this.plan.set(safety),
      error: () => this.plan.set(null),
    });
  }
}
