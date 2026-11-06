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
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type Observable, of, switchMap } from 'rxjs';

import { Api, AppConfig, ConnectionState } from '../core/api';
import { Store } from '../core/store';
import { plainError } from '../channels/channel-meta';

/** The three things a person does, in order; the card lights the one they are on. */
const STEPS: readonly { readonly title: string; readonly text: string }[] = [
  { title: 'Click Link WhatsApp', text: 'A QR code appears on the phone picture.' },
  { title: 'Open WhatsApp on your phone', text: 'Settings > Linked devices > Link a device.' },
  { title: 'Scan the code', text: 'Point the camera at the code. Done in a few seconds.' },
];

/**
 * Transports Connect leaves alone. A QR number is already where Connect would put it, and the sandbox is a
 * test number: saving `baileys` over it moved the tenant off the sandbox, and a failed connect left it moved.
 */
const KEEP_TRANSPORT: readonly string[] = ['baileys', 'sandbox'];

/** What the error banner's Try again repeats: the step that failed, never a different one. */
type LinkAction = 'load' | 'connect' | 'resume' | 'cancel' | 'unlink';

/**
 * Linking the selected number: one button, one QR code, done. Also what stops it sending (a ban, the ban
 * guard or our team) and the way back. It always acts on the selected number (the Store's), so the page
 * recreates it when the selection changes.
 *
 * QR (Baileys) is the only way in, so there is no transport to pick and no form to save first. Live state
 * comes from the shared Store (pushed by the server); the stored settings are read only so Connect can tell
 * whether the number must move to QR first.
 */
