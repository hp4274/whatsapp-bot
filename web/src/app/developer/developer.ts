import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { Store } from '../core/store';

import {
  ApiKey,
  CreatedApiKey,
  CreatedEndpoint,
  DeveloperApi,
  WebhookDelivery,
  WebhookEndpoint,
} from './developer-api';

/**
 * API keys and webhook endpoints for the tenant's own integrations.
 *
 * Secrets (`key`, `secret`) are only present in the create response, so they
 * are held in `newKey` / `newHook` until dismissed and never merged into the
 * lists. Destructive actions confirm inline instead of in a dialog so the row
 * stays in view.
 */
@Component({
  selector: 'app-developer',
  imports: [FormsModule],
  templateUrl: './developer.html',
  styleUrl: './developer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DeveloperView {
  private readonly api = inject(DeveloperApi);
  private readonly store = inject(Store);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly notice = signal('');

  // keys
  protected readonly keys = signal<ApiKey[]>([]);
  protected readonly scopes = signal<string[]>([]);
  protected readonly keyName = signal('');
  protected readonly keyScopes = signal<string[]>([]);
  protected readonly creatingKey = signal(false);
  protected readonly newKey = signal<CreatedApiKey | null>(null);
  protected readonly confirmRevoke = signal<number | null>(null);

  // webhooks
  protected readonly endpoints = signal<WebhookEndpoint[]>([]);
  protected readonly events = signal<string[]>([]);
  protected readonly hookUrl = signal('');
  protected readonly hookEvents = signal<string[]>([]);
  protected readonly creatingHook = signal(false);
  protected readonly newHook = signal<CreatedEndpoint | null>(null);
  protected readonly confirmDelete = signal<number | null>(null);
  protected readonly editing = signal<number | null>(null);
  protected readonly editEvents = signal<string[]>([]);
  protected readonly busy = signal<number | null>(null);
  protected readonly openDeliveries = signal<number | null>(null);
  protected readonly deliveries = signal<WebhookDelivery[]>([]);
  protected readonly deliveriesLoading = signal(false);
  protected readonly deliveriesError = signal('');

  protected readonly copied = signal('');

  private readonly origin = typeof location === 'undefined' ? '' : location.origin;
  protected readonly curl = computed(
    () => `curl -X POST ${this.origin}/api/v1/events \\
  -H "Authorization: Bearer <your-api-key>" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: $(uuidgen)" \\
  -d '{"type": "order.created", "contactPhone": "+919876543210", "data": {"orderId": "A-1001"}}'`,
  );

  /** Route table for the quick-start card: method, path, what it does. */
  protected readonly routes: readonly (readonly [string, string, string])[] = [
    ['GET', '/v1', 'Key info and available resources'],
    ['POST', '/v1/events', 'Trigger workflows (events:write)'],
    ['POST', '/v1/contacts', 'Create or update a contact (contacts:write)'],
    ['GET', '/v1/contacts/:phone', 'Fetch a contact (contacts:read)'],
    ['POST', '/v1/orders', 'Create an order (objects:write); also /appointments, /payments'],
    ['GET', '/v1/orders/:reference', 'Fetch by reference (objects:read)'],
    ['POST', '/v1/tickets', 'Open a ticket (tickets:write)'],
    ['GET', '/v1/tickets/:reference', 'Fetch a ticket (tickets:write)'],
  ];

  constructor() {
    void this.load();
    this.store.watch(['api-keys', 'webhook-endpoints'], () => void this.load(true));
  }

  /** `quiet` skips the loading skeleton, for refreshes driven by the event stream. */
  protected async load(quiet = false) {
    if (!quiet) this.loading.set(true);
    this.error.set('');
    try {
      const [k, e] = await Promise.all([
        firstValueFrom(this.api.keys()),
        firstValueFrom(this.api.endpoints()),
      ]);
      this.keys.set(k.keys);
      this.scopes.set(k.scopes);
      this.endpoints.set(e.endpoints);
      this.events.set(e.events);
    } catch (err) {
      this.error.set(msg(err));
    } finally {
      this.loading.set(false);
    }
  }

  /** Add or remove `value` from a signal-held list (checkbox groups). */
  protected toggle(list: { (): string[]; set(v: string[]): void }, value: string) {
    const cur = list();
    list.set(cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value]);
  }

  // ------------------------------------------------------------- keys --
  protected async createKey() {
    if (this.creatingKey() || !this.keyScopes().length) return;
    this.creatingKey.set(true);
    this.error.set('');
    try {
      const { key } = await firstValueFrom(
        this.api.createKey({ name: this.keyName().trim(), scopes: this.keyScopes() }),
      );
      this.newKey.set(key);
      const { key: secret, ...rest } = key;
      void secret;
      this.keys.update((l) => [rest, ...l]);
      this.keyName.set('');
      this.keyScopes.set([]);
    } catch (err) {
      this.error.set(msg(err));
    } finally {
      this.creatingKey.set(false);
    }
  }

  protected async revoke(k: ApiKey) {
    if (this.confirmRevoke() !== k.id) {
      this.confirmRevoke.set(k.id);
      return;
    }
    this.busy.set(k.id);
    try {
      const { key } = await firstValueFrom(this.api.revokeKey(k.id));
      this.keys.update((l) => l.map((x) => (x.id === k.id ? key : x)));
      this.confirmRevoke.set(null);
    } catch (err) {
      this.error.set(msg(err));
    } finally {
      this.busy.set(null);
    }
  }

  // ---------------------------------------------------------- webhooks --
  protected async createHook() {
    if (this.creatingHook() || !this.hookUrl().trim() || !this.hookEvents().length) return;
    this.creatingHook.set(true);
    this.error.set('');
    try {
      const { endpoint } = await firstValueFrom(
        this.api.createEndpoint({ url: this.hookUrl().trim(), events: this.hookEvents() }),
      );
      this.newHook.set(endpoint);
      const { secret, ...rest } = endpoint;
      this.endpoints.update((l) => [...l, { ...rest, secretHint: `…${secret.slice(-4)}` }]);
      this.hookUrl.set('');
      this.hookEvents.set([]);
    } catch (err) {
      this.error.set(msg(err));
    } finally {
      this.creatingHook.set(false);
    }
  }

  protected startEdit(e: WebhookEndpoint) {
    this.editing.set(e.id);
    this.editEvents.set([...e.events]);
  }

  protected async saveEdit(e: WebhookEndpoint) {
    if (!this.editEvents().length) return;
    await this.mutate(e.id, { events: this.editEvents() }, () => this.editing.set(null));
  }

  protected async toggleActive(e: WebhookEndpoint) {
    await this.mutate(e.id, { isActive: !e.isActive });
  }

  private async mutate(id: number, body: Partial<WebhookEndpoint>, done?: () => void) {
    this.busy.set(id);
    try {
      const { endpoint } = await firstValueFrom(this.api.updateEndpoint(id, body));
      this.endpoints.update((l) => l.map((x) => (x.id === id ? endpoint : x)));
      done?.();
    } catch (err) {
      this.error.set(msg(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected async remove(e: WebhookEndpoint) {
    if (this.confirmDelete() !== e.id) {
      this.confirmDelete.set(e.id);
      return;
    }
    this.busy.set(e.id);
    try {
      await firstValueFrom(this.api.deleteEndpoint(e.id));
      this.endpoints.update((l) => l.filter((x) => x.id !== e.id));
      this.confirmDelete.set(null);
      if (this.openDeliveries() === e.id) this.openDeliveries.set(null);
    } catch (err) {
      this.error.set(msg(err));
    } finally {
      this.busy.set(null);
    }
  }

  protected async toggleDeliveries(e: WebhookEndpoint) {
    if (this.openDeliveries() === e.id) {
      this.openDeliveries.set(null);
      return;
    }
    this.openDeliveries.set(e.id);
    this.deliveries.set([]);
    this.deliveriesError.set('');
    this.deliveriesLoading.set(true);
    try {
      const res = await firstValueFrom(this.api.deliveries(e.id));
      if (this.openDeliveries() === e.id) this.deliveries.set(res.deliveries);
    } catch (err) {
      this.deliveriesError.set(msg(err));
    } finally {
      this.deliveriesLoading.set(false);
    }
  }

  // ------------------------------------------------------------- misc --
  protected async copy(id: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(id);
      setTimeout(() => {
        if (this.copied() === id) this.copied.set('');
      }, 2000);
    } catch {
      this.error.set('Copy failed. Select the text and copy it manually.');
    }
  }

  protected fmt(iso: string | null) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? iso
      : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  }
}

const msg = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong');
