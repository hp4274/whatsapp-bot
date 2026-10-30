import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { Api, AppConfig, ChannelsApi } from '../core/api';
import { Store } from '../core/store';
import { NumberQuestions } from './number-questions';
import { SafetyControls } from './safety-controls';
import { SendingHealth } from './sending-health';

/** The three things a person does, in order; the card lights the one they are on. */
const STEPS: readonly { readonly title: string; readonly text: string }[] = [
  { title: 'Click Connect WhatsApp', text: 'A QR code appears on the phone picture.' },
  { title: 'Open WhatsApp on your phone', text: 'Settings > Linked devices > Link a device.' },
  { title: 'Scan the code', text: 'Point the camera at the code. Done in a few seconds.' },
];

/**
 * Where a business links its WhatsApp number: one button, one QR code, done.
 *
 * QR (Baileys) is the only way in from here, so there is no transport to pick
 * and no form to save first. Live state comes from the shared Store (pushed by
 * the server); the stored config is only read so Connect can save it as QR.
 */
@Component({
  selector: 'app-connection',
  imports: [DatePipe, NumberQuestions, SafetyControls, SendingHealth],
  templateUrl: './connection.html',
  styleUrl: './connection.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionView {
  private readonly api = inject(Api);
  private readonly channels = inject(ChannelsApi);
  protected readonly store = inject(Store);

  /** A phone number reads "+91…"; any other account name (the sandbox's "local sandbox") as it is. */
  protected accountLabel(account: string): string {
    return /^d+$/.test(account) ? `+${account}` : account;
  }

  /** The default number, for when no number is picked: requests without one run against it. */
  private readonly defaultChannelId = signal<number | null>(null);
  /** The number this page links, which is the one whose start questions are asked here. */
  protected readonly channelId = computed(() => this.store.channelId() ?? this.defaultChannelId());

  protected readonly config = signal<AppConfig | null>(null);
  protected readonly warnings = signal<Record<string, string>>({});
  protected readonly errors = signal<string[]>([]);
  /** The business is running its own anti-ban limits (see SafetyControls). */
  protected readonly customSafety = signal(false);
  protected readonly safetyOff = signal(false);

  protected readonly steps = STEPS;

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

  /** WhatsApp's terms note for QR-linked numbers, from the server. */
  protected readonly warning = computed(() => this.warnings()['baileys'] ?? '');

  /** Why the number cannot send: a WhatsApp ban, or a pause by the ban guard or the platform admin. */
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
  /** First click of "Reconnect anyway" arms it; the second sends it. */
  protected readonly resumeConfirm = signal(false);
  protected readonly resuming = signal(false);
  protected readonly disconnecting = signal(false);

  /** Pill tone for the header: connecting is in-between, not an error. */
  protected readonly statusTone = computed(() =>
    this.stop() === 'ban'
      ? 'tone-bad'
      : this.stop()
        ? 'tone-warn'
        : this.store.connecting()
          ? 'tone-warn'
          : this.store.connection().connected
            ? 'tone-ok'
            : 'tone-mute',
  );

  constructor() {
    this.loadConfig();
    // Only needed to know which number the questions belong to; without it they just do not show.
    this.channels.list().subscribe({
      next: ({ channels }) =>
        this.defaultChannelId.set((channels.find((c) => c.isDefault) ?? channels[0])?.id ?? null),
      error: () => undefined,
    });
  }

  protected loadConfig(): void {
    this.errors.set([]);
    this.api.getConfig().subscribe({
      next: ({ config, warnings }) => {
        this.config.set(config);
        this.warnings.set(warnings);
      },
      error: (err: Error) => this.errors.set([err.message]),
    });
  }


  protected connect(): void {
    const current = this.config();
    if (!current) return;
    // QR (Baileys) is the only way to connect from here; a number saved on another transport moves over.
    const config: AppConfig = { ...current, transport: 'baileys' };
    this.errors.set([]);
    this.store.connecting.set(true);
    this.store.setStatus('Connecting...', 'primary');
    // Save first: connecting with settings the operator can see but the server
    // has not stored would connect the wrong thing.
    this.api.saveConfig(config).subscribe({
      next: ({ config: saved }) => {
        this.config.set(saved);
        this.api.connect().subscribe({
          next: (state) => {
            this.store.connection.set(state);
            if (state.qr) {
              this.store.qr.set(state.qr);
              this.store.setStatus('Scan the QR code to link WhatsApp.', 'primary');
            }
            if (state.connected) {
              this.store.connecting.set(false);
              this.store.qr.set(null);
            }
          },
          error: (err: Error) => {
            this.errors.set(err.message.split('\n'));
            this.store.connecting.set(false);
            this.store.setStatus(`Connection failed: ${err.message}`, 'danger');
          },
        });
      },
      error: (err: Error) => {
        this.errors.set(err.message.split('\n'));
        this.store.connecting.set(false);
      },
    });
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
    this.api.resumeConnection().subscribe({
      next: (state) => {
        this.resuming.set(false);
        this.store.connection.set(state);
        if (state.qr) {
          this.store.qr.set(state.qr);
          this.store.setStatus('Scan the QR code to link WhatsApp.', 'primary');
        }
        if (state.connected) {
          this.store.connecting.set(false);
          this.store.qr.set(null);
        }
      },
      error: (err: Error) => {
        this.resuming.set(false);
        this.errors.set(err.message.split('\n'));
      },
    });
  }

  protected disconnect(): void {
    this.disconnecting.set(true);
    this.api.disconnect().subscribe({
      next: (state) => {
        this.disconnecting.set(false);
        this.store.connection.set(state);
        this.store.qr.set(null);
        this.store.setStatus('Disconnected.');
      },
      error: (err: Error) => {
        this.disconnecting.set(false);
        this.errors.set([err.message]);
      },
    });
  }

}
