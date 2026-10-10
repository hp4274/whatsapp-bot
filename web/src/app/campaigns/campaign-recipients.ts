import { Component, computed, input, signal } from '@angular/core';

import { CampaignAnalytics } from '../core/api';
import { localTime } from './campaign-format';

type Recipient = CampaignAnalytics['recipients'][number];

const PAGE = 500;

/** Short, human error text; the raw provider text stays in the tooltip. */
function friendlyError(error: string | null): string {
  if (!error) return '';
  const text = error.replace(/^(error|whatsapp|cloud api)\s*[:\-]\s*/i, '').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

@Component({
  selector: 'app-campaign-recipients',
  templateUrl: './campaign-recipients.html',
  styleUrl: './campaign-recipients.scss',
})
export class CampaignRecipients {
  readonly recipients = input.required<Recipient[]>();

  protected readonly status = signal('ALL');
  protected readonly search = signal('');
  protected readonly limit = signal(PAGE);

  protected readonly statusCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.recipients()) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  protected readonly filtered = computed(() => {
    const status = this.status();
    const q = this.search().trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    return this.recipients().filter((r) =>
      (status === 'ALL' || r.status === status)
      && (!q || (r.name ?? '').toLowerCase().includes(q) || (!!digits && r.phone.includes(digits))));
  });

  protected readonly shown = computed(() => this.filtered().slice(0, this.limit()));

  protected readonly localTime = localTime;
  protected readonly friendlyError = friendlyError;

  protected setStatus(value: string): void {
    this.status.set(value);
    this.limit.set(PAGE);
  }

  protected setSearch(value: string): void {
    this.search.set(value);
    this.limit.set(PAGE);
  }

  protected more(): void {
    this.limit.update((n) => n + PAGE);
  }
}
