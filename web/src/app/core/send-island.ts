import { Component, computed, effect, inject, signal } from '@angular/core';

import { Api } from './api';
import { Store } from './store';

/**
 * A small floating card that follows a bulk send around the app, like an upload
 * tray: how far along it is, what has gone out, and pause / resume / stop.
 * The server owns the send, so this only reads `store.stats` and reflects it.
 */
@Component({
  selector: 'app-send-island',
  template: `
    @if (visible()) {
      <aside class="island" [class.done]="phase() === 'done'" [class.bad]="phase() === 'stopped'"
             role="status" aria-live="polite" aria-label="Bulk message progress">
        <header>
          <span class="ms lead" aria-hidden="true">{{ icon() }}</span>
          <strong>{{ title() }}</strong>
          <button type="button" class="ic" (click)="open.set(!open())"
                  [attr.aria-label]="open() ? 'Collapse' : 'Expand'" [attr.aria-expanded]="open()">
            <span class="ms" aria-hidden="true">{{ open() ? 'expand_more' : 'expand_less' }}</span>
          </button>
          @if (phase() === 'done' || phase() === 'stopped') {
            <button type="button" class="ic" (click)="dismiss()" aria-label="Close">
              <span class="ms" aria-hidden="true">close</span>
            </button>
          }
        </header>

        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percent()">
          <span [style.width.%]="percent()"></span>
        </div>

        @if (open()) {
          <div class="body">
            <p class="line">
              <span>{{ stats().processed }} of {{ stats().total }} processed</span>
              <b>{{ percent() }}%</b>
            </p>
            <ul class="counts">
              <li class="ok"><b>{{ stats().successful }}</b> sent</li>
              <li [class.bad]="stats().failed > 0"><b>{{ stats().failed }}</b> failed</li>
              <li><b>{{ stats().pending }}</b> waiting</li>
            </ul>
            @if (note()) { <p class="note">{{ note() }}</p> }
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
            @if (error()) { <p class="err">{{ error() }}</p> }
          </div>
        }
      </aside>
    }
  `,
  styles: `
    @keyframes island-in { from { opacity: 0; translate: 0 16px; scale: 0.96; } to { opacity: 1; translate: none; scale: none; } }

    .island {
      position: fixed;
      right: 20px;
      bottom: 20px;
      z-index: 60;
      width: min(360px, calc(100vw - 24px));
      padding: 12px 14px 14px;
      border: 1px solid var(--border);
      border-radius: 16px;
      color: var(--text);
      background: color-mix(in srgb, var(--surface) 94%, var(--canvas));
      box-shadow: 0 18px 50px rgb(0 0 0 / 30%), 0 2px 6px rgb(0 0 0 / 18%);
      backdrop-filter: blur(14px);
      animation: island-in 280ms var(--ease) both;
    }

    header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    header strong { flex: 1; min-width: 0; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lead { font-size: 20px; color: var(--primary); }
    .done .lead { color: var(--primary); }
    .bad .lead { color: var(--danger); }

    .ic {
      display: grid;
      place-items: center;
      width: 28px;
      height: 28px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: var(--text-muted);
    }
    .ic:hover { background: var(--surface-alt); color: var(--text); }
    .ic .ms { font-size: 20px; }

    .bar { height: 6px; overflow: hidden; border-radius: 999px; background: var(--surface-alt); }
    .bar span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--primary), var(--accent));
      transition: width 400ms var(--ease);
    }
    .bad .bar span { background: var(--danger); }

    .body { display: grid; gap: 8px; margin-top: 10px; }
    .line { display: flex; justify-content: space-between; margin: 0; font-size: 13px; color: var(--text-muted); }
    .line b { color: var(--text); font-variant-numeric: tabular-nums; }

    .counts { display: flex; gap: 14px; margin: 0; padding: 0; list-style: none; font-size: 13px; color: var(--text-muted); }
    .counts b { font-variant-numeric: tabular-nums; color: var(--text); }
    .counts .ok b { color: var(--primary); }
    .counts .bad b { color: var(--danger); }

    .note, .err { margin: 0; font-size: 12px; color: var(--text-muted); }
    .err { color: var(--danger); }

    .actions { display: flex; gap: 8px; }
    .b {
      padding: 6px 14px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--surface-alt);
      color: var(--text);
      font-size: 12px;
      font-weight: 600;
    }
    .b:hover { border-color: var(--primary); }
    .b.danger { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 45%, transparent); background: transparent; }
    .b.danger:hover { background: var(--danger-soft); border-color: var(--danger); }

    @media (max-width: 520px) { .island { right: 12px; bottom: 12px; } }
    @media (prefers-reduced-motion: reduce) { .island { animation: none; } .bar span { transition: none; } }
  `,
})
export class SendIsland {
  private readonly store = inject(Store);
  private readonly api = inject(Api);

  protected readonly stats = this.store.stats;
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
  }

  protected readonly percent = computed(() => Math.round(this.store.progress() * 100));

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
    return !(gone && gone.total === s.total && this.phase() !== 'sending' && this.phase() !== 'paused');
  });

  protected readonly title = computed(() => {
    const s = this.stats();
    switch (this.phase()) {
      case 'done': return s.failed ? `Finished, ${s.failed} failed` : `Sent ${s.successful} messages`;
      case 'stopped': return 'Sending stopped';
      case 'paused': return 'Sending paused';
      default: return `Sending ${s.total} messages`;
    }
  });

  protected readonly icon = computed(() => ({
    sending: 'send', paused: 'pause_circle', done: 'check_circle', stopped: 'cancel',
  })[this.phase()]);

  protected readonly note = computed(() => {
    const pacing = this.store.pacing();
    if (this.phase() === 'sending' && pacing) {
      return `${pacing.resting ? 'Resting between batches' : 'Spacing messages'}, next in about ${pacing.seconds}s`;
    }
    if (this.phase() === 'paused') return 'Waiting for you, or for the daily limit to reset.';
    if (this.phase() === 'sending') return 'Keeps running on the server if you close this tab.';
    return '';
  });

  protected dismiss(): void {
    this.dismissed.set({ total: this.stats().total });
  }

  protected act(action: 'pause' | 'resume' | 'stop'): void {
    this.error.set('');
    this.api.campaignAction(action).subscribe({
      next: ({ stats }) => this.store.stats.set(stats),
      error: (err: Error) => this.error.set(err.message),
    });
  }
}
