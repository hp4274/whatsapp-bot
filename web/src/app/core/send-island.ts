import {
  ChangeDetectionStrategy,
  afterRenderEffect,
  Component,
  DestroyRef,
  ElementRef,
  booleanAttribute,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { catchError, forkJoin, map, of } from 'rxjs';

import { WuzieFeed } from '../admin/wuzie-feed';
import { Api, CampaignsApi, type Campaign, type CampaignStats, type MessageRecord, type QueuedNext } from './api';
import { Auth } from './auth';
import { Store } from './store';

/** How long a finished run stays on screen before the card closes itself. */
const AUTO_CLOSE_SECONDS = 10;
/** How often the island looks for running campaigns on any of the business's numbers. */
const RUNS_POLL_MS = 10_000;
/** One island card's next messages and when its number sends again (ms epoch). */
type CardQueue = [number, { rows: QueuedNext[]; until: number }];

/** How many messages the card lists: the next ones while sending, the last ones after. */
const RECENT_COUNT = 5;

/** Queue rows with their tag: the one in flight, then the first waiting one is Next, the rest Queued or Later. */
function labelled(rows: readonly QueuedNext[]) {
  let nextTaken = false;
  return rows.map((m) => {
    if (m.sending) return { ...m, label: 'Sending', tone: 'run' as const };
    if (m.later) return { ...m, label: 'Later', tone: 'mute' as const };
    const label = nextTaken ? 'Queued' : 'Next';
    nextTaken = true;
    return { ...m, label, tone: label === 'Next' ? ('ok' as const) : ('mute' as const) };
  });
}

/**
 * A small floating card that follows a bulk send around the app, like an upload
 * tray: how far along it is, what has gone out, and pause / resume / stop.
 * The server owns the send, so this only reads `store.stats` and reflects it.
 *
 * Under the counts it lists who goes out next, in the server's own queue order
 * (the worker's, not the history table's), so the operator sees the real next
 * names rather than only a number; after the run it lists the last five sent.
 * Once a run ends the
 * card closes itself after 10 seconds; hovering or focusing it holds it open,
 * so nobody loses it mid-read (WCAG 2.2.1, adjustable timing).
 *
 * Mounted once by the shell rather than by the campaign page, so it survives
 * navigation. Two or more campaigns at once: one card each. The first stays open; each newer one stacks above it as
 * a slim bar (name, status, progress), and clicking a bar opens that campaign and folds the one that was open. The
 * open card then shows that campaign's own counts and controls.
 * With `wuzie` it follows Wuzie's own number instead (WuzieFeed): the
 * platform view mounts that one, so a message Wuzie sends shows here too. The template stays inline: it is the one component file this
 * folder owns, and the card is small.
 */
@Component({
  selector: 'app-send-island',
  imports: [NgTemplateOutlet, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div #island class="stack">
      @if (multi()) {
        <!-- Opened campaigns side by side, newest on the right; each opens and folds on its own. -->
        @for (c of order(); track c.id) {
          @if (isOpen(c.id)) {
            @let total = c.stats.total ?? 0;
            @let pending = c.stats.pending ?? 0;
            <aside class="island slot" [attr.data-run]="c.id" role="status" [attr.aria-label]="c.name + ' progress'">
              <header>
                <i class="ti ti-{{ c.status === 'paused' ? 'player-pause' : 'send' }} lead" aria-hidden="true"></i>
                <strong>{{ c.name }}</strong>
                <button type="button" class="ic" (click)="toggleRun(c.id)" aria-label="Collapse" aria-expanded="true">
                  <i class="ti ti-chevron-down" aria-hidden="true"></i>
                </button>
              </header>
              <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" [attr.aria-valuenow]="percentOf(c)">
                <span [style.width.%]="percentOf(c)"></span>
              </div>
              <div class="body">
                <p class="line">
                  <span>{{ total - pending }} of {{ total }} done</span>
                  <b>{{ percentOf(c) }}%</b>
                </p>
                <ul class="counts">
                  <li class="ok"><b>{{ c.stats.sent ?? 0 }}</b> sent</li>
                  <li [class.bad]="(c.stats.failed ?? 0) > 0"><b>{{ c.stats.failed ?? 0 }}</b> failed</li>
                  <li><b>{{ pending }}</b> waiting</li>
                </ul>
                <p class="line">
                  <span class="st st-{{ c.status === 'paused' ? 'mute' : 'run' }}">{{ c.status === 'paused' ? 'Paused' : 'Sending' }}</span>
                  <a class="link" [routerLink]="['/campaigns', c.id]">Details</a>
                </p>
                @if (c.status === 'paused' && reasonOf(c); as why) {
                  <p class="note">{{ why }}</p>
                }
                @let next = rowsFor(c.id);
                @if (next.length) {
                  <ol class="recent" aria-label="Up next">
                    @for (m of next; track m.messageId) {
                      <li>
                        <span class="av" aria-hidden="true">{{ initials(m) }}</span>
                        <span class="who">
                          <b>{{ m.name || m.recipient }}</b>
                          <small>{{ m.message || 'Media' }}</small>
                        </span>
                        <span class="st st-{{ m.tone }}">{{ m.label }}</span>
                      </li>
                    }
                  </ol>
                  <!-- The countdown is its own number's, read with its queue. -->
                  @if (c.status !== 'paused') {
                    <p class="note">{{ cardNote(c.id) }}</p>
                  }
                }
                @if (canControl()) {
                  <div class="actions">
                    @if (c.status === 'paused') {
                      <button type="button" class="b" (click)="actOn(c.id, 'resume')">Resume</button>
                    } @else {
                      <button type="button" class="b" (click)="actOn(c.id, 'pause')">Pause</button>
                    }
                    <button type="button" class="b danger" (click)="stopRun(c.id)" (blur)="stopArmed.set(null)">
                      {{ stopArmed() === c.id ? 'Stop sending?' : 'Stop' }}
                    </button>
                  </div>
                }
                @if (runError()?.id === c.id) {
                  <p class="err">{{ runError()?.text }}</p>
                }
              </div>
            </aside>
          }
        }
        <!-- Folded campaigns pile up on each other at the right edge; an opened one moves out beside the pile. -->
        @if (folded().length) {
          <div class="pile">
            @for (c of folded(); track c.id) {
                <button
                  type="button"
                  class="mini"
                  [attr.data-run]="c.id"
                  (click)="toggleRun(c.id)"
                  [attr.aria-expanded]="false"
                  [attr.aria-label]="'Show ' + c.name + ', ' + runLabel(c)"
                >
                  <i class="ti ti-{{ c.status === 'paused' ? 'player-pause' : 'send' }} lead" aria-hidden="true"></i>
                  <span class="mini-name">{{ c.name }}</span>
                  <span class="st st-{{ c.status === 'paused' ? 'mute' : 'run' }}">{{ runLabel(c) }}</span>
                  <i class="ti ti-chevron-up mini-open" aria-hidden="true"></i>
                  <span class="mini-bar" aria-hidden="true"><span [style.width.%]="percentOf(c)"></span></span>
                </button>
            }
          </div>
        }
      } @else {
        <ng-container *ngTemplateOutlet="card" />
      }
      </div>
    }

    <ng-template #card>
      <aside
        class="island"
        [class.done]="phase() === 'done'"
        [class.bad]="phase() === 'stopped'"
        role="status"
        aria-live="polite"
        [attr.aria-label]="wuzie() ? 'Wuzie WhatsApp sending' : 'Bulk message progress'"
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
            (click)="toggleCard()"
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
            @if (current(); as c) {
              <p class="line">
                <span class="cname">{{ c.name }}</span>
                <a class="link" [routerLink]="wuzie() ? '/admin/wapzo' : ['/campaigns', c.id]">Details</a>
              </p>
            }
            <p class="line">
              <span>{{ stats().processed }} of {{ stats().total }} done</span>
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
            @if (upNextRows().length) {
              <ol class="recent" aria-label="Up next">
                @for (m of upNextRows(); track m.messageId) {
                  <li>
                    <span class="av" aria-hidden="true">{{ initials(m) }}</span>
                    <span class="who">
                      <b>{{ m.name || m.recipient }}</b>
                      <small>{{ m.message || 'Media' }}</small>
                    </span>
                    <span class="st st-{{ m.tone }}">{{ m.label }}</span>
                  </li>
                }
              </ol>
            } @else if (recent().length) {
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
            @if ((phase() === 'sending' || phase() === 'paused') && canControl()) {
              <div class="actions">
                @if (phase() === 'sending') {
                  <button type="button" class="b" (click)="act('pause')">Pause</button>
                } @else {
                  <button type="button" class="b" (click)="act('resume')">Resume</button>
                }
                <button
                  type="button"
                  class="b danger"
                  (click)="stop()"
                  (blur)="confirmStop.set(false)"
                >
                  {{ confirmStop() ? 'Stop sending?' : 'Stop' }}
                </button>
              </div>
            }
            @if (error()) {
              <p class="err">{{ error() }}</p>
            }
          </div>
        }
      </aside>
    </ng-template>
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
    /* What floats: the open card at the bottom, other running campaigns as bars above it. */
    .stack {
      position: fixed;
      right: 24px;
      bottom: 24px;
      z-index: 50;
      display: flex;
      align-items: flex-end;
      justify-content: flex-end;
      gap: 12px;
      max-width: calc(100vw - 48px);
      pointer-events: none;
    }
    .stack > * {
      pointer-events: auto;
    }
    .island,
    .slot {
      width: min(360px, calc(100vw - 24px));
      flex: none;
    }
    /* The folded campaigns, one on another. */
    .pile {
      display: grid;
      gap: 6px;
      flex: none;
      pointer-events: auto;
    }
    .slot .island {
      width: 100%;
    }
    .island {
      padding: 14px 16px 16px;
      border: 1px solid var(--border-color);
      border-radius: 20px;
      color: var(--text-color);
      background: color-mix(in srgb, var(--surface-card) 92%, transparent);
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
      background: var(--brand-gradient); /* the logo's peach-to-orange */
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

    .cname {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--text-strong);
    }
    .link {
      flex: none;
      margin-left: 10px;
      font-weight: 500;
      color: var(--primary-text);
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

    /* A folded campaign: one line, its status, and a hairline of progress along the bottom. */
    .mini {
      position: relative;
      display: flex;
      align-items: center;
      gap: 10px;
      width: 280px;
      flex: none;
      min-height: 48px;
      padding: 8px 12px 10px;
      overflow: hidden;
      border: 1px solid var(--border-color);
      border-radius: 16px;
      color: var(--text-color);
      background: color-mix(in srgb, var(--surface-card) 92%, transparent);
      backdrop-filter: blur(14px);
      text-align: left;
      cursor: pointer;
      animation: island-in 260ms var(--ease) both;
      transition:
        border-color var(--fast) var(--ease),
        translate var(--fast) var(--ease);
    }
    .mini:hover {
      border-color: color-mix(in srgb, var(--primary) 45%, var(--border-color));
      translate: 0 -1px;
    }
    .mini:focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }
    .mini .lead {
      width: 24px;
      height: 24px;
      border-radius: 8px;
      font-size: 14px;
    }
    .mini-name {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      font-size: 13.5px;
      font-weight: 500;
      color: var(--text-strong);
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mini-open {
      font-size: 16px;
      color: var(--text-muted);
    }
    .mini-bar {
      position: absolute;
      inset: auto 0 0;
      height: 3px;
      background: var(--surface-sunken);
    }
    .mini-bar span {
      display: block;
      height: 100%;
      background: var(--brand-gradient);
      transition: width 400ms var(--ease);
    }

    /* No room side by side: they stack upwards instead, newest at the bottom. */
    @media (max-width: 900px) {
      .stack {
        flex-direction: column;
        align-items: stretch;
        width: min(360px, calc(100vw - 24px));
      }
      .mini,
      .slot,
      .pile {
        width: 100%;
      }
    }
    @media (max-width: 520px) {
      .stack {
        right: 12px;
        bottom: 12px;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .island,
      .mini {
        animation: none;
      }
      .mini-bar span {
        transition: none;
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
  /** Follow Wuzie's own number (the platform view) rather than the business's (Store). */
  readonly wuzie = input(false, { transform: booleanAttribute });
  private readonly store = inject(Store);
  private readonly feed = inject(WuzieFeed);
  private readonly api = inject(Api);
  private readonly campaignsApi = inject(CampaignsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(Auth);

  /**
   * Pause, Resume and Stop are admin writes on the server (an agent gets 403), so an agent
   * watches the run without buttons that can only fail.
   */
  protected readonly canControl = computed(() => this.auth.atLeast('admin'));

  /** Newest messages first, refreshed as the server reports sends. */
  protected readonly recent = signal<MessageRecord[]>([]);
  /** The queue's head while a run is live, in the order the server will send it. */
  private readonly upNext = signal<QueuedNext[]>([]);
  protected readonly upNextRows = computed(() => labelled(this.upNext()));

  /** Each card's own next messages, and when its number sends again (ms epoch), read from that campaign's number. */
  private readonly cardQueues = signal<ReadonlyMap<number, { rows: QueuedNext[]; until: number }>>(new Map());
  /** Ticks each second while cards show, for their countdowns. */
  private readonly now = signal(Date.now());

  /** One campaign's next messages, labelled on their own (its first waiting one is its "Next"). */
  protected rowsFor(id: number) {
    return labelled(this.cardQueues().get(id)?.rows ?? []).slice(0, 3);
  }

  protected cardNote(id: number): string {
    const left = Math.ceil(((this.cardQueues().get(id)?.until ?? 0) - this.now()) / 1000);
    return left > 0 ? `Next message in ${left}s` : 'Keeps running on the server if you close this tab.';
  }
  /**
   * The campaign being sent. The engine-wide stats carry no id, so the live
   * campaign is looked up once per run; null (no name, no link) if that fails.
   */
  private readonly named = signal<Pick<Campaign, 'id' | 'name'> | null>(null);
  protected readonly current = computed<Pick<Campaign, 'id' | 'name'> | null>(() => this.named());

  /** The business's campaigns running or paused now, oldest first; from two up each has its own card. */
  private readonly runs = signal<Campaign[]>([]);
  /**
   * One card per campaign: with two or more running, or with one that runs on another of the business's numbers
   * (the live stats only follow the selected number, so its own card reads the campaign's counts instead).
   */
  protected readonly multi = computed(
    () => !this.wuzie() && (this.runs().length > 1 || (this.runs().length === 1 && !this.liveHere())),
  );
  /** The number this page streams is sending or paused right now. */
  private readonly liveHere = computed(() => {
    const s = this.store.stats();
    return s.total > 0 && s.pending > 0 && (s.state === 'RUNNING' || s.state === 'PAUSED');
  });
  /** The campaigns whose cards the user opened, any number at once; all start folded. */
  private readonly opened = signal<ReadonlySet<number>>(new Set());
  /** The campaign whose Stop was clicked once; the second click stops it. */
  protected readonly stopArmed = signal<number | null>(null);
  /** The last failed action, shown on its own card. */
  protected readonly runError = signal<{ id: number; text: string } | null>(null);
  /** Every running campaign in a fixed order, oldest first (left), newest on the right edge. */
  protected readonly order = computed(() => (this.multi() ? this.runs() : []));
  /** The folded ones, for the pile: newest on top. */
  protected readonly folded = computed(() => [...this.order()].reverse().filter((c) => !this.isOpen(c.id)));
  /** Each run's place at the last render, for sliding it to its new one (FLIP). */
  private readonly lastAt = new Map<string, { x: number; y: number }>();
  /** A campaign was seen running since the card last closed: only campaigns open the card, not other sends. */
  private readonly campaignSeen = signal(false);
  /** First Stop click arms it; the second sends it. Resets on blur. */
  protected readonly confirmStop = signal(false);
  /** Seconds left before a finished run closes; null while running or held. */
  protected readonly closesIn = signal<number | null>(null);
  private readonly held = signal(false);
  private countdown: ReturnType<typeof setInterval> | undefined;
  /** When this page loaded, and whether a live run was seen since: tells old news from a run just finished. */
  private readonly bornAt = Date.now();
  private sawLive = false;
  private recentTimer: ReturnType<typeof setTimeout> | undefined;

  /** The single card's counts: the number's whole run (several campaigns each show their own on their cards). */
  protected readonly stats = computed<CampaignStats>(() => (this.wuzie() ? this.feed.stats() : this.store.stats()));
  private readonly pacing = computed(() => (this.wuzie() ? this.feed.pacing() : this.store.pacing()));
  private readonly pacingLeft = computed(() => (this.wuzie() ? this.feed.pacingLeft() : this.store.pacingLeft()));
  private readonly historyRevision = computed(() => (this.wuzie() ? this.feed.historyRevision() : this.store.historyRevision()));
  /** The single card's body; folded until the user opens it. */
  protected readonly open = signal(false);
  protected readonly error = signal('');
  /** A finished run the user closed; a new run (more total, or less processed) reopens it. */
  private readonly dismissed = signal<{ total: number } | null>(null);

  private readonly islandRef = viewChild<ElementRef<HTMLElement>>('island');

  constructor() {
    // A campaign added, removed, opened or folded: every other one slides from where it was to its new place.
    afterRenderEffect(() => {
      this.order();
      this.opened();
      const stack = this.islandRef()?.nativeElement;
      if (!stack) return this.lastAt.clear();
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const seen = new Set<string>();
      for (const el of Array.from(stack.querySelectorAll<HTMLElement>('[data-run]'))) {
        const id = el.dataset['run'] ?? '';
        const box = el.getBoundingClientRect();
        const now = { x: box.left, y: box.top };
        const before = this.lastAt.get(id);
        seen.add(id);
        this.lastAt.set(id, now);
        if (reduce || !before || (Math.abs(before.x - now.x) < 1 && Math.abs(before.y - now.y) < 1)) continue;
        el.animate([{ transform: `translate(${before.x - now.x}px, ${before.y - now.y}px)` }, { transform: 'none' }], {
          duration: 420,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        });
      }
      for (const id of [...this.lastAt.keys()]) if (!seen.has(id)) this.lastAt.delete(id);
    });

    // Wuzie's stream is opened for this island alone, and closed with it.
    effect((onCleanup) => {
      if (!this.wuzie()) return;
      untracked(() => this.feed.start());
      onCleanup(() => this.feed.stop());
    });

    // The card floats over the page's bottom-right corner: while it shows, the page keeps that much room at its
    // end (app.scss .page reads --island-space), so the last rows and buttons can always scroll clear of it.
    effect((onCleanup) => {
      const el = this.islandRef()?.nativeElement;
      const root = document.documentElement.style;
      if (!el) {
        root.removeProperty('--island-space');
        return;
      }
      const observer = new ResizeObserver(() => root.setProperty('--island-space', `${el.offsetHeight + 40}px`));
      observer.observe(el);
      onCleanup(() => {
        observer.disconnect();
        root.removeProperty('--island-space');
      });
    });

    // The card shows (folded) when a campaign starts, once; only the user opens or folds it (a send, an
    // auto-reply or a refresh never pops it open). Every campaign arrives folded, as a bar.
    let openedFor: number | null = null;
    effect(() => {
      const live = this.phase() === 'sending' || this.phase() === 'paused';
      if (live && this.stats().total > 0) this.sawLive = true; // empty stats read as "sending" before the first answer
      const id = this.wuzie() ? 0 : (this.named()?.id ?? null);
      if (id !== null && !this.wuzie()) this.campaignSeen.set(true);
      if (!live || id === null || id === openedFor) return;
      openedFor = id;
      // A new run shows the card again (folded: only the user opens it).
      untracked(() => this.dismissed.set(null));
    });

    // Name the live campaign when a run begins (or a different one replaces it).
    // Keyed on a number, not the stats object: stats change on every send, and
    // re-listing campaigns per message would hammer the server.
    const liveTotal = computed(() => {
      const live = this.phase() === 'sending' || this.phase() === 'paused';
      const total = this.stats().total;
      return live && total > 0 ? total : 0;
    });
    effect(() => {
      if (!liveTotal()) return;
      // Wuzie's number has no campaign pages: its sends are its account messages and broadcasts.
      if (this.wuzie()) return this.named.set({ id: 0, name: 'Wuzie WhatsApp' });
      untracked(() => this.loadRuns());
    });
    // Every campaign's sends and state changes (any number of the business), at most every 1.5 s.
    // (Wuzie's island skips it: loadRuns checks, as inputs are not set yet here.)
    this.store.watch(['campaign', 'campaigns'], () => this.loadRuns(), 1500);
    // A campaign on another number sends no events to this page: look for running campaigns now and then too.
    this.loadRuns();
    const poll = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.loadRuns();
    }, RUNS_POLL_MS);
    const tick = setInterval(() => {
      if (this.multi()) this.now.set(Date.now());
    }, 1000);
    this.destroyRef.onDestroy(() => {
      clearInterval(poll);
      clearInterval(tick);
    });

    // Every send bumps historyRevision; coalesce a burst into one small fetch.
    effect(() => {
      this.historyRevision();
      if (!this.visible()) return;
      clearTimeout(this.recentTimer);
      this.recentTimer = setTimeout(() => this.loadRecent(), 400);
    });

    // Finished or stopped: count down and close, unless the pointer or focus is on the card.
    effect(() => {
      const ended = this.visible() && (this.phase() === 'done' || this.phase() === 'stopped');
      this.stopCountdown();
      if (!ended || this.held()) return;
      // A run that finished before this page loaded is old news: do not pop it up on every reload.
      if (!this.sawLive && Date.now() - this.bornAt < 5000) {
        untracked(() => this.dismiss());
        return;
      }
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
  protected readonly percent = computed(() => {
    const { total, processed } = this.stats();
    return total > 0 ? Math.round(Math.min(1, processed / total) * 100) : 0;
  });

  /** Where the run is, derived from the server's counters rather than tracked here. */
  protected readonly phase = computed<'sending' | 'paused' | 'done' | 'stopped'>(() => {
    const s = this.stats();
    if (s.state === 'STOPPED') return 'stopped';
    if (s.pending === 0 && s.total > 0 && s.processed >= s.total) return 'done';
    return s.state === 'PAUSED' ? 'paused' : 'sending';
  });

  protected readonly visible = computed(() => {
    // Several campaigns running: the stack stays while any of them does, whatever one card did.
    if (this.multi()) return true;
    // Only a campaign brings the card: auto-replies, OTPs and single messages go out without it.
    if (!this.wuzie() && !this.campaignSeen()) return false;
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
        return s.failed ? `Finished, ${s.failed} failed` : `Sent ${s.successful} ${s.successful === 1 ? 'message' : 'messages'}`;
      case 'stopped':
        return 'Sending stopped';
      case 'paused':
        return 'Sending paused';
      default:
        return `Sending ${s.total} ${s.total === 1 ? 'message' : 'messages'}`;
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
    const pacing = this.pacing();
    const left = this.pacingLeft();
    if (this.phase() === 'sending' && pacing && left) {
      return `${pacing.resting ? 'Resting between batches' : 'Spacing messages'}, next in ${left}s`;
    }
    if (this.phase() === 'paused') {
      // Paused for a cause (the number unlinked, an auto-pause): say it rather than the generic line.
      const run = this.runs().find((c) => c.id === this.current()?.id);
      return (run && this.reasonOf(run)) || 'Waiting for you, or for the daily limit to reset.';
    }
    if (this.phase() === 'sending') return 'Keeps running on the server if you close this tab.';
    return '';
  });

  /**
   * The campaigns running or paused now. With two or more, each one's counts are read fresh (the list keeps the
   * last saved ones), so every card is live.
   */
  private loadRuns(): void {
    if (this.wuzie()) return;
    this.campaignsApi.list().subscribe({
      next: ({ campaigns }) => {
        const live = campaigns
          .filter((c) => c.status === 'running' || c.status === 'paused')
          .sort((a, b) => (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt) || a.id - b.id);
        this.named.set(live[0] ?? null);
        if (!live.length) return this.runs.set([]);
        // Each one's counts fresh (the list keeps the last saved ones), so every card is live.
        forkJoin(live.map((c) => this.campaignsApi.stats(c.id).pipe(map((r) => r.campaign), catchError(() => of(c))))).subscribe(
          (fresh) => {
            this.runs.set(fresh.filter((c) => c.status === 'running' || c.status === 'paused'));
            // A campaign on another number bumps no history here: its cards' "Up next" refresh with their counts.
            if (this.multi()) this.loadRecent();
          },
        );
      },
      error: () => undefined, // the card keeps what it shows; the next send tries again
    });
  }

  protected isOpen(id: number): boolean {
    return this.opened().has(id);
  }

  /** Open or fold one campaign's card; the others stay as they are. */
  protected toggleRun(id: number): void {
    const next = new Set(this.opened());
    if (!next.delete(id)) next.add(id);
    this.opened.set(next);
  }

  protected stopRun(id: number): void {
    if (this.stopArmed() !== id) return this.stopArmed.set(id);
    this.stopArmed.set(null);
    this.actOn(id, 'stop');
  }

  /** Pause, resume or stop one campaign alone, not the whole number. */
  protected actOn(id: number, action: 'pause' | 'resume' | 'stop'): void {
    this.runError.set(null);
    this.campaignsApi.action(id, action === 'stop' ? 'cancel' : action).subscribe({
      next: () => this.loadRuns(),
      error: (err: Error) => this.runError.set({ id, text: err.message }),
    });
  }

  protected percentOf(c: Campaign): number {
    const total = c.stats.total ?? 0;
    return total > 0 ? Math.round(Math.min(1, (total - (c.stats.pending ?? 0)) / total) * 100) : 0;
  }

  /** Why the server paused or held it (its number unlinked, an auto-pause), or null. */
  protected reasonOf(c: Campaign): string | null {
    return (c.options as { statusReason?: string | null } | undefined)?.statusReason ?? null;
  }

  protected runLabel(c: Campaign): string {
    return `${c.status === 'paused' ? 'Paused' : 'Sending'} · ${this.percentOf(c)}%`;
  }

  protected hold(on: boolean): void {
    this.held.set(on);
  }

  protected initials(m: { name: string; recipient: string }): string {
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
    if (status === 'NOT_ON_WHATSAPP') return 'Not on WhatsApp';
    return status === 'SANDBOX' ? 'Test' : status.charAt(0) + status.slice(1).toLowerCase();
  }

  private loadRecent(): void {
    // One HTTP call that completes on its own; failures just keep the last list.
    if (this.multi()) {
      // One card per campaign: its own next few and countdown, from its own number's queue (not the selected one's).
      const asked = Date.now();
      forkJoin(
        this.runs().map((c) =>
          this.api.queueNext(RECENT_COUNT, c.channelId, c.id).pipe(
            map((r): CardQueue => [c.id, { rows: r.next, until: asked + (r.waitingSeconds ?? 0) * 1000 }]),
            catchError(() => of<CardQueue>([c.id, { rows: [], until: 0 }])),
          ),
        ),
      ).subscribe((entries) => this.cardQueues.set(new Map(entries)));
    } else if (this.phase() === 'sending' || this.phase() === 'paused') {
      // Several campaigns share the queue in turns: ask for enough that each card gets its own next few.
      const limit = Math.min(20, RECENT_COUNT * Math.max(1, this.runs().length));
      (this.wuzie() ? this.feed.queueNext(RECENT_COUNT) : this.api.queueNext(limit)).subscribe({
        next: ({ next }) => this.upNext.set(next),
        error: () => undefined,
      });
    } else {
      this.upNext.set([]);
    }
    if (this.wuzie()) {
      this.feed.recent(RECENT_COUNT).subscribe({ next: (records) => this.recent.set(records), error: () => undefined });
      return;
    }
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

  /** The single card's chevron: folds its body. */
  protected toggleCard(): void {
    this.open.set(!this.open());
  }

  protected dismiss(): void {
    this.campaignSeen.set(false);
    this.dismissed.set({ total: this.stats().total });
  }

  protected stop(): void {
    if (!this.confirmStop()) {
      this.confirmStop.set(true);
      return;
    }
    this.confirmStop.set(false);
    this.act('stop');
  }

  protected act(action: 'pause' | 'resume' | 'stop'): void {
    this.error.set('');
    // One HTTP call that completes on its own; nothing to tear down.
    (this.wuzie() ? this.feed.action(action) : this.api.campaignAction(action)).subscribe({
      next: ({ stats }) => (this.wuzie() ? this.feed.stats : this.store.stats).set(stats),
      error: (err: Error) => this.error.set(err.message),
    });
  }
}
