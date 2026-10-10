import { Component, computed, input, output, signal } from '@angular/core';

import { Channel, ChannelPatch } from '../core/api';
import { capabilityMeta } from './channel-meta';
import { SendWindow } from './send-window';

/** The per-number drawer: what it may be used for, when it may send, and lifecycle actions. */
@Component({
  selector: 'app-channel-settings',
  imports: [SendWindow],
  templateUrl: './channel-settings.html',
  styleUrl: './channel-settings.scss',
})
export class ChannelSettings {
  readonly channel = input.required<Channel>();
  readonly capabilities = input<string[]>([]);
  readonly canDelete = input(false);
  readonly busy = input(false);

  readonly patch = output<ChannelPatch>();
  readonly makeDefault = output<void>();
  readonly remove = output<void>();

  protected readonly confirming = signal<'delete' | 'disable' | null>(null);
  protected readonly label = capabilityMeta;

  protected readonly enabledCount = computed(
    () => this.capabilities().filter((c) => this.channel().capabilities.includes(c)).length,
  );

  protected toggle(capability: string) {
    const current = this.channel().capabilities;
    const next = current.includes(capability)
      ? current.filter((c) => c !== capability)
      : [...current, capability];
    this.patch.emit({ capabilities: next });
  }

  protected setAll(on: boolean) {
    this.patch.emit({ capabilities: on ? [...this.capabilities()] : [] });
  }

  protected toggleStatus() {
    const active = this.channel().status === 'active';
    if (active && this.confirming() !== 'disable') {
      this.confirming.set('disable');
      return;
    }
    this.confirming.set(null);
    this.patch.emit({ status: active ? 'disabled' : 'active' });
  }

  protected confirmDelete() {
    this.confirming.set(null);
    this.remove.emit();
  }
}
