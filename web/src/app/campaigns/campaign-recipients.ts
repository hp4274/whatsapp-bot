import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
} from '@angular/core';

import type { CampaignAnalytics } from '../core/api';
import { scrollToTop } from '../core/scroll';
import { count, localTime, statusLabel } from './campaign-format';
import { CampaignStatusPill } from './status-pill';

type Recipient = CampaignAnalytics['recipients'][number];

/** Rows rendered per step; big audiences would otherwise stall the first paint. */
const PAGE = 500;

/** Short, human error text; the raw provider text stays in the tooltip. */
function friendlyError(error: string | null): string {
  if (!error) return '';
  const text = error.replace(/^(error|whatsapp|cloud api)\s*[:\-]\s*/i, '').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/**
 * Every recipient with their latest delivery status, filterable by status,
 * name or phone. Rows render in pages of {@link PAGE} and filtering resets the
 * page so a narrow filter never hides matches behind "Show more".
 */
@Component({
  selector: 'app-campaign-recipients',
  imports: [CampaignStatusPill],
  templateUrl: './campaign-recipients.html',
  styleUrl: './campaign-recipients.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignRecipients {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly recipients = input.required<Recipient[]>();
  /** The failure buckets from analytics: their labels name a recipient's failure in plain words. */
  readonly failures = input<CampaignAnalytics['failures']>([]);
  /** A campaign shared over several numbers: each number's name, to show and filter its own list. */
  readonly numbers = input<{ channelId: number; label: string }[]>([]);

  protected readonly status = signal('ALL');
  protected readonly search = signal('');
  protected readonly limit = signal(PAGE);
  /** One number's list, or every number's ('ALL'). */
  protected readonly number = signal<number | 'ALL'>('ALL');
  protected readonly shared = computed(() => this.numbers().length > 1);

  protected numberLabel(id: number | undefined): string {
    return this.numbers().find((n) => n.channelId === id)?.label ?? '-';
  }

  protected numberCount(id: number): number {
    return this.recipients().filter((r) => r.channelId === id).length;
  }

  protected readonly statusCounts = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.recipients()) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  });

  protected readonly failedCount = computed(
    () => this.statusCounts().find(([s]) => s === 'FAILED')?.[1] ?? 0,
  );

  /** errorCode -> friendly label; the generic UNKNOWN bucket is per-text, so it is left out. */
  private readonly reasonByCode = computed(
    () =>
      new Map(this.failures().filter((f) => f.code !== 'UNKNOWN').map((f) => [f.code, f.label])),
  );

  protected readonly filtered = computed(() => {
    const status = this.status();
    const q = this.search().trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const number = this.number();
    return this.recipients().filter(
      (r) =>
        (number === 'ALL' || r.channelId === number) &&
        (status === 'ALL' || r.status === status) &&
        (!q || (r.name ?? '').toLowerCase().includes(q) || (!!digits && r.phone.includes(digits))),
    );
  });

  protected readonly shown = computed(() => this.filtered().slice(0, this.limit()));

  protected readonly localTime = localTime;
  protected readonly count = count;
  protected readonly statusLabel = statusLabel;

  /** Plain-words reason for a failed row; the raw provider text stays in the tooltip. */
  protected reason(r: Recipient): string {
    if (r.status !== 'FAILED') return friendlyError(r.error);
    return (r.errorCode && this.reasonByCode().get(r.errorCode)) || friendlyError(r.error) || 'Unknown error';
  }

  /** Filter to one status and bring the table into view (used by "See who failed"). */
  showStatus(value: string): void {
    this.setStatus(value);
    this.search.set('');
    scrollToTop(this.host.nativeElement);
  }

  protected setStatus(value: string): void {
    this.status.set(value);
    this.limit.set(PAGE);
  }

  protected setNumber(value: string): void {
    this.number.set(value === 'ALL' ? 'ALL' : Number(value));
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
