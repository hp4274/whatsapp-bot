import { DestroyRef, Injectable, NgZone, inject } from '@angular/core';

import { Auth } from '../core/auth';

/** One "topic changed" note from GET /api/admin/events; `tenantIds` empty = platform-wide. */
interface AdminChange {
  readonly type: 'changed';
  readonly topic: string;
  readonly tenantIds: readonly number[];
}

/**
 * The super admin's live stream across every tenant.
 *
 * Tenant pages hear their number's own stream through `Store.watch`; admin screens span all tenants, so they listen
 * here instead of polling. The server only says which topic moved (`channels`, `campaigns`, `usage`, `audit`,
 * `tenants`, `policy`, `plans`, …) and the page reloads what it shows. The stream opens with the first watcher and
 * closes with the last, so a tenant user never holds one.
 */
@Injectable({ providedIn: 'root' })
export class AdminFeed {
  private readonly auth = inject(Auth);
  private readonly zone = inject(NgZone);

  private readonly listeners = new Set<(change: AdminChange) => void>();
  private source: EventSource | null = null;
  private reopen: ReturnType<typeof setTimeout> | null = null;

  /**
   * Call from a component's injection context: `reload` runs (debounced) whenever one of `topics` changes, and
   * once more after the stream reconnects, since changes made while it was down were never heard.
   */
  watch(topics: readonly string[], reload: () => void, delayMs = 400): void {
    const wanted = new Set(topics);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listener = (change: AdminChange) => {
      if (change.topic !== '*' && !wanted.has(change.topic)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reload();
      }, delayMs);
    };
    this.listeners.add(listener);
    this.open();
    inject(DestroyRef).onDestroy(() => {
      this.listeners.delete(listener);
      if (timer) clearTimeout(timer);
      if (!this.listeners.size) this.close();
    });
  }

  private open() {
    if (this.source || !this.auth.isSuperAdmin()) return;
    const token = this.auth.token();
    if (!token) return;
    // The token rides in the URL because EventSource takes no headers (as Store's tenant stream does).
    const source = new EventSource(`/api/admin/events?${new URLSearchParams({ token })}`);
    this.source = source;
    let opened = false;
    source.addEventListener('hello', () => {
      // A reconnect: whatever changed while the stream was down was never heard, so every watcher reloads.
      if (opened) this.zone.run(() => this.emit({ type: 'changed', topic: '*', tenantIds: [] }));
      opened = true;
    });
    source.onmessage = (event) => {
      const change = JSON.parse(event.data) as AdminChange;
      this.zone.run(() => this.emit(change));
    };
    source.onerror = () => {
      // A non-200 answer (a 502 while the API restarts) closes the source for good: reopen it ourselves.
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = null;
      if (!this.listeners.size || !this.auth.token()) return;
      this.reopen ??= setTimeout(() => {
        this.reopen = null;
        this.open();
      }, 3000);
    };
  }

  private close() {
    this.source?.close();
    this.source = null;
    clearTimeout(this.reopen ?? undefined);
    this.reopen = null;
  }

  private emit(change: AdminChange) {
    for (const listener of this.listeners) listener(change);
  }
}
