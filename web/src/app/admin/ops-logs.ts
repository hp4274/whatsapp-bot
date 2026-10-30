import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { AdminFeed } from './admin-feed';
import type { LogFilter, LogLine } from './ops-api';
import { OpsApi } from './ops-api';

/** Lines per page; the server keeps about 2,000 in all. */
const PAGE = 100;
/** Most lines one live pull prepends; a larger gap reloads instead of leaving a hole. */
const LIVE_MAX = 200;

/**
 * Backend logs for the super admin: the server's recent structured log lines (already redacted), each with a plain
 * sentence as its main line and the raw JSON one click away. Warnings and errors arrive live (topic `logs`); other
 * lines show on the next refresh, since a line per request would flood every open screen.
 */
@Component({
  selector: 'app-ops-logs',
  templateUrl: './ops-logs.html',
  styleUrl: './ops-logs.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OpsLogs {
  private readonly api = inject(OpsApi);
  private readonly feed = inject(AdminFeed);
  private readonly destroyRef = inject(DestroyRef);

  /** From the URL (`?requestId=`), set by an audit entry's "Show backend logs for this request". */
  readonly requestId = input('');
  /** Asks the shell to drop `requestId` from the URL. */
  readonly clearRequest = output<void>();

  protected readonly filter = signal<LogFilter>({});
  protected readonly lines = signal<LogLine[]>([]);
  protected readonly next = signal<number | null>(null);
  protected readonly kept = signal({ size: 0, capacity: 0 });
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly open = signal<ReadonlySet<number>>(new Set());
  protected readonly fresh = signal<ReadonlySet<number>>(new Set());
  protected readonly active = computed(() => Object.values(this.filter()).some(Boolean));
  /** Level is a floor: "Warnings" shows warnings and errors. */
  protected readonly levels: readonly { k: string; l: string }[] = [
    { k: '', l: 'All' },
    { k: 'warn', l: 'Warnings' },
    { k: 'error', l: 'Errors' },
  ];

  private seq = 0;
  private typing?: ReturnType<typeof setTimeout>;
  private freshTimer?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const requestId = this.requestId();
      untracked(() => {
        this.filter.update((f) => ({ ...f, requestId: requestId || undefined }));
        this.open.set(new Set());
        this.reload();
      });
    });
    this.feed.watch(['logs'], () => this.pullNew());
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.typing);
      clearTimeout(this.freshTimer);
    });
  }

  /** Restart from the newest line; the shell's Refresh button calls this. */
  reload() {
    this.fetch(null);
  }

  private fetch(before: number | null) {
    const seq = ++this.seq;
    this.loading.set(true);
    this.error.set('');
    this.api
      .logs(this.filter(), before ? { before } : {}, PAGE)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          if (seq !== this.seq) return;
          this.lines.set(before ? [...this.lines(), ...page.lines] : page.lines);
          this.next.set(page.nextBefore);
          this.kept.set({ size: page.size, capacity: page.capacity });
          this.loading.set(false);
        },
        error: (err: Error) => {
          if (seq !== this.seq) return;
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  /** Prepend lines newer than the newest shown, keeping scroll and open rows. */
  private pullNew() {
    const newest = this.lines()[0]?.id;
    if (newest === undefined || this.loading()) return this.reload();
    const seq = this.seq;
    this.api
      .logs(this.filter(), { after: newest }, LIVE_MAX)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          if (seq !== this.seq || !page.lines.length) return;
          if (page.nextBefore) return this.reload();
          const known = new Set(this.lines().map((l) => l.id));
          const added = page.lines.filter((l) => !known.has(l.id));
          this.lines.update((lines) => [...added, ...lines]);
          this.kept.set({ size: page.size, capacity: page.capacity });
          this.fresh.set(new Set(added.map((l) => l.id)));
          clearTimeout(this.freshTimer);
          this.freshTimer = setTimeout(() => this.fresh.set(new Set()), 2400);
        },
        error: () => undefined, // the next warning or a manual refresh catches up
      });
  }

  protected loadMore() {
    const next = this.next();
    if (next && !this.loading()) this.fetch(next);
  }

  protected set(key: keyof LogFilter, value: string) {
    if (key === 'requestId' && !value && this.requestId()) {
      this.clearRequest.emit(); // the URL owns it: the effect above reloads once it is gone
      return;
    }
    this.filter.update((f) => ({ ...f, [key]: value || undefined }));
    this.open.set(new Set());
    this.reload();
  }

  protected typed(e: Event) {
    const value = (e.target as HTMLInputElement).value.trim();
    clearTimeout(this.typing);
    this.typing = setTimeout(() => this.set('q', value), 300);
  }

  protected requestTyped(e: Event) {
    this.set('requestId', (e.target as HTMLInputElement).value.trim());
  }

  protected toggle(id: number) {
    const next = new Set(this.open());
    if (!next.delete(id)) next.add(id);
    this.open.set(next);
  }

  protected json(line: LogLine): string {
    return JSON.stringify(line.line, null, 2);
  }

  /** "14:02:31" today, a short date before that. */
  protected clock(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  protected full(iso: string): string {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
  }
}
