import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { Api, AppConfig, SafetyStatus } from '../core/api';
import { Store } from '../core/store';
import { SafetyControls } from './safety-controls';

interface FieldSpec {
  readonly key: keyof AppConfig;
  readonly label: string;
  readonly help: string;
  readonly type?: 'text' | 'number' | 'password';
  readonly cloudOnly?: boolean;
}

/** Meta Cloud API credentials; the QR transport needs none of these. */
const CREDENTIAL_FIELDS: readonly FieldSpec[] = [
  { key: 'phoneNumberId', label: 'Phone Number ID', help: 'From your Meta app', cloudOnly: true },
  {
    key: 'accessToken',
    label: 'Access Token',
    help: 'whatsapp_business_messaging token',
    type: 'password',
    cloudOnly: true,
  },
  {
    key: 'graphVersion',
    label: 'Graph API version',
    help: 'Graph API version to call',
    cloudOnly: true,
  },
  {
    key: 'templateName',
    label: 'Template name',
    help: 'Used outside the 24h window',
    cloudOnly: true,
  },
  {
    key: 'templateLanguage',
    label: 'Template language',
    help: 'Language code, e.g. en_US',
    cloudOnly: true,
  },
];

/**
 * Where a business links its WhatsApp number and sets how it sends.
 *
 * Live connection state comes from the shared Store (pushed by the server);
 * the config form is loaded once and only ever replaced by an explicit save,
 * so a background update never overwrites what the operator is typing.
 */
@Component({
  selector: 'app-connection',
  imports: [FormsModule, DatePipe, SafetyControls],
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
  protected readonly saving = signal(false);
  protected readonly safety = signal<SafetyStatus | null>(null);
  /** The business is running its own anti-ban limits (see SafetyControls). */
  protected readonly customSafety = signal(false);

  protected readonly transports = [
    {
      value: 'cloud_api',
      label: 'WhatsApp Business Cloud API',
      hint: 'Real delivery, needs an access token',
    },
    {
      value: 'baileys',
      label: 'WhatsApp QR (Baileys)',
      hint: 'Real delivery, QR login, no token, no browser - sends images, PDFs and videos',
    },
  ];

  protected readonly isCloud = computed(() => this.config()?.transport === 'cloud_api');

  /** Progressive disclosure: Cloud API fields only exist for the Cloud API. */
  protected readonly fields = computed(() => [...(this.isCloud() ? CREDENTIAL_FIELDS : [])]);

  protected readonly advisory = computed(() => {
    const config = this.config();
    if (!config) return '';
    if (config.transport === 'baileys') {
      return this.warnings()[config.transport] ?? '';
    }
    return 'Cloud API selected: messages are delivered by Meta.';
  });

  protected readonly transportLabel = computed(
    () =>
      ({ cloud_api: 'Cloud API', baileys: 'WhatsApp QR (Baileys)' })[
        this.config()?.transport ?? 'cloud_api'
      ],
  );

  /** Pill tone for the header: connecting is in-between, not an error. */
  protected readonly statusTone = computed(() =>
    this.store.connecting()
      ? 'tone-warn'
      : this.store.connection().connected
        ? 'tone-ok'
        : 'tone-bad',
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

  protected update<K extends keyof AppConfig>(key: K, value: AppConfig[K]) {
    this.config.update((current) => (current ? { ...current, [key]: value } : current));
  }

  protected onField(field: FieldSpec, raw: string) {
    const value = field.type === 'number' ? Number(raw) : raw;
    this.update(field.key, value as AppConfig[typeof field.key]);
  }

  protected save(): void {
    const config = this.config();
    if (!config) return;
    this.saving.set(true);
    this.errors.set([]);
    this.api.saveConfig(config).subscribe({
      next: ({ config: saved }) => {
        this.config.set(saved);
        this.saving.set(false);
        this.refreshSafety();
        this.store.setStatus('Settings saved.');
      },
      error: (err: Error) => {
        this.errors.set(err.message.split('\n'));
        this.saving.set(false);
      },
    });
  }

  protected connect(): void {
    const config = this.config();
    if (!config) return;
    this.errors.set([]);
    this.store.connecting.set(true);
    this.store.setStatus('Connecting...', 'primary');
    // Save first: connecting with settings the operator can see but the server
    // has not stored would connect the wrong thing.
    this.api.saveConfig(config).subscribe({
      next: () => {
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

  protected reconnect(): void {
    this.api.disconnect().subscribe({ next: () => this.connect() });
  }
}
