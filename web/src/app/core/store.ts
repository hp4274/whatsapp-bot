/**
 * Shared application state as signals, fed by the server's event stream.
 *
 * The server is the source of truth: the UI never invents a status.  Events
 * arrive over SSE (connection changes, campaign stats, QR codes) and land in
 * signals the components read directly.
 */

import { DestroyRef, Injectable, NgZone, computed, effect, inject, signal, untracked } from '@angular/core';

import { Api, CampaignStats, ConnectionState, MessageStatus, SafetyStatus } from './api';
import { Auth } from './auth';

/** `auto` follows the operating system. */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** Where the wave starts: the pointer, or the button's centre for a keyboard "click". */
function clickPoint(event: Event): { x: number; y: number } {
  const { clientX, clientY } = event as MouseEvent;
  if (clientX || clientY) return { x: clientX, y: clientY };
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
}

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

/** The connection card before the server has said anything. */
const EMPTY_CONNECTION: ConnectionState = {
  connected: false,
  transport: 'baileys',
  name: null,
  account: '',
  detail: '',
  realDelivery: false,
  supportsReceipts: false,
  qr: null,
};

/** Live app state; see the file header for how events reach it. */
@Injectable({ providedIn: 'root' })
export class Store {
  private readonly api = inject(Api);
  private readonly zone = inject(NgZone);
  private readonly auth = inject(Auth);

  /** Mirror of the active number's transport state. */
  readonly connection = signal<ConnectionState>(EMPTY_CONNECTION);
  /**
   * The active number is QR-linked (server QR_TRANSPORTS): it runs on sending levels, and buttons
   * go out as a numbered text menu.
   */
  readonly qrNumber = computed(() => this.connection().transport === 'baileys');
  readonly stats = signal<CampaignStats>(EMPTY_STATS);
  readonly qr = signal<string | null>(null);
  readonly safety = signal<SafetyStatus | null>(null);
  /**
   * Set while the engine is deliberately waiting between messages. `until` is when the wait ends
   * on this browser's clock: the server says "wait 12s" once, the countdown is ours.
   */
  readonly pacing = signal<{ seconds: number; resting: boolean; until: number } | null>(null);
  /** Wall clock, ticking every second while the stream is open: countdowns read it instead of timers of their own. */
  readonly now = signal(Date.now());
  private readonly quietUntil = signal(0);
  /** Server clock minus this browser's (ms), measured when safety last arrived; 0 until then. */
  private readonly clockSkew = signal(0);
  readonly statusLine = signal('Ready.');
  readonly statusTone = signal<'muted' | 'primary' | 'warning' | 'danger'>('muted');
  readonly connecting = signal(false);
  readonly streamOnline = signal(false);
  /** Bumped whenever the server says the history table changed. */
  readonly historyRevision = signal(0);
  readonly theme = signal<ThemeMode>(readStoredTheme());
  /** Which WhatsApp number the UI is working on; owned by Auth, mirrored here. */
  readonly channelId = this.auth.channelId;

  /** Whole seconds left of the current wait between messages; 0 once it is over. */
  readonly pacingLeft = computed(() => {
    const wait = this.pacing();
    return wait ? Math.max(0, Math.ceil((wait.until - this.now()) / 1000)) : 0;
  });

  /** Seconds left of the open quiet window; 0 outside it. */
  readonly quietLeft = computed(() => Math.max(0, Math.ceil((this.quietUntil() - this.now()) / 1000)));

  /**
   * `now` in the server's frame (ms epoch). The quiet windows are the server's instants, so the
   * "now" pin is measured against its clock: a browser clock that runs fast or slow cannot put the
   * pin in a window it is not in.
   */
  readonly serverNow = computed(() => this.now() + this.clockSkew());

  /** 0 to 1 share of the current campaign already processed. */
  readonly progress = computed(() => {
    const { total, processed } = this.stats();
    return total > 0 ? Math.min(1, processed / total) : 0;
  });

