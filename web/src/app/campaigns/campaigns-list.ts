import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { type Campaign, type CampaignStatus, CampaignsApi } from '../core/api';
import {
  durationLabel,
  localClock,
  localDayEnd,
  localDayStart,
  quietSlots,
} from '../core/quiet-time';
import { Store } from '../core/store';
import {
  canCancel,
  canDelete,
  canPause,
  canResume,
  canStart,
  localTime,
  relativeTime,
} from './campaign-format';
import { CampaignStatusPill } from './status-pill';

type Filter = 'all' | CampaignStatus;
type RowAction = 'start' | 'pause' | 'resume' | 'cancel' | 'delete';

/** Chip order follows what an operator checks first: what is queued, then what is moving. */
const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'running', label: 'Running' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Done' },
  { key: 'cancelled', label: 'Cancelled' },
  { key: 'draft', label: 'Draft' },
];

/**
 * Every campaign for the active workspace, newest first.
 *
 * Filtering and search are client-side because the list is small and already
 * loaded; the store's change feed triggers a reload so running campaigns stay
 * current. Cancel and delete need a second click on the same button instead of
 * a dialog, and the confirmation resets on blur.
 */
@Component({
  selector: 'app-campaigns-list',
  imports: [RouterLink, CampaignStatusPill],
  templateUrl: './campaigns-list.html',
  styleUrl: './campaigns-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignsListView {
  private readonly api = inject(CampaignsApi);
  private readonly store = inject(Store);

  protected readonly filters = FILTERS;
  protected readonly campaigns = signal<Campaign[]>([]);
  protected readonly filter = signal<Filter>('all');
  protected readonly search = signal('');
  protected readonly loading = signal(true);
  protected readonly loaded = signal(false);
  protected readonly error = signal('');
  /** Row id + action awaiting its second click. */
  protected readonly confirming = signal<{ id: number; action: RowAction } | null>(null);
  protected readonly busy = signal<number | null>(null);

  protected readonly counts = computed(() => {
    const out: Record<string, number> = { all: 0 };
    for (const c of this.campaigns()) {
      out['all']++;
      out[c.status] = (out[c.status] ?? 0) + 1;
    }
    return out;
  });

  protected readonly visible = computed(() => {
    const f = this.filter();
    const q = this.search().trim().toLowerCase();
    return this.campaigns()
      .filter((c) => f === 'all' || c.status === f)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.id) === q);
  });

  protected readonly pageSize = 10;
  protected readonly page = signal(0);
  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.visible().length / this.pageSize)),
  );
  /** Clamped here so a shrinking list (filter, delete) never leaves an empty page. */
  protected readonly pageIndex = computed(() => Math.min(this.page(), this.pageCount() - 1));
  protected readonly offset = computed(() => this.pageIndex() * this.pageSize);
  protected readonly rows = computed(() =>
    this.visible().slice(this.offset(), this.offset() + this.pageSize),
  );
  protected readonly from = computed(() => (this.visible().length ? this.offset() + 1 : 0));
  protected readonly to = computed(() => Math.min(this.visible().length, this.offset() + this.pageSize));

  /**
   * Today's quiet windows on the viewer's own local day: the server sends absolute instants (its
   * channel zone may differ from this browser's), so labels, the 00:00-24:00 bar and the "now" pin
   * are all in local time. The pin and the readout tick with `store.serverNow` (every second) so
   * the pin matches the server's idea of the windows even if this browser's clock is off.
   * Windows entirely outside the local day (the channel's day spills over it) stay as chips only.
   * Null when the tier system is off.
   */
  protected readonly quiet = computed(() => {
    const q = this.store.safety()?.quiet;
    if (!q?.windows?.length) return null;
    const now = this.store.serverNow();
    const dayStart = localDayStart(now);
    const dayLength = localDayEnd(now) - dayStart;
    const windows = quietSlots(q.windows, now).map((w) => {
      const from = Math.max(w.startAt, dayStart);
      const to = Math.min(w.endAt, dayStart + dayLength);
      return {
        ...w,
        onBar: to > from,
        from: ((from - dayStart) / dayLength) * 100,
        span: ((to - from) / dayLength) * 100,
        backIn: durationLabel(w.minutesLeft),
      };
    });
    return {
      windows,
      total: durationLabel(q.minutesToday),
      marker: ((now - dayStart) / dayLength) * 100,
      clock: localClock(now, true),
      summary: windows.map((w) => w.label + (w.day ? ` ${w.day}` : '')).join(', '),
    };
  });

  protected readonly canStart = canStart;
  protected readonly canPause = canPause;
  protected readonly canResume = canResume;
  protected readonly canCancel = canCancel;
  protected readonly canDelete = canDelete;
  protected readonly localTime = localTime;

  constructor() {
    this.load();
    this.store.watch(['campaigns', 'campaign', 'history'], () => this.load());
  }

  protected goTo(page: number): void {
    this.page.set(Math.min(Math.max(0, page), this.pageCount() - 1));
  }

  /** Filter or search changed: back to the first page. */
  protected setFilter(f: Filter): void {
    this.filter.set(f);
    this.page.set(0);
  }

  protected setSearch(q: string): void {
    this.search.set(q);
    this.page.set(0);
  }

  protected load(): void {
    this.loading.set(true);
    this.api.list().subscribe({
      next: ({ campaigns }) => {
        this.campaigns.set(
          [...campaigns].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
        );
        this.error.set('');
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
        this.loaded.set(true);
      },
    });
  }

  protected relative(iso: string | null): string {
    return relativeTime(iso, this.store.now());
  }

  protected sent(c: Campaign): number {
    const s = c.stats ?? {};
    if (typeof s.sent === 'number') return s.sent;
    const by = s.byStatus ?? {};
    return (by['SENT'] ?? 0) + (by['DELIVERED'] ?? 0) + (by['READ'] ?? 0) + (by['SANDBOX'] ?? 0);
  }

  protected failed(c: Campaign): number {
    return c.stats?.failed ?? c.stats?.byStatus?.['FAILED'] ?? 0;
  }

  protected isConfirming(id: number, action: RowAction): boolean {
    const c = this.confirming();
    return !!c && c.id === id && c.action === action;
  }

  protected act(c: Campaign, action: RowAction): void {
    const destructive = action === 'cancel' || action === 'delete';
    if (destructive && !this.isConfirming(c.id, action)) {
      this.confirming.set({ id: c.id, action });
      return;
    }
    this.confirming.set(null);
    this.busy.set(c.id);
    const done = {
      next: () => {
        this.busy.set(null);
        this.store.setStatus(`Campaign "${c.name}": ${action} done`, 'primary');
        this.load();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
        this.store.setStatus(err.message, 'danger');
      },
    };
    if (action === 'delete') this.api.remove(c.id).subscribe(done);
    else this.api.action(c.id, action).subscribe(done);
  }
}
