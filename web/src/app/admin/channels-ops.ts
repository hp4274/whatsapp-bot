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

import { transportMeta } from '../channels/channel-meta';
import { type PlanRow, zeroCapLabel } from './ops-api';
import { ChannelsOpsApi, type NumberHealth, type NumberLevel } from './channels-ops-api';
import { ShadowReview } from './shadow-review';

/** Short forms of the tenant's 2 start answers (connection/number-questions.ts), by index 0-3. */
const START_AGE: readonly string[] = ['under 1 month', '1–6 months', '6–24 months', '2+ years'];
const START_USAGE: readonly string[] = ['new number', 'light use', 'regular chats', 'busy business'];

/** The row action waiting on a dialog: disconnect needs a confirm, move needs a target, level a pick. */
type Pending = { readonly kind: 'disconnect' | 'move' | 'level' | 'history' | 'brakes'; readonly row: NumberHealth };

/** How long the brakes-off dialog offers, in hours (the server takes 1-720). */
const BRAKES_OFF_CHOICES: readonly { readonly hours: number; readonly label: string }[] = [
  { hours: 1, label: '1 hour' },
  { hours: 6, label: '6 hours' },
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
  { hours: 720, label: '30 days' },
];

/** Plain names for the brake codes the server writes (CampaignManager.recordBrake). */
const BRAKE_NAMES: Readonly<Record<string, string>> = {
  delivery: 'Low delivery',
  stuck: 'Stuck messages',
  unstable: 'Unstable connection',
};