@Component({
  selector: 'app-link-card',
  imports: [DatePipe],
  templateUrl: './link-card.html',
  styleUrl: './link-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LinkCard {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly store = inject(Store);

  /** Start linking as soon as the settings arrive (the page's "Link with QR code" on another number). */
  readonly autoStart = input(false);

  /** The number went from unlinked to linked while this card was open. */
  readonly linked = output<void>();
  /** A link in progress was called off with Cancel. */
  readonly cancelled = output<void>();
  /** The ban card's "how to ask for a review": the page opens its checklist. */
  readonly recover = output<void>();

  protected readonly config = signal<AppConfig | null>(null);
  protected readonly errors = signal<string[]>([]);
  private readonly lastAction = signal<LinkAction | null>(null);

  protected readonly steps = STEPS;

  /** A phone number reads "+91…"; any other account name (the sandbox's "local sandbox") as it is. */
  protected accountLabel(account: string): string {
    return /^\d+$/.test(account) ? `+${account}` : account;
  }

  /** Which step is lit: none before Connect, 1 while connecting, 2 with the code up, all done once linked. */
  protected readonly stepIndex = computed(() =>
    this.store.connection().connected ? 3 : this.store.qr() ? 1 : this.store.connecting() ? 0 : -1,
  );

  /** Seconds the code on screen still works, ticking off the store clock; null without a code or expiry. */
  protected readonly qrSecondsLeft = computed(() => {
    const at = this.store.qr() ? this.store.connection().qrExpiresAt : null;
    const ends = at ? Date.parse(at) : NaN;
    return Number.isNaN(ends) ? null : Math.max(0, Math.ceil((ends - this.store.now()) / 1000));
  });
  /** Every code went unscanned: the server stopped asking, and Connect starts a fresh round. */
  protected readonly qrExpired = computed(
    () => this.store.connection().code === 'QR_EXPIRED' && !this.store.qr() && !this.store.connecting(),
  );

  /** Why the number cannot send: a WhatsApp ban, or a pause by the ban guard or our team. */
  protected readonly stop = computed<'ban' | 'ban_guard' | 'admin' | null>(() => {
    const c = this.store.connection();
    return c.code === 'WHATSAPP_BANNED' ? 'ban' : (c.paused?.by ?? null);
  });
  /** The reason text to show: the pause's own, else the ban detail. */
  protected readonly stopReason = computed(() => {
    const c = this.store.connection();
    return c.paused?.reason || c.error || c.detail || '';
  });
  /**
   * The ban guard pauses for spam reports or for the failure rate (server policy/channelOps.js);
   * the heading names the one its reason gives, and stays neutral for any other.
   */
  protected readonly guardTitle = computed(() => {
    const reason = this.store.connection().paused?.reason ?? '';
    return /reported/i.test(reason)
      ? 'Sending stopped: too many spam reports'
      : /failed/i.test(reason)
        ? 'Sending stopped: too many failed messages'
        : 'Sending stopped to protect this number';
  });
  /** First click of "Start sending again" arms it; the second sends it. */
  protected readonly resumeConfirm = signal(false);
  protected readonly resuming = signal(false);
  /** Cancel and Unlink both log out; one at a time, so a double click sends one request. */
  protected readonly disconnecting = signal(false);
  /** Anything in flight: the banner's Try again waits for it. */
  protected readonly busy = computed(
    () => this.store.connecting() || this.disconnecting() || this.resuming(),
  );

  constructor() {
    this.loadConfig();
    // A link that was under way (a code up, or connecting) finished: the page asks the 2 questions and may switch
    // back. Not "connected went true": switching numbers empties the state first, so every switch would count.
    let pending = false;
    let wasConnected: boolean | null = null;
    effect(() => {
      const connected = this.store.connection().connected;
      const underWay = !!this.store.qr() || this.store.connecting();
      untracked(() => {
        if (connected && pending) this.linked.emit();
        pending = !connected && underWay;
        // Linked or unlinked since the failure: its Try again would now do something else, so it goes.
        if (wasConnected !== null && connected !== wasConnected) this.clearError();
        wasConnected = connected;
      });
    });
    let started = false;
    effect(() => {
      if (!this.autoStart() || started || !this.config()) return;
      started = true;
      untracked(() => {
        if (!this.store.connection().connected && !this.store.qr() && !this.store.connecting()) this.connect();
      });
    });
  }

  /** Repeat whatever failed last: reloading the settings, connecting, resuming or unlinking. */
  protected retry(): void {
    switch (this.lastAction()) {
      case 'load':
        return this.loadConfig();
      case 'connect':
        return this.connect();
      case 'resume':
        this.resumeConfirm.set(true); // the failed click was already the confirmed one
        return this.resume();
      case 'cancel':
      case 'unlink':
        return this.disconnect(this.lastAction() as 'cancel' | 'unlink');
      default:
        this.clearError();
    }
  }

  private clearError(): void {
    this.errors.set([]);
    this.lastAction.set(null);
  }

  /**
   * Run a request for the number selected now. It ends with this card, and an answer that lands after the
   * selection moved on is dropped: written into the Store, it would paint one number's QR or state onto
   * another's card. Local busy flags are always reset; only the Store writes are skipped.
   */
  private send<T>(call: Observable<T>, next: (value: T, current: boolean) => void, error: (err: Error, current: boolean) => void): void {
    const at = this.store.channelId();
    const current = () => this.store.channelId() === at;
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => next(value, current()),
      error: (err: Error) => error(err, current()),
    });
  }

  private fail(action: LinkAction, err: Error): void {
    this.lastAction.set(action);
    this.errors.set(plainError(err.message).split('\n'));
  }

  protected loadConfig(): void {
    this.errors.set([]);
    this.send(
      this.api.getConfig(),
      ({ config }) => this.config.set(config),
      (err) => this.fail('load', err),
    );
  }

  protected connect(): void {
    const current = this.config();
    // The button says "Getting ready…" until the settings arrive; a failed load offers its own Try again.
    if (!current || this.busy()) return;
    this.errors.set([]);
    this.store.connecting.set(true);
    this.store.setStatus('Connecting...', 'primary');
    // QR is the only way in from here: only a number saved on some other transport moves over, first.
    const move: Observable<unknown> = KEEP_TRANSPORT.includes(String(current.transport))
      ? of(null)
      : this.api.saveConfig({ transport: 'baileys' });
    this.send(
      move.pipe(switchMap(() => this.api.connect())),
      (state, current) => current && this.take(state),
      (err, current) => {
        if (!current) return;
        this.store.connecting.set(false);
        this.fail('connect', err);
        this.store.setStatus(`Connection failed: ${plainError(err.message)}`, 'danger');
      },
    );
  }

  /** Reconnect after a ban-guard pause; the first click only asks for confirmation. */
  protected resume(): void {
    if (!this.resumeConfirm()) {
      this.resumeConfirm.set(true);
      return;
    }
    this.resumeConfirm.set(false);
    this.resuming.set(true);
    this.errors.set([]);
    this.send(
      this.api.resumeConnection(),
      (state, current) => {
        this.resuming.set(false);
        if (current) this.take(state);
      },
      (err, current) => {
        this.resuming.set(false);
        if (current) this.fail('resume', err);
      },
    );
  }

  /** Cancel a link in progress, or unlink a live number: the same logout on the server. */
  protected disconnect(kind: 'cancel' | 'unlink'): void {
    if (this.disconnecting()) return;
    this.disconnecting.set(true);
    this.errors.set([]);
    this.send(
      this.api.disconnect(),
      (state, current) => {
        this.disconnecting.set(false);
        if (!current) return;
        this.store.connection.set(state);
        this.store.connecting.set(false);
        this.store.qr.set(null);
        this.store.setStatus(kind === 'cancel' ? 'Linking cancelled.' : 'Unlinked.');
        if (kind === 'cancel') this.cancelled.emit();
      },
      (err, current) => {
        this.disconnecting.set(false);
        // The kind that failed, not one read from the live state: a Cancel retried after the scan landed
        // must not become an Unlink of the number just linked.
        if (current) this.fail(kind, err);
      },
    );
  }

  private take(state: ConnectionState): void {
    this.store.connection.set(state);
    if (state.qr) {
      this.store.qr.set(state.qr);
      this.store.setStatus('Scan the QR code to link WhatsApp.', 'primary');
    }
    if (state.connected) {
      this.store.connecting.set(false);
      this.store.qr.set(null);
    }
  }
}
