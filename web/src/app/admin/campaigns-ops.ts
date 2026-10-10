import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { CampaignsOpsApi, type CampaignFilter, type OpsCampaign } from './campaigns-ops-api';

/** The destructive action waiting on the confirm dialog. */
type Pending = { readonly kind: 'stop-all' } | { readonly kind: 'cancel'; readonly row: OpsCampaign };

/** Segments of the status filter; values are what the server's `?status=` accepts. */
const FILTERS: readonly { readonly value: CampaignFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'paused', label: 'Paused' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

/**
 * Every bulk campaign on the platform, for the super admin.
 *
 * The kill-switch card sits on top because it is the emergency control: one
 * click stops every running send. It only *reads* the policy kill switch —
 * leaving it on permanently is a policy decision, made in policy settings, so
 * this panel never writes policy. Pause and resume are reversible and go
 * straight through; cancel and stop-all cannot be undone, so they confirm.
 */
@Component({
  selector: 'app-campaigns-ops',
  imports: [],
  templateUrl: './campaigns-ops.html',
  styleUrl: './campaigns-ops.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CampaignsOps {
  private readonly api = inject(CampaignsOpsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  protected readonly filters = FILTERS;
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rows = signal<readonly OpsCampaign[]>([]);
  protected readonly killSwitch = signal<boolean | null>(null);
  protected readonly filter = signal<CampaignFilter>('all');
  /** Row id with a request in flight, so its buttons disable and nothing double-fires. */
  protected readonly busy = signal<number | null>(null);
  protected readonly stopping = signal(false);
  /** Result of the last action, shown above the table. */
  protected readonly notice = signal<{ readonly tone: 'ok' | 'bad'; readonly text: string } | null>(null);
  protected readonly pending = signal<Pending | null>(null);

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
      .list(this.filter())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ killSwitch, campaigns }) => {
          this.killSwitch.set(killSwitch);
          this.rows.set(campaigns);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected setFilter(value: CampaignFilter): void {
    if (value === this.filter()) return;
    this.filter.set(value);
    this.rows.set([]);
    this.load();
  }

  protected pause(row: OpsCampaign): void {
    this.act(row, 'pause', `${row.name} paused.`);
  }

  protected resume(row: OpsCampaign): void {
    this.act(row, 'resume', `${row.name} resumed.`);
  }

  protected askCancel(row: OpsCampaign): void {
    this.pending.set({ kind: 'cancel', row });
  }

  protected askStopAll(): void {
    this.pending.set({ kind: 'stop-all' });
  }

  protected confirm(): void {
    const pending = this.pending();
    if (!pending) return;
    this.pending.set(null);
    if (pending.kind === 'cancel') this.act(pending.row, 'cancel', `${pending.row.name} cancelled.`);
    else this.stopAll();
  }

  protected dismiss(): void {
    this.pending.set(null);
  }

  protected canCancel(row: OpsCampaign): boolean {
    return row.status === 'running' || row.status === 'paused' || row.status === 'scheduled' || row.status === 'draft';
  }

  protected statusTone(status: OpsCampaign['status']): string {
    if (status === 'running') return 'tone-ok';
    if (status === 'paused') return 'tone-warn';
    if (status === 'scheduled') return 'tone-info';
    return 'tone-mute';
  }

  /** Under 10% is normal noise on a bulk send; above 25% usually means a bad list or a ban risk. */
  protected rateTone(rate: number): string {
    if (rate > 25) return 'tone-bad';
    if (rate >= 10) return 'tone-warn';
    return 'tone-mute';
  }

  protected when(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  private act(row: OpsCampaign, action: 'pause' | 'resume' | 'cancel', done: string): void {
    this.busy.set(row.id);
    this.notice.set(null);
    this.api
      .act(row.id, action)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ campaign }) => {
          this.busy.set(null);
          this.notice.set({ tone: 'ok', text: done });
          // Patch in place so the row stays put under a filter it may no longer match.
          this.rows.update((rows) =>
            rows.map((r) =>
              r.id === campaign.id
                ? { ...r, status: campaign.status, statusReason: campaign.options?.statusReason ?? null }
                : r,
            ),
          );
        },
        error: (err: Error) => {
          this.busy.set(null);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }

  private stopAll(): void {
    this.stopping.set(true);
    this.notice.set(null);
    this.api
      .stopAll()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ cancelled, dropped, killSwitch }) => {
          this.stopping.set(false);
          this.killSwitch.set(killSwitch);
          this.notice.set({
            tone: 'ok',
            text: `Stopped ${cancelled} campaign${cancelled === 1 ? '' : 's'}, dropped ${dropped} queued message${dropped === 1 ? '' : 's'}.`,
          });
          this.load();
        },
        error: (err: Error) => {
          this.stopping.set(false);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }
}