/** Plain names for level-change reasons (db.levelEvents). */
const LEVEL_REASONS: Readonly<Record<string, string>> = {
  promote: 'Promoted',
  demote_delivery: 'Demoted: low delivery',
  demote_stuck: 'Demoted: stuck messages',
  demote_replies: 'Demoted: few replies',
  hold_health: 'Held: health gate',
  hold_probation: 'Held: probation',
  idle: 'Idle decay',
  history: 'Followed history down',
};

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
  imports: [ShadowReview],
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
  /** Level picked in the level dialog. */
  protected readonly pickedLevel = signal<number | null>(null);
  /** Levels the dialog offers: 0 up to the top level of the number being pinned. */
  protected readonly levelChoices = computed(() => {
    const lv = this.pending()?.row.level;
    return lv ? Array.from({ length: lv.of + 1 }, (_, i) => i) : [];
  });
  /** A pin above what the number earned skips its gradual start, which is how numbers get banned. */
  protected readonly aboveEarned = computed(() => {
    const lv = this.pending()?.row.level;
    const picked = this.pickedLevel();
    return !!lv && picked != null && picked > lv.earned;
  });
  /** Nothing picked yet, or the pin it already has: confirming would change nothing. */
  protected readonly levelUnchanged = computed(() => {
    const picked = this.pickedLevel();
    return picked == null || picked === this.pending()?.row.level?.pinned;
  });

  protected readonly brakesChoices = BRAKES_OFF_CHOICES;
  /** Hours picked in the brakes dialog. No default: turning safety off is never a reflex. */
  protected readonly pickedHours = signal<number | null>(null);

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

  protected askLevel(row: NumberHealth): void {
    // No default pick: confirming the earned level by reflex would freeze the number there.
    this.pickedLevel.set(row.level?.pinned ?? null);
    this.pending.set({ kind: 'level', row });
  }

  protected askBrakes(row: NumberHealth): void {
    this.pickedHours.set(null);
    this.pending.set({ kind: 'brakes', row });
  }

  protected pickHours(value: string): void {
    this.pickedHours.set(value === '' ? null : Number(value));
  }

  /** `null` turns the brakes back on. */
  protected setBrakes(row: NumberHealth, hours: number | null): void {
    this.pending.set(null);
    this.busy.set(row.id);
    this.notice.set(null);
    this.api
      .setBrakesOff(row.id, hours)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.busy.set(null);
          this.notice.set({
            tone: 'ok',
            text: r.brakesOff
              ? `${this.label(row)}: brakes off until ${this.when(r.brakesOff.until)}.`
              : `${this.label(row)}: brakes back on.`,
          });
          this.load();
        },
        error: (err: Error) => {
          this.busy.set(null);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }

  protected askHistory(row: NumberHealth): void {
    this.pending.set({ kind: 'history', row });
  }

  /** Enforced brakes still holding the number right now. */
  protected activeBrakes(row: NumberHealth) {
    const now = Date.now();
    return (row.brakeHealth?.events ?? []).filter(
      (e) => e.kind === 'brake' && e.until && Date.parse(e.until) > now,
    );
  }

  protected shadowTriggers(row: NumberHealth) {
    return (row.brakeHealth?.events ?? []).filter((e) => e.kind === 'shadow');
  }

  protected brakeName(code: string): string {
    return BRAKE_NAMES[code] ?? code;
  }

  protected reasonName(reason: string): string {
    return LEVEL_REASONS[reason] ?? reason;
  }

  /** "26 Oct, 14:05" for history rows. */
  protected when(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  protected pickLevel(value: string): void {
    this.pickedLevel.set(value === '' ? null : Number(value));
  }

  /** `null` clears the pin. The server's answer says what the number now runs at. */
  protected setLevel(row: NumberHealth, level: number | null): void {
    this.pending.set(null);
    this.busy.set(row.id);
    this.notice.set(null);
    this.api
      .pinLevel(row.id, level)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.busy.set(null);
          const capped = r.cap != null && r.effective < (r.pinned ?? r.earned) ? ` Capped at L${r.cap} for this business.` : '';
          this.notice.set({
            tone: 'ok',
            text:
              level === null
                ? `${this.label(row)} pin cleared; back to its earned L${r.earned}.${capped}`
                : `${this.label(row)} pinned to L${level} (earned L${r.earned}), now running at L${r.effective}.${capped}`,
          });
          this.load();
        },
        error: (err: Error) => {
          this.busy.set(null);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }

  /** Lets bulk start now instead of after the new-link wait; the server says if a ban rest still holds it. */
  protected endLinkWait(row: NumberHealth): void {
    this.pending.set(null);
    this.busy.set(row.id);
    this.notice.set(null);
    this.api
      .endLinkWait(row.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.busy.set(null);
          this.notice.set({
            tone: 'ok',
            text: r.resting
              ? `${this.label(row)}: link wait ended, but it is still resting after a WhatsApp ban.`
              : `${this.label(row)}: link wait ended; bulk can start now at L${r.level}.`,
          });
          this.load();
        },
        error: (err: Error) => {
          this.busy.set(null);
          this.notice.set({ tone: 'bad', text: err.message });
        },
      });
  }

  protected confirm(): void {
    const pending = this.pending();
    if (!pending) return;
    const { row } = pending;
    if (pending.kind === 'history') {
      this.pending.set(null);
      return;
    }
    if (pending.kind === 'level') {
      const level = this.pickedLevel();
      if (level != null) this.setLevel(row, level);
      return;
    }
    if (pending.kind === 'brakes') {
      const hours = this.pickedHours();
      if (hours != null) this.setBrakes(row, hours);
      return;
    }
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

  protected providerLabel(provider: string): string {
    return transportMeta(provider).short;
  }

  /** "Started at L4 — 1–6 months, regular chats": how the number's first level was chosen. */
  protected startText(lv: NumberLevel): string {
    if (!lv.asked) return 'Questions not answered';
    const start = lv.start;
    if (!start) return 'No start recorded';
    const a = start.answers;
    if (!a || 'legacy' in a) return 'Linked before the questions';
    if ('skipped' in a) return 'Skipped the questions';
    const age = START_AGE[a.age] ?? '?';
    const usage = START_USAGE[a.usage] ?? '?';
    return `Started at L${start.level} — ${age}, ${usage}`;
  }

  protected readonly zeroCap = zeroCapLabel;

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
