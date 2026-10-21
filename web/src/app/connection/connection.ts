import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';

import { Api, AppConfig, SafetyStatus } from '../core/api';
import { Store } from '../core/store';
import { SafetyControls } from './safety-controls';
import { SendingHealth } from './sending-health';
import { WarmupSetup } from './warmup-setup';

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
  imports: [DatePipe, SafetyControls, SendingHealth, WarmupSetup],
  templateUrl: './connection.html',
  styleUrl: './connection.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectionView {
  private readonly api = inject(Api);
  protected readonly store = inject(Store);

  protected readonly config = signal<AppConfig | null>(null);
  protected readonly warnings = signal<Record<string, string>>({});
  protected readonly errors = signal<string[]>([]);
  protected readonly safety = signal<SafetyStatus | null>(null);
  /** The business is running its own anti-ban limits (see SafetyControls). */
  protected readonly customSafety = signal(false);

  protected readonly steps = STEPS;
  /** The warm-up dialog reopened from the connected card, after the first answer. */
  protected readonly changingWarmup = signal(false);

  /** Which step is lit: none before Connect, 1 while connecting, 2 with the code up, all done once linked. */
  protected readonly stepIndex = computed(() =>
    this.store.connection().connected ? 3 : this.store.qr() ? 1 : this.store.connecting() ? 0 : -1,
  );

  /** WhatsApp's terms note for QR-linked numbers, from the server. */
  protected readonly warning = computed(() => this.warnings()['baileys'] ?? '');

  /** Pill tone for the header: connecting is in-between, not an error. */
  protected readonly statusTone = computed(() =>
    this.store.connecting()
      ? 'tone-warn'
      : this.store.connection().connected
        ? 'tone-ok'
        : 'tone-mute',
  );

  constructor() {
    this.loadConfig();
    this.refreshSafety();
    // Only safety is refreshed live: `config` is the editable form and must not be clobbered.
    // store.watch unregisters itself through the caller's DestroyRef.
    this.store.watch(['config', 'connection'], () => this.refreshSafety());
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

  protected refreshSafety(): void {
    this.api.safety().subscribe({
      next: ({ safety }) => this.safety.set(safety),
      error: () => this.safety.set(null),
    });
  }

  protected warmupAnswered(config: AppConfig): void {
    this.config.set(config);
    this.changingWarmup.set(false);
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

  protected disconnect(): void {
    this.api.disconnect().subscribe({
      next: (state) => {
        this.store.connection.set(state);
        this.store.qr.set(null);
        this.store.setStatus('Disconnected.');
      },
      error: (err: Error) => this.errors.set([err.message]),
    });
  }

}
