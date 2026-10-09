import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Channel, ChannelsApi } from '../core/api';
import { Store } from '../core/store';

@Component({
  selector: 'app-channels',
  imports: [FormsModule],
  templateUrl: './channels.html',
  styleUrl: './channels.scss',
})
export class ChannelsView {
  private readonly api = inject(ChannelsApi);
  private readonly store = inject(Store);

  protected readonly channels = signal<Channel[]>([]);
  protected readonly capabilities = signal<string[]>([]);
  protected readonly transports = signal<string[]>([]);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly showForm = signal(false);
  protected readonly openId = signal<number | null>(null);

  protected readonly draft = signal({ displayName: '', phoneNumber: '', transport: 'cloud_api', timezone: localZone() });

  constructor() {
    this.refresh();
    this.store.watch(['channels'], () => this.refresh());
  }

  protected refresh() {
    this.api.list().subscribe({
      next: ({ channels, capabilities, transports }) => {
        this.channels.set(channels);
        this.capabilities.set(capabilities);
        this.transports.set(transports);
      },
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected create(event: Event) {
    event.preventDefault();
    const d = this.draft();
    this.busy.set(true);
    this.error.set('');
    this.api
      .create({
        displayName: d.displayName.trim(),
        phoneNumber: d.phoneNumber.trim(),
        timezone: d.timezone,
        settings: { transport: d.transport as Channel['provider'] },
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.showForm.set(false);
          this.draft.set({ displayName: '', phoneNumber: '', transport: 'cloud_api', timezone: localZone() });
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected toggleStatus(channel: Channel) {
    this.patch(channel, { status: channel.status === 'active' ? 'disabled' : 'active' });
  }

  protected toggleCapability(channel: Channel, capability: string) {
    const next = channel.capabilities.includes(capability)
      ? channel.capabilities.filter((c) => c !== capability)
      : [...channel.capabilities, capability];
    this.patch(channel, { capabilities: next });
  }

  protected setWindow(channel: Channel, start: string, end: string) {
    this.patch(channel, { businessHours: start && end ? { start, end } : null });
  }

  protected clearWindow(channel: Channel) {
    this.patch(channel, { businessHours: null });
  }

  protected makeDefault(channel: Channel) {
    this.api.makeDefault(channel.id).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  protected remove(channel: Channel) {
    this.api.remove(channel.id).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(err.message),
    });
  }

  /** Work on this number: later requests carry its id. */
  protected use(channel: Channel) {
    this.store.useChannel(channel.id);
    this.refresh();
  }

  protected readonly activeId = this.store.channelId;

  private patch(channel: Channel, body: Parameters<ChannelsApi['update']>[1]) {
    this.error.set('');
    this.api.update(channel.id, body).subscribe({
      next: () => this.refresh(),
      error: (err: Error) => this.error.set(err.message),
    });
  }
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
