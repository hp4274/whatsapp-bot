import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { type Campaign, type CampaignStatus, CampaignsApi, ChannelsApi } from '../core/api';
import { Store } from '../core/store';
import {
  canCancel,
  canDelete,
  canPause,
  canResume,
  canStart,
  count,
  listCounts,
  localTime,
  pct,
  progressOf,
  relativeTime,
  reportRates,
} from './campaign-format';
import { CampaignStatusPill } from './status-pill';

type Filter = 'all' | CampaignStatus;
type RowAction = 'start' | 'pause' | 'resume' | 'cancel' | 'delete';

/** What the status line says after each row action. */
const DONE: Record<RowAction, string> = {
  start: 'started',
  pause: 'paused',
  resume: 'resumed',
  cancel: 'stopped',
  delete: 'deleted',
};

/** Chip order follows what an operator checks first: what is queued, then what is moving. */
const FILTERS: readonly { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'running', label: 'Running' },
  { key: 'paused', label: 'Paused' },
  { key: 'done', label: 'Done' },
  { key: 'cancelled', label: 'Stopped' },
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
  /** Row id + action awaiting its second click. Disarms by itself after a few seconds. */
  protected readonly confirming = signal<{ id: number; action: RowAction } | null>(null);
  /** Rows with an action in flight; each row's buttons stay off until its own answer. */
  protected readonly busy = signal<ReadonlySet<number>>(new Set());
  /** What the last row action did, or why it could not; next to the list, not in the sidebar. */
  protected readonly notice = signal<{ text: string; bad: boolean } | null>(null);
  /** Bumped per list request, so a slow older answer never overwrites a newer one. */
  private loadSeq = 0;
  private disarm: ReturnType<typeof setTimeout> | undefined;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

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
      .filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.number ?? c.id) === q.replace(/^#/, ''));
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

  protected readonly canStart = canStart;
  protected readonly canPause = canPause;
  protected readonly canResume = canResume;
  protected readonly canCancel = canCancel;
  protected readonly canDelete = canDelete;
  protected readonly localTime = localTime;
  protected readonly count = count;
  protected readonly pct = pct;

  /** The business's numbers that are not connected now: a paused run on one offers Connect, as its Resume would be refused. */
  private readonly down = signal<ReadonlySet<number>>(new Set());
  /** "Connect": the QR popup for its numbers that are not connected (core/link-popup.ts). */
  protected connectNumber(c: Campaign): void {
    this.store.linkCampaign(c, (id) => this.down().has(id));
  }

  protected numberDown(c: Campaign): boolean {
    return c.channelId !== null && this.down().has(c.channelId);
  }

  constructor() {
    this.load();
    // Live updates arrive several times a second during a send: they refresh quietly, without the Refresh spinner.
    this.store.watch(['campaigns', 'campaign', 'history'], () => this.load(true));
    const numbersApi = inject(ChannelsApi);
    const loadNumbers = () =>
      numbersApi.list().subscribe({
        next: ({ channels }) => this.down.set(new Set(channels.filter((ch) => ch.status === 'active' && !ch.health?.connected).map((ch) => ch.id))),
        error: () => undefined, // without it a paused run offers Resume, as before
      });
    loadNumbers();
    // A number dropping or coming back (connection events notify 'channels').
    this.store.watch(['channels'], loadNumbers, 1000);
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.disarm);
      clearTimeout(this.noticeTimer);
    });
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

  /** `quiet`: a live update, not the person asking; the spinner is for first load and Refresh only. */
  protected load(quiet = false): void {
    const seq = ++this.loadSeq;
    if (!quiet) this.loading.set(true);
    this.api.list().subscribe({
      next: ({ campaigns }) => {
        if (seq !== this.loadSeq) return;
        this.campaigns.set(
          [...campaigns].sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
        );
        this.error.set('');
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: Error) => {
        if (seq !== this.loadSeq) return;
        this.loading.set(false);
        // A live refresh that fails keeps the list on screen: the next update tries again.
        if (quiet && this.loaded()) return;
        this.error.set(err.message);
        this.loaded.set(true);
      },
    });
  }

  protected relative(iso: string | null): string {
    return relativeTime(iso, this.store.now());
  }

  /**
   * The Results cell. Only sent / failed / progress: the list's stats are a snapshot written on
   * status changes, so Delivered / Read (which keep arriving after a run) live on the detail page.
   */
  /** Why the run is paused, held or closed early ("Today's limit reached…"), so nobody has to open each one. */
  protected reason(c: Campaign): string | null {
    return (c.options as { statusReason?: string | null } | undefined)?.statusReason ?? null;
  }

  protected result(c: Campaign) {
    // progressOf: a multi-day campaign counts against its whole list, not the days queued so far.
    const p = progressOf(c, this.store.now());
    const r = reportRates(listCounts(c.stats));
    return {
      // Paused keeps its bar too: "230 of 2,598" says how far it got.
      sending: c.status === 'running' || c.status === 'paused',
      total: p.total,
      done: p.done,
      donePct: p.pct,
      day: p.days ? `Day ${p.day} of ${p.days}` : '',
      attempted: r.attempted,
      sent: p.sent,
      failed: p.failed,
      failedPct: r.failed,
    };
  }

  protected isConfirming(id: number, action: RowAction): boolean {
    const c = this.confirming();
    return !!c && c.id === id && c.action === action;
  }

  protected isBusy(id: number): boolean {
    return this.busy().has(id);
  }

  private setBusy(id: number, on: boolean): void {
    this.busy.update((ids) => {
      const next = new Set(ids);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  protected act(c: Campaign, action: RowAction): void {
    if (this.isBusy(c.id)) return;
    clearTimeout(this.disarm);
    const destructive = action === 'cancel' || action === 'delete';
    if (destructive && !this.isConfirming(c.id, action)) {
      this.confirming.set({ id: c.id, action });
      // Stop and Delete cannot be undone: an armed button left alone must not take one stray click later.
      this.disarm = setTimeout(() => this.confirming.set(null), 4000);
      return;
    }
    this.confirming.set(null);
    this.setBusy(c.id, true);
    const done = {
      next: (res: { policyNotes?: string[] } | object) => {
        this.setBusy(c.id, false);
        // A start says when it sends together with another campaign, or what goes out tomorrow.
        const notes = ('policyNotes' in res && res.policyNotes) || [];
        this.say([`Campaign "${c.name}" ${DONE[action]}.`, ...notes].join(' '), false);
        this.load(true);
      },
      // The page banner's Try again reloads the list; a refused action is said next to it instead.
      error: (err: Error) => {
        this.setBusy(c.id, false);
        this.say(err.message, true);
      },
    };
    if (action === 'delete') this.api.remove(c.id).subscribe(done);
    else this.api.action(c.id, action).subscribe(done);
  }

  private say(text: string, bad: boolean): void {
    clearTimeout(this.noticeTimer);
    this.notice.set({ text, bad });
    // A refusal stays until dismissed: it may need reading twice.
    if (!bad) this.noticeTimer = setTimeout(() => this.notice.set(null), 6000);
  }
}
