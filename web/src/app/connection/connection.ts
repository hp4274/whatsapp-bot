import { Component, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { Api, AppConfig, SafetyStatus } from '../core/api';
import { Store } from '../core/store';

interface FieldSpec {
  key: keyof AppConfig;
  label: string;
  help: string;
  type?: 'text' | 'number' | 'password';
  cloudOnly?: boolean;
}

const CREDENTIAL_FIELDS: FieldSpec[] = [
  { key: 'phoneNumberId', label: 'Phone Number ID', help: 'From your Meta app', cloudOnly: true },
  { key: 'accessToken', label: 'Access Token', help: 'whatsapp_business_messaging token', type: 'password', cloudOnly: true },
  { key: 'graphVersion', label: 'Graph API version', help: 'Graph API version to call', cloudOnly: true },
  { key: 'templateName', label: 'Template name', help: 'Used outside the 24h window', cloudOnly: true },
  { key: 'templateLanguage', label: 'Template language', help: 'Language code, e.g. en_US', cloudOnly: true },
];

@Component({
  selector: 'app-connection',
  imports: [FormsModule, DatePipe],
  templateUrl: './connection.html',
  styleUrl: './connection.scss',
})
export class ConnectionView {
  private readonly api = inject(Api);
  protected readonly store = inject(Store);

  protected readonly config = signal<AppConfig | null>(null);
  protected readonly warnings = signal<Record<string, string>>({});
  protected readonly errors = signal<string[]>([]);
  protected readonly saving = signal(false);
  protected readonly safety = signal<SafetyStatus | null>(null);

  protected readonly transports = [
    { value: 'cloud_api', label: 'WhatsApp Business Cloud API', hint: 'Real delivery, needs an access token' },
    { value: 'whatsapp_web', label: 'WhatsApp Web / whatsapp-web.js', hint: 'Real delivery, QR login, no token' },
    { value: 'sandbox', label: 'Local sandbox', hint: 'Testing only - NOT delivered' },
  ];

  protected readonly isCloud = computed(() => this.config()?.transport === 'cloud_api');

  /** Progressive disclosure: Cloud API fields only exist for the Cloud API. */
  protected readonly fields = computed(() => [
    ...(this.isCloud() ? CREDENTIAL_FIELDS : []),
  ]);

  protected readonly advisory = computed(() => {
    const config = this.config();
    if (!config) return '';
    if (config.transport === 'sandbox') {
      return 'SANDBOX selected: messages are written to a local file, not delivered.';
    }
    if (config.transport === 'whatsapp_web') {
      return this.warnings()['whatsapp_web'] ?? '';
    }
    return 'Cloud API selected: messages are delivered by Meta.';
  });

  protected readonly transportLabel = computed(() =>
    ({ cloud_api: 'Cloud API', whatsapp_web: 'WhatsApp Web', sandbox: 'Sandbox' })[
      this.config()?.transport ?? 'cloud_api'
    ]);

  constructor() {
    this.api.getConfig().subscribe({
      next: ({ config, warnings }) => {
        this.config.set(config);
        this.warnings.set(warnings);
      },
      error: (err: Error) => this.errors.set([err.message]),
    });
    this.refreshSafety();
    // Only safety is refreshed live: `config` is the editable form and must not be clobbered.
    this.store.watch(['config', 'connection'], () => this.refreshSafety());
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
