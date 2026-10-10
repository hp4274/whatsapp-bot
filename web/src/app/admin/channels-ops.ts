import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable } from 'rxjs';

import type { PlanRow } from './ops-api';
import { ChannelsOpsApi, type NumberHealth } from './channels-ops-api';

/** The row action waiting on a dialog: disconnect needs a confirm, move needs a target. */
type Pending = { readonly kind: 'disconnect' | 'move'; readonly row: NumberHealth };

/**
 * Every WhatsApp number on the platform, for the super admin.
 *
 * Problems sort to the top (server order), so the first rows are the ones to
 * act on. Pausing is reversible and goes straight through; force-disconnect
 * ends the WhatsApp session (a QR number must scan again), so it confirms; a
 * move checks the target's limits on the server, which is why the dialog only
 * hints at "2 / 3 numbers" rather than blocking.
 */
@Component({
  selector: 'app-channels-ops',
  imports: [],
  templateUrl: './channels-ops.html',
  styleUrl: './channels-ops.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelsOps {
  private readonly api = inject(ChannelsOpsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rows = signal<readonly NumberHealth[]>([]);
  protected readonly offlineOnly = signal(false);
  protected readonly pausedOnly = signal(false);
  /** Row id with a request in flight, so its buttons disable and nothing double-fires. */
  protected readonly busy = signal<number | null>(null);
  /** Result of the last action, shown above the table. */
  protected readonly notice = signal<{ readonly tone: 'ok' | 'bad'; readonly text: string } | null>(null);

  protected readonly pending = signal<Pending | null>(null);
  protected readonly tenants = signal<readonly PlanRow[]>([]);
  protected readonly target = signal<number | null>(null);

  protected readonly visible = computed(() =>
    this.rows().filter(
      (r) => (!this.offlineOnly() || !r.online) && (!this.pausedOnly() || r.status !== 'active'),
    ),
  );
  protected readonly offlineCount = computed(() => this.rows().filter((r) => !r.online).length);
  protected readonly pausedCount = computed(() => this.rows().filter((r) => r.status !== 'active').length);
  /** Businesses a number can move to: any but its current owner. */
  protected readonly targets = computed(() => {
    const from = this.pending()?.row.tenantId;
    return this.tenants().filter((t) => t.tenantId !== from && t.status !== 'archived');
  });

  constructor() {
    this.load();
    // The native <dialog> gives focus trapping and Escape for free; it just needs opening.
    effect(() => {
      const dialog = this.dialogRef()?.nativeElement;
      if (!dialog) return;
      if (this.pending() && !dialog.open) dialog.showModal();
      if (!this.pending() && dialog.open) dialog.close();
    });
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api
      .health()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ channels }) => {
          this.rows.set(channels);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected pause(row: NumberHealth): void {
    this.run(row, this.api.pause(row.id), `${this.label(row)} paused.`);
  }

  protected resume(row: NumberHealth): void {
    this.run(row, this.api.resume(row.id), `${this.label(row)} resumed.`);
  }

  protected askDisconnect(row: NumberHealth): void {
    this.pending.set({ kind: 'disconnect', row });
  }

  protected askMove(row: NumberHealth): void {
    this.target.set(null);
    this.pending.set({ kind: 'move', row });
    this.api
      .tenants()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ tenants }) => this.tenants.set(tenants),
        error: (err: Error) => this.notice.set({ tone: 'bad', text: err.message }),
      });
  }

  protected confirm(): void {
    const pending = this.pending();
    if (!pending) return;
    const { row } = pending;
    if (pending.kind === 'disconnect') {
      this.run(row, this.api.disconnect(row.id), `${this.label(row)} disconnected.`);
    } else {
      const to = this.target();
      if (to == null) return;
      const name = this.tenants().find((t) => t.tenantId === to)?.name ?? 'the new business';
      this.run(row, this.api.move(row.id, to), `${this.label(row)} moved to ${name}.`);
    }
    this.pending.set(null);
  }

  protected cancel(): void {
    this.pending.set(null);
  }

  protected pickTarget(value: string): void {
    this.target.set(value ? Number(value) : null);
  }

  protected label(row: NumberHealth): string {
    return row.phoneNumber || row.displayName;
  }

  /** Meta reports GREEN/YELLOW/RED (older APIs HIGH/MEDIUM/LOW). */
  protected qualityTone(rating: string | null): string {
    const r = (rating ?? '').toUpperCase();
    if (r === 'GREEN' || r === 'HIGH') return 'tone-ok';
    if (r === 'YELLOW' || r === 'MEDIUM') return 'tone-warn';
    if (r === 'RED' || r === 'LOW') return 'tone-bad';
    return 'tone-mute';
  }

  protected capPct(row: NumberHealth): number {
    return row.quota.limit ? Math.min(100, Math.round((row.quota.used / row.quota.limit) * 100)) : 0;
  }

  /** "5 min ago" for recent activity, a short date after a day. */
  protected ago(iso: string | null): string {
    if (!iso) return 'never';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  private run(row: NumberHealth, request: Observable<unknown>, done: string): void {
    this.busy.set(row.id);
    this.notice.set(null);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busy.set(null);
        this.notice.set({ tone: 'ok', text: done });
        this.load();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.notice.set({ tone: 'bad', text: err.message });
      },
    });
  }
}
