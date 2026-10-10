import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { CampaignRow } from './analytics-api';
import { downloadCsv, toCsv, today } from './analytics-util';

type SortKey = 'name' | 'sent' | 'deliveryRate' | 'readRate' | 'failed' | 'lastSentAt';
interface Column {
  key: SortKey;
  label: string;
  numeric: boolean;
}

const COLUMNS: Column[] = [
  { key: 'name', label: 'Campaign', numeric: false },
  { key: 'sent', label: 'Sent', numeric: true },
  { key: 'deliveryRate', label: 'Delivered', numeric: true },
  { key: 'readRate', label: 'Read rate', numeric: true },
  { key: 'failed', label: 'Failed', numeric: true },
  { key: 'lastSentAt', label: 'Last send', numeric: false },
];

/** Per-campaign breakdown for the range: sortable, each row opens its campaign. */
@Component({
  selector: 'app-campaign-table',
  imports: [RouterLink, DecimalPipe, DatePipe],
  templateUrl: './campaign-table.html',
  styleUrl: './campaign-table.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignTable {
  readonly rows = input.required<CampaignRow[]>();
  readonly days = input(30);

  protected readonly columns = COLUMNS;
  protected readonly sortKey = signal<SortKey>('lastSentAt');
  protected readonly dir = signal<'asc' | 'desc'>('desc');

  protected readonly sorted = computed(() => {
    const key = this.sortKey();
    const sign = this.dir() === 'asc' ? 1 : -1;
    return [...this.rows()].sort((a, b) => {
      const x = a[key];
      const y = b[key];
      // Missing values (no rate yet, never sent) sink to the bottom either way.
      if (x == null || y == null) return x == null && y == null ? 0 : x == null ? 1 : -1;
      const c = typeof x === 'string' ? x.localeCompare(String(y)) : (x as number) - (y as number);
      return c * sign || a.name.localeCompare(b.name);
    });
  });

  /** The table as shown (current sort), plus the counts the columns summarise. */
  protected exportCsv() {
    const header = [
      'Campaign',
      'Campaign ID',
      'Total',
      'Attempted',
      'Sent',
      'Delivered',
      'Read',
      'Failed',
      'Pending',
      'Delivery rate %',
      'Read rate %',
      'First send (UTC)',
      'Last send (UTC)',
    ];
    const rows = this.sorted().map((c) => [
      c.name,
      c.campaignId,
      c.total,
      c.attempted,
      c.sent,
      c.delivered,
      c.read,
      c.failed,
      c.pending,
      c.deliveryRate ?? '',
      c.readRate ?? '',
      c.firstSentAt ?? '',
      c.lastSentAt ?? '',
    ]);
    downloadCsv(`campaigns-${this.days()}d-${today()}.csv`, toCsv(header, rows));
  }

  protected sortBy(key: SortKey) {
    if (this.sortKey() === key) this.dir.set(this.dir() === 'asc' ? 'desc' : 'asc');
    else {
      this.sortKey.set(key);
      this.dir.set(key === 'name' ? 'asc' : 'desc');
    }
  }

  protected ariaSort(key: SortKey) {
    if (this.sortKey() !== key) return 'none';
    return this.dir() === 'asc' ? 'ascending' : 'descending';
  }

  /** A read rate is good above 50%, fine above 25%: a shape cue as well as a colour. */
  protected tier(rate: number | null) {
    if (rate == null) return 'none';
    return rate >= 50 ? 'hi' : rate >= 25 ? 'mid' : 'lo';
  }
}
