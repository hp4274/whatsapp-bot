/**
 * Shared application state as signals, fed by the server's event stream.
 *
 * The server is the source of truth: the UI never invents a status.  Events
 * arrive over SSE (connection changes, campaign stats, QR codes) and land in
 * signals the components read directly.
 */

import { DestroyRef, Injectable, NgZone, computed, inject, signal } from '@angular/core';

import { Api, CampaignStats, ConnectionState, MessageStatus, SafetyStatus } from './api';
import { Auth } from './auth';

/** `auto` follows the operating system. */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** One message from the SSE stream; `type` selects the handler, the rest is payload. */
export interface ServerEvent {
  type: string;
  [key: string]: unknown;
}

/** What the dashboard shows before the first stats arrive. */
const EMPTY_STATS: CampaignStats = {
  total: 0,
  successful: 0,
  failed: 0,
  processed: 0,
  pending: 0,
  duplicates: 0,
  state: 'RUNNING',
};

/** Live app state; see the file header for how events reach it. */
@Injectable({ providedIn: 'root' })
export class Store {
  private readonly api = inject(Api);
  private readonly zone = inject(NgZone);
  private readonly auth = inject(Auth);

  /** Mirror of the active number's transport state. */
  readonly connection = signal<ConnectionState>({
    connected: false,
    transport: 'cloud_api',
    name: null,
    account: '',
    detail: '',
    realDelivery: false,
    supportsReceipts: false,
    qr: null,
  });
  readonly stats = signal<CampaignStats>(EMPTY_STATS);
  readonly qr = signal<string | null>(null);
  readonly safety = signal<SafetyStatus | null>(null);
  /** Set while the engine is deliberately waiting between messages. */
  readonly pacing = signal<{ seconds: number; resting: boolean } | null>(null);
  readonly statusLine = signal('Ready.');
  readonly statusTone = signal<'muted' | 'primary' | 'warning' | 'danger'>('muted');
  readonly connecting = signal(false);
  readonly streamOnline = signal(false);
  /** Bumped whenever the server says the history table changed. */
  readonly historyRevision = signal(0);
  readonly theme = signal<ThemeMode>(readStoredTheme());
  /** Which WhatsApp number the UI is working on; owned by Auth, mirrored here. */
  readonly channelId = this.auth.channelId;

  /** 0 to 1 share of the current campaign already processed. */
  readonly progress = computed(() => {
    const { total, processed } = this.stats();
    return total > 0 ? Math.min(1, processed / total) : 0;
  });

  private readonly listeners = new Set<(topic: string) => void>();
  private source: EventSource | null = null;

  constructor() {
    this.applyTheme(this.theme());
  }

  /**
   * Open the stream for the signed-in user.  Nothing talks to the API before
   * this: an anonymous visitor would only get 401s, and a super admin has no
   * tenant to stream until they pick one.
   */
  start() {
    if (this.source) return;
    this.api.connection().subscribe({
      next: (state) => {
        this.connection.set(state);
        if (state.qr) this.qr.set(state.qr);
      },
      error: () => this.setStatus('Backend not reachable', 'danger'),
    });
    // A send keeps running on the server after a tab closes, so ask where it got to.
    this.api.stats().subscribe({
      next: ({ stats }) => {
        this.stats.set(stats);
        if (stats.safety) this.safety.set(stats.safety);
      },
      error: () => undefined,
    });
    this.listen();
  }

  /** Switch the number every later request acts on, and re-open the stream. */
  useChannel(channelId: number | null) {
    if (this.channelId() === channelId) return;
    this.auth.useChannel(channelId);
    const live = Boolean(this.source);
    this.stop();
    if (live) this.start();
  }

  /** Close the stream on sign-out, or when switching tenant. */
  stop() {
    this.source?.close();
    this.source = null;
    this.streamOnline.set(false);
    this.setStatus('Ready.');
  }

  /** The one-line status shown in the shell; tone picks its colour. */
  setStatus(text: string, tone: 'muted' | 'primary' | 'warning' | 'danger' = 'muted') {
    this.statusLine.set(text);
    this.statusTone.set(tone);
  }

  /** Persist the choice and apply it to the document right away. */
  setTheme(mode: ThemeMode) {
    this.theme.set(mode);
    localStorage.setItem('wsender.theme', mode);
    this.applyTheme(mode);
  }

  private applyTheme(mode: ThemeMode) {
    const dark =
      mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
  }