  private readonly listeners = new Set<(topic: string) => void>();
  private source: EventSource | null = null;
  private clock: ReturnType<typeof setInterval> | null = null;
  private newDay: ReturnType<typeof setTimeout> | null = null;
  private reopen: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.applyTheme(this.theme());
    // "Auto" follows the OS live: without this a day/night switch needs a reload.
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (this.theme() === 'auto') this.applyTheme('auto');
    });
    // A 401 clears the token without going through sign-out: close the stream it was using.
    effect(() => {
      if (!this.auth.token()) untracked(() => this.stop());
    });
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
    this.refreshStats();
    this.listen();
    this.clock ??= setInterval(() => this.now.set(Date.now()), 1000);
  }

  /** A send keeps running on the server after a tab closes, so ask where it got to. */
  refreshStats() {
    this.api.stats().subscribe({
      next: ({ stats }) => this.takeStats(stats),
      error: () => undefined,
    });
  }

  /** Switch the number every later request acts on, and re-open the stream. */
  useChannel(channelId: number | null) {
    if (this.channelId() === channelId) return;
    this.auth.useChannel(channelId);
    const live = Boolean(this.source);
    this.stop();
    if (live) this.start();
  }

  /**
   * Close the stream on sign-out, or when switching tenant or number. The live state goes with
   * it: the next session must not paint the last one's QR, stats or connection while it loads
   * (`start()` fetches them again).
   */
  stop() {
    this.dispose();
    this.streamOnline.set(false);
    this.qr.set(null);
    this.connecting.set(false);
    this.stats.set(EMPTY_STATS);
    this.safety.set(null);
    this.pacing.set(null);
    this.quietUntil.set(0);
    this.clockSkew.set(0);
    this.connection.set(EMPTY_CONNECTION);
    this.setStatus('Ready.');
  }

  /** The one-line status shown in the shell; tone picks its colour. */
  setStatus(text: string, tone: 'muted' | 'primary' | 'warning' | 'danger' = 'muted') {
    this.statusLine.set(text);
    this.statusTone.set(tone);
  }

  /** Persist the choice and apply it to the document right away. */
  setTheme(mode: ThemeMode, from?: Event) {
    this.theme.set(mode);
    localStorage.setItem('wsender.theme', mode);
    this.applyTheme(mode, from);
  }

  private applyTheme(mode: ThemeMode, from?: Event) {
    const dark =
      mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    const root = document.documentElement;
    const next = dark ? 'dark' : 'light';
    if (root.dataset['theme'] === next) return;
    const set = () => (root.dataset['theme'] = next);
    // Only a click gets the wave; boot, OS changes and reduced-motion users switch at once.
    if (!from || !document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      set();
      return;
    }
    const { x, y } = clickPoint(from);
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(set).ready.then(() =>
      root.animate(
        { clipPath: [`circle(0 at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 700, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', pseudoElement: '::view-transition-new(root)' },
      ),
    );
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
      // A dropped connection is retried by the browser. A non-200 answer (a 502 from the proxy
      // while the API restarts, a 401) is not: the source is CLOSED for good and every later
      // receipt, stat and status would be missed until a page reload, so reopen it ourselves.
      // Without a token (the 401 interceptor signed us out) a reopen would only fail again.
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      if (!this.auth.token()) return;
      this.reopen ??= setTimeout(() => {
        this.reopen = null;
        this.listen();
      }, 3000);
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
      case 'stats':
        this.takeStats(event['stats'] as CampaignStats);
        break;
      case 'pacing': {
        const seconds = Number(event['seconds']);
        this.pacing.set({
          seconds,
          resting: Boolean(event['resting']),
          until: Date.now() + seconds * 1000,
        });
        break;
      }
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
        } else if (event['code'] === 'WHATSAPP_BANNED' || event['paused']) {
          // A ban or pause is not a plain disconnect: say why instead.
          this.connecting.set(false);
          this.qr.set(null);
          const paused = event['paused'] as ConnectionState['paused'];
          this.setStatus(String(paused?.reason ?? event['error'] ?? 'WhatsApp banned this number.'), 'danger');
        } else if (event['error']) {
          this.connecting.set(false);
          // The last code ran out: leaving it on screen would invite a scan that can no longer work.
          if (event['code'] === 'QR_EXPIRED') this.qr.set(null);
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
        // Each code carries its own expiry; a fresh code also ends an earlier "QR expired".
        this.connection.update((current) => ({
          ...current,
          qrExpiresAt: (event['expiresAt'] as string | null) ?? null,
          code: current.code === 'QR_EXPIRED' ? null : current.code,
          error: current.code === 'QR_EXPIRED' ? null : current.error,
        }));
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
    clearTimeout(this.reopen ?? undefined);
    this.reopen = null;
    clearInterval(this.clock ?? undefined);
    this.clock = null;
    clearTimeout(this.newDay ?? undefined);
    this.newDay = null;
  }

  /** Fold engine stats in, and turn the seconds the server reports into deadlines the countdowns can run down. */
  private takeStats(stats: CampaignStats) {
    this.stats.set(stats);
    if (stats.safety) {
      this.safety.set(stats.safety);
      const { quiet } = stats.safety;
      this.quietUntil.set(quiet?.active ? Date.now() + quiet.leftSeconds * 1000 : 0);
      // Includes the request's latency, a fraction of a second: fine for a pin on a 24h bar.
      this.clockSkew.set(quiet ? quiet.nowAt - Date.now() : 0);
      // Tomorrow has different windows: ask again once midnight (channel time) has passed.
      clearTimeout(this.newDay ?? undefined);
      const untilMidnight = quiet ? ((1440 - quiet.nowMinute) * 60 + 2) * 1000 : NaN;
      this.newDay = Number.isFinite(untilMidnight)
        ? setTimeout(() => this.refreshStats(), untilMidnight)
        : null;
    }
    const wait = stats.safety?.waitingSeconds ?? 0;
    // A page opened mid-wait never saw the `pacing` event: build the wait from the stats.
    if (!wait) this.pacing.set(null);
    else if (!this.pacing()) {
      this.pacing.set({ seconds: wait, resting: false, until: Date.now() + wait * 1000 });
    }
  }
}

function readStoredTheme(): ThemeMode {
  const stored = localStorage.getItem('wsender.theme');
  return stored === 'light' || stored === 'dark' || stored === 'auto' ? stored : 'auto';
}
