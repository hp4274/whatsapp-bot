import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Api, Contact, SafetyStatus } from '../core/api';
import { Store } from '../core/store';

@Component({
  selector: 'app-campaign',
  imports: [FormsModule],
  templateUrl: './campaign.html',
  styleUrl: './campaign.scss',
})
export class CampaignView {
  private readonly api = inject(Api);
  protected readonly store = inject(Store);

  protected readonly recipient = signal('');
  protected readonly recipientName = signal('');
  protected readonly message = signal('Hello {name}, your order has been confirmed.');
  protected readonly bulkMessage = signal('Hello {name}, your order has been confirmed.');
  protected readonly contacts = signal<Contact[]>([]);
  protected readonly shown = computed(() => this.contacts().slice(0, 100));
  protected readonly ownCount = computed(() => this.contacts().filter((c) => this.own(c)).length);
  protected readonly fileName = signal('');
  protected readonly importErrors = signal<string[]>([]);
  protected readonly onePerNumber = signal(true);
  protected readonly busy = signal(false);
  protected readonly notice = signal('');
  protected readonly plan = signal<SafetyStatus | null>(null);

  protected readonly connected = computed(() => this.store.connection().connected);

  protected readonly preview = computed(() => {
    const first = this.contacts()[0];
    if (!first) return '';
    const context: Record<string, string> = {
      name: first.name,
      phone: first.phone,
      ...(first.extra ?? {}),
    };
    return `Preview for ${first.name || first.phone}: ${substitute(this.own(first) || this.bulkMessage(), context)}`;
  });

  protected readonly percent = computed(() => Math.round(this.store.progress() * 100));

  /** What this batch will cost: how long, and how much of today's budget. */
  protected readonly overQuota = computed(() => {
    const plan = this.plan();
    if (!plan || plan.remaining === null) return 0;
    return Math.max(0, this.contacts().length - plan.remaining);
  });

  protected readonly estimate = computed(() => {
    const plan = this.plan();
    if (!plan || this.contacts().length < 2) return '';
    return `about ${formatDuration(plan.estimateSeconds.typical)} `
      + `(${plan.minSeconds}-${plan.maxSeconds}s between messages)`;
  });

  private planFor(count: number): void {
    this.api.safety(count).subscribe({
      next: ({ safety }) => this.plan.set(safety),
      error: () => this.plan.set(null),
    });
  }

  protected sendSingle(): void {
    if (!this.connected()) {
      this.notice.set('Connect a transport on the Connection page first.');
      return;
    }
    this.busy.set(true);
    this.api.sendMessage(this.recipient(), this.message(), this.recipientName()).subscribe({
      next: ({ messageId, recipient }) => {
        this.busy.set(false);
        this.notice.set('');
        // Report the number the server normalised to, not the raw input.
        this.store.setStatus(`Queued ${messageId.slice(0, 8)} -> +${recipient}`, 'primary');
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.notice.set(err.message);
      },
    });
  }

  /** A number's own text: the `message` column of the sheet, or what was typed in the table. */
  protected own(contact: Contact): string {
    return (contact.extra?.['message'] ?? contact.extra?.['custom_message'] ?? '').trim();
  }

  protected setOwn(index: number, value: string): void {
    this.contacts.update((list) => list.map((c, i) => i === index
      ? { ...c, extra: { ...(c.extra ?? {}), message: value } } : c));
  }

  protected onFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.fileName.set(file.name);
    this.api.importContacts(file).subscribe({
      next: (result) => {
        this.contacts.set(result.contacts);
        this.importErrors.set(result.errors);
        this.planFor(result.contacts.length);
        this.store.setStatus(
          `Loaded ${result.contacts.length} contact(s); ${result.duplicates} duplicate(s) skipped`,
        );
      },
      error: (err: Error) => {
        this.contacts.set([]);
        this.importErrors.set([err.message]);
      },
    });
    input.value = ''; // allow re-importing the same file
  }

  protected start(): void {
    if (!this.connected()) {
      this.notice.set('Connect a transport on the Connection page first.');
      return;
    }
    if (!this.contacts().length) {
      this.notice.set('Import a CSV or XLSX file first.');
      return;
    }
    this.busy.set(true);
    this.api.startCampaign(this.contacts(), this.bulkMessage(), this.onePerNumber()).subscribe({
      next: ({ queued, skipped, safety }) => {
        this.busy.set(false);
        this.notice.set('');
        this.plan.set(safety);
        const reason = this.onePerNumber() ? 'repeat or already-messaged number' : 'duplicate message';
        this.store.setStatus(`Campaign started: ${queued} queued, ${skipped} skipped (${reason})`, 'primary');
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.notice.set(err.message);
      },
    });
  }

  protected control(action: 'pause' | 'resume' | 'stop'): void {
    this.api.campaignAction(action).subscribe({
      next: ({ stats }) => {
        this.store.stats.set(stats);
        this.store.setStatus(`Campaign ${action}d.`);
      },
      error: (err: Error) => this.notice.set(err.message),
    });
  }
}

/** Mirrors the server's personalisation so the preview tells the truth. */
function substitute(template: string, context: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => context[key] ?? match);
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}