  /** Subscribe to the server's event stream, reconnecting if it drops. */
  private listen() {
    const params = new URLSearchParams({ token: this.auth.token() ?? '' });
    const tenantId = this.auth.isSuperAdmin() ? this.auth.actingTenantId() : null;
    if (tenantId !== null) params.set('tenant', String(tenantId));
    const channelId = this.channelId();
    if (channelId !== null) params.set('channel', String(channelId));
    // ponytail: the token rides in the URL because EventSource takes no headers.
    // Swap for a short-lived stream ticket if these URLs ever reach a log.
    const source = new EventSource(`/api/events?${params}`);
    this.source = source;

    source.addEventListener('hello', (event) => {
      this.zone.run(() => {
        this.streamOnline.set(true);
        const state = JSON.parse((event as MessageEvent).data) as ConnectionState;
        this.connection.set(state);
        // A reload must not claim "Ready." while a session is already live.
        if (state.connected) this.setStatus(`Connected - ${state.name}`, 'primary');
        if (state.qr) this.qr.set(state.qr);
      });
    });

    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as ServerEvent;
      this.zone.run(() => this.handle(payload));
    };

    source.onerror = () => {
      this.zone.run(() => this.streamOnline.set(false));
      // EventSource retries on its own; this only reports it.
    };
  }

  /**
   * Live data: call from a component constructor with the topics it shows and a
   * reload function. Fires (debounced) whenever the server reports a matching
   * change - a write by anyone on this number, an inbound WhatsApp message, a
   * send status, or a background job. Topics are the API's first path segment
   * ('contacts', 'tickets', 'school', 'objects', ...), plus 'inbox' and 'history'.
   */
  watch(topics: string[], reload: () => void, delayMs = 400): void {
    const wanted = new Set(topics);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const listener = (topic: string) => {
      if (!wanted.has(topic) && !wanted.has('*')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        reload();
      }, delayMs);
    };
    this.listeners.add(listener);
    inject(DestroyRef).onDestroy(() => {
      this.listeners.delete(listener);
      if (timer) clearTimeout(timer);
    });
  }

  /** Fan a topic out to every `watch` listener. */
  private notify(...topics: string[]) {
    for (const topic of topics) for (const fn of this.listeners) fn(topic);
  }

  /** Route one event: first to page reloaders, then to the signals. */
  private handle(event: ServerEvent) {
    switch (event.type) {
      case 'changed':
        this.notify(String(event['topic'] ?? ''));
        break;
      case 'inbound_message':
        this.notify('inbox', 'conversations', 'tickets', 'school', 'contacts');
        break;
      case 'object':
        this.notify('objects', 'school');
        break;
      case 'status':
      case 'stats':
      case 'receipt':
        this.notify('history', 'campaign', 'analytics');
        break;
      default:
        break;
    }
    this.handleEvent(event);
  }

  /** Fold an event into the signals the UI reads. */
  private handleEvent(event: ServerEvent) {
    switch (event.type) {
      case 'stats': {
        const stats = event['stats'] as CampaignStats;
        this.stats.set(stats);
        if (stats.safety) this.safety.set(stats.safety);
        if (!stats.safety?.waitingSeconds) this.pacing.set(null);
        break;
      }
      case 'pacing':
        this.pacing.set({
          seconds: Number(event['seconds']),
          resting: Boolean(event['resting']),
        });
        break;
      case 'quotaReached':
        this.safety.update((current) =>
          current ? { ...current, ...(event as unknown as SafetyStatus) } : current,
        );
        this.setStatus(String(event['message']), 'warning');
        break;
      case 'connection': {
        const connected = Boolean(event['connected']);
        this.connection.update((current) => ({
          ...current,
          ...(event as Partial<ConnectionState>),
        }));
        if (connected) {
          this.connecting.set(false);
          this.qr.set(null);
          this.setStatus(`Connected - ${event['name'] ?? 'transport'}`, 'primary');
        } else if (event['error']) {
          this.connecting.set(false);
          this.setStatus(`Connection failed: ${event['error']}`, 'danger');
        } else if (event['qr']) {
          this.qr.set(event['qr'] as string);
          this.setStatus('Scan the QR code to link WhatsApp.', 'primary');
        } else {
          this.connecting.set(false);
          this.setStatus('Disconnected.');
        }
        break;
      }
      case 'connectionLost':
        this.connection.update((current) => ({ ...current, connected: false }));
        this.setStatus(`Connection lost: ${event['error']}`, 'danger');
        break;
      case 'qr':
        this.qr.set((event['image'] as string) ?? null);
        this.setStatus('Scan the QR code to link WhatsApp.', 'primary');
        break;
      case 'transportState':
        if (event['detail']) this.setStatus(String(event['detail']), 'primary');
        break;
      case 'status': {
        const status = event['status'] as MessageStatus;
        if (status === 'FAILED' && event['error']) {
          this.setStatus(
            `FAILED ${String(event['messageId']).slice(0, 8)}: ${event['error']}`,
            'danger',
          );
        }
        this.historyRevision.update((n) => n + 1);
        break;
      }
      case 'message':
      case 'receipt':
      case 'historyDirty':
        this.historyRevision.update((n) => n + 1);
        break;
      default:
        break;
    }
  }

  /** Close the stream without resetting the status line. */
  dispose() {
    this.source?.close();
    this.source = null;
  }
}

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem('wsender.theme');
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}
