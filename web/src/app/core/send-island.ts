import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';

import { Api, type MessageRecord } from './api';
import { Store } from './store';

/** How long a finished run stays on screen before the card closes itself. */
const AUTO_CLOSE_SECONDS = 10;
/** How many recent messages the card lists. */
const RECENT_COUNT = 5;

/**
 * A small floating card that follows a bulk send around the app, like an upload
 * tray: how far along it is, what has gone out, and pause / resume / stop.
 * The server owns the send, so this only reads `store.stats` and reflects it.
 *
 * Under the counts it lists the last five messages (who, what, status), so the
 * operator sees names going out rather than only a number. Once a run ends the
 * card closes itself after 10 seconds; hovering or focusing it holds it open,
 * so nobody loses it mid-read (WCAG 2.2.1, adjustable timing).
 *
 * Mounted once by the shell rather than by the campaign page, so it survives
 * navigation. The template stays inline: it is the one component file this
 * folder owns, and the card is small.
 */
@Component({
  selector: 'app-send-island',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <aside
        class="island"
        [class.done]="phase() === 'done'"
        [class.bad]="phase() === 'stopped'"
        role="status"
        aria-live="polite"
        aria-label="Bulk message progress"
        (mouseenter)="hold(true)"
        (mouseleave)="hold(false)"
        (focusin)="hold(true)"
        (focusout)="hold(false)"
      >
        <header>
          <i class="ti ti-{{ icon() }} lead" aria-hidden="true"></i>
          <strong>{{ title() }}</strong>
          <button
            type="button"
            class="ic"
            (click)="open.set(!open())"
            [attr.aria-label]="open() ? 'Collapse' : 'Expand'"
            [attr.aria-expanded]="open()"
          >
            <i class="ti ti-{{ open() ? 'chevron-down' : 'chevron-up' }}" aria-hidden="true"></i>
          </button>
          @if (phase() === 'done' || phase() === 'stopped') {
            <button type="button" class="ic" (click)="dismiss()" aria-label="Close">
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
          }
        </header>

        <div
          class="bar"
          role="progressbar"
          aria-valuemin="0"
          aria-valuemax="100"
          [attr.aria-valuenow]="percent()"
        >
          <span [style.width.%]="percent()"></span>
        </div>

        @if (open()) {
          <div class="body">
            <p class="line">
              <span>{{ stats().processed }} of {{ stats().total }} processed</span>
              <b>{{ percent() }}%</b>
            </p>
            <ul class="counts">
              <li class="ok">
                <b>{{ stats().successful }}</b> sent
              </li>
              <li [class.bad]="stats().failed > 0">
                <b>{{ stats().failed }}</b> failed
              </li>
              <li>
                <b>{{ stats().pending }}</b> waiting
              </li>
            </ul>
            @if (recent().length) {
              <ol class="recent" aria-label="Recently sent">
                @for (m of recent(); track m.messageId) {
                  <li>
                    <span class="av" aria-hidden="true">{{ initials(m) }}</span>
                    <span class="who">
                      <b>{{ m.name || m.recipient }}</b>
                      <small>{{ m.message || 'Media' }}</small>
                    </span>
                    <span class="st st-{{ tone(m.status) }}">{{ label(m.status) }}</span>
                  </li>
                }
              </ol>
            }
            @if (note()) {
              <p class="note">{{ note() }}</p>
            }
            @if (closesIn() !== null) {
              <p class="note">Closes in {{ closesIn() }}s · hover to keep it open</p>
            }
            @if (phase() === 'sending' || phase() === 'paused') {
              <div class="actions">
                @if (phase() === 'sending') {
                  <button type="button" class="b" (click)="act('pause')">Pause</button>
                } @else {
                  <button type="button" class="b" (click)="act('resume')">Resume</button>
                }
                <button type="button" class="b danger" (click)="act('stop')">Stop</button>
              </div>
            }
            @if (error()) {
              <p class="err">{{ error() }}</p>
            }
          </div>
        }
      </aside>
    }
  `,
  styles: `
    @keyframes island-in {
      from {
        opacity: 0;
        translate: 0 16px;
        scale: 0.96;
      }
      to {
        opacity: 1;
        translate: none;
        scale: none;
      }
    }

    /* Kardlyz card language, floated: card surface, hairline, 20px radius, a
       soft lifted shadow so it reads as above the page rather than on it. */
    .island {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 50;
      width: min(360px, calc(100vw - 24px));
      padding: 14px 16px 16px;
      border: 1px solid var(--border-color);
      border-radius: 20px;
      color: var(--text-color);
      background: color-mix(in srgb, var(--surface-card) 92%, transparent);
      box-shadow:
        var(--shadow-lift),
        0 2px 6px rgba(16, 16, 24, 0.08);
      backdrop-filter: blur(14px);
      animation: island-in 300ms var(--ease) both;
    }

    header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    header strong {
      flex: 1;
      min-width: 0;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-strong);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .lead {
      display: inline-grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 9px;
      font-size: 16px;
      color: var(--primary-text);
      background: var(--primary-tint);
    }
    .done .lead {
      color: var(--success);
      background: var(--success-soft);
    }
    .bad .lead {
      color: var(--danger-text);
      background: var(--danger-soft);
    }

    .ic {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 9px;
      background: transparent;
      color: var(--text-muted);
      transition:
        background var(--fast) var(--ease),
        color var(--fast) var(--ease);
    }
    .ic:hover {
      background: var(--surface-sunken);
      color: var(--text-strong);
    }
    .ic .ti {
      font-size: 17px;
    }

    .bar {
      height: 6px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--surface-sunken);
    }
    .bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--primary), var(--accent));
      transition: width 400ms var(--ease);
    }
    .bad .bar span {
      background: var(--danger);
    }

    .body {
      display: grid;
      gap: 10px;
      margin-top: 12px;
    }
    .line {
      display: flex;
      justify-content: space-between;
      margin: 0;
      font-size: 13px;
      color: var(--text-muted);
    }
    .line b {
      font-weight: 500;
      color: var(--text-strong);
      font-variant-numeric: tabular-nums;
      letter-spacing: -0.2px;
    }

    .counts {
      display: flex;
      gap: 14px;
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: 13px;
      color: var(--text-muted);
    }
    .counts b {
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      color: var(--text-strong);
    }
    .counts .ok b {
      color: var(--success);
    }
    .counts .bad b {
      color: var(--danger-text);
    }

    /* Last five messages: one compact row each, newest first. */
    .recent {
      display: grid;
      margin: 0;
      padding: 4px 0 0;
      list-style: none;
      border-top: 1px solid var(--border-color);
    }
    .recent li {
      display: grid;
      grid-template-columns: 28px minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      padding: 7px 0;
      animation: island-in 240ms var(--ease) both;
    }
    .recent li + li {
      border-top: 1px solid var(--border-color);
    }
    .av {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-strong);
      background: color-mix(in srgb, var(--accent) 16%, transparent);
    }
    .who {
      display: grid;
      min-width: 0;
      line-height: 1.3;
    }
    .who b,
    .who small {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .who b {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-strong);
    }
    .who small {
      font-size: 12px;
      color: var(--text-muted);
    }
    .st {
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 500;
      color: var(--tone);
      background: color-mix(in srgb, var(--tone) 12%, transparent);
    }
    .st-ok { --tone: var(--success); }
    .st-run { --tone: var(--info); }
    .st-bad { --tone: var(--danger-text); }
    .st-mute { --tone: var(--text-muted); }

    .note,
    .err {
      margin: 0;
      font-size: 12px;
      color: var(--hint);
    }
    .err {
      color: var(--danger-text);
    }

    .actions {
      display: flex;
      gap: 8px;
    }
    .b {
      height: 32px;
      padding: 0 14px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      background: var(--surface-card);
      color: var(--text-strong);
      font-size: 13px;
      font-weight: 500;
      transition:
        background var(--fast) var(--ease),
        border-color var(--fast) var(--ease);
    }
    .b:hover {
      background: var(--surface-sunken);
    }
    .b.danger {
      color: var(--danger-text);
      border-color: rgba(220, 38, 38, 0.35);
    }
    .b.danger:hover {
      background: rgba(239, 68, 68, 0.08);
    }

    @media (max-width: 520px) {
      .island {
        right: 12px;
        bottom: 12px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .island {
        animation: none;
      }
      .bar span {
        transition: none;
      }
      .recent li {
        animation: none;
      }
    }
  `,
})
export class SendIsland {
  private readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);

  /** Newest messages first, refreshed as the server reports sends. */
  protected readonly recent = signal<MessageRecord[]>([]);
  /** Seconds left before a finished run closes; null while running or held. */
  protected readonly closesIn = signal<number | null>(null);
  private readonly held = signal(false);
  private countdown: ReturnType<typeof setInterval> | undefined;
  private recentTimer: ReturnType<typeof setTimeout> | undefined;

  protected readonly stats = this.store.stats.asReadonly();
  protected readonly open = signal(true);
  protected readonly error = signal('');
  /** A finished run the user closed; a new run (more total, or less processed) reopens it. */
  private readonly dismissed = signal<{ total: number } | null>(null);

  constructor() {
    // A new run brings the card back even if the last one was closed.
    effect(() => {
      if (this.phase() === 'sending' || this.phase() === 'paused') {
        this.dismissed.set(null);
        this.open.set(true);
      }
    });

    // Every send bumps historyRevision; coalesce a burst into one small fetch.
    effect(() => {
      this.store.historyRevision();
      if (!this.visible()) return;
      clearTimeout(this.recentTimer);
      this.recentTimer = setTimeout(() => this.loadRecent(), 400);
    });

    // Finished or stopped: count down and close, unless the pointer or focus is on the card.
    effect(() => {
      const ended = this.visible() && (this.phase() === 'done' || this.phase() === 'stopped');
      this.stopCountdown();
      if (!ended || this.held()) return;
      this.closesIn.set(AUTO_CLOSE_SECONDS);
      this.countdown = setInterval(() => {
        const left = (this.closesIn() ?? 1) - 1;
        if (left > 0) return this.closesIn.set(left);
        this.stopCountdown();
        this.dismiss();
      }, 1000);
    });

    this.destroyRef.onDestroy(() => {
      this.stopCountdown();
      clearTimeout(this.recentTimer);
    });
  }

  /** Whole-number progress for the bar and its `aria-valuenow`. */
  protected readonly percent = computed(() => Math.round(this.store.progress() * 100));

  /** Where the run is, derived from the server's counters rather than tracked here. */
  protected readonly phase = computed<'sending' | 'paused' | 'done' | 'stopped'>(() => {
    const s = this.stats();
    if (s.state === 'STOPPED') return 'stopped';
    if (s.pending === 0 && s.total > 0 && s.processed >= s.total) return 'done';
    return s.state === 'PAUSED' ? 'paused' : 'sending';
  });

  protected readonly visible = computed(() => {
    const s = this.stats();
    if (s.total <= 0) return false;
    const gone = this.dismissed();
    return !(
      gone &&
      gone.total === s.total &&
      this.phase() !== 'sending' &&
      this.phase() !== 'paused'
    );
  });

  protected readonly title = computed(() => {
    const s = this.stats();
    switch (this.phase()) {
      case 'done':
        return s.failed ? `Finished, ${s.failed} failed` : `Sent ${s.successful} messages`;
      case 'stopped':
        return 'Sending stopped';
      case 'paused':
        return 'Sending paused';
      default:
        return `Sending ${s.total} messages`;
    }
  });

  protected readonly icon = computed(
    () =>
      ({
        sending: 'send',
        paused: 'player-pause',
        done: 'circle-check',
        stopped: 'circle-x',
      })[this.phase()],
  );

  protected readonly note = computed(() => {
    const pacing = this.store.pacing();
    if (this.phase() === 'sending' && pacing) {
      return `${pacing.resting ? 'Resting between batches' : 'Spacing messages'}, next in about ${pacing.seconds}s`;
    }
    if (this.phase() === 'paused') return 'Waiting for you, or for the daily limit to reset.';
    if (this.phase() === 'sending') return 'Keeps running on the server if you close this tab.';
    return '';
  });

  protected hold(on: boolean): void {
    this.held.set(on);
  }

  protected initials(m: MessageRecord): string {
    const source = (m.name || '').trim();
    if (!source) return m.recipient.slice(-2);
    const parts = source.split(/\s+/);
    return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase();
  }

  protected tone(status: MessageRecord['status']): 'ok' | 'run' | 'bad' | 'mute' {
    if (status === 'SENT' || status === 'DELIVERED' || status === 'READ') return 'ok';
    if (status === 'FAILED') return 'bad';
    if (status === 'SENDING') return 'run';
    return 'mute';
  }

  protected label(status: MessageRecord['status']): string {
    return status === 'SANDBOX' ? 'Test' : status.charAt(0) + status.slice(1).toLowerCase();
  }

  private loadRecent(): void {
    // One HTTP call that completes on its own; failures just keep the last list.
    this.api.history({ limit: RECENT_COUNT }).subscribe({
      next: (res) => {
        if (res.body) this.recent.set(res.body.records.slice(0, RECENT_COUNT));
      },
      error: () => undefined,
    });
  }

  private stopCountdown(): void {
    clearInterval(this.countdown);
    this.countdown = undefined;
    this.closesIn.set(null);
  }

  protected dismiss(): void {
    this.dismissed.set({ total: this.stats().total });
  }

  protected act(action: 'pause' | 'resume' | 'stop'): void {
    this.error.set('');
    // One HTTP call that completes on its own; nothing to tear down.
    this.api.campaignAction(action).subscribe({
      next: ({ stats }) => this.store.stats.set(stats),
      error: (err: Error) => this.error.set(err.message),
    });
  }
}
