import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';

import {
  Api,
  type Budget,
  SafetyCause,
  SafetyEvent,
  SafetyHealth,
  SafetyStatus,
  type SendingBrake,
} from '../core/api';
import { QuietTip, type TipAnchor, anchorBelow, isHovered, tipLayout } from '../core/quiet-tip';
import {
  type QuietSlot,
  describeWindow,
  durationLabel,
  quietSlots,
  windowSpeech,
} from '../core/quiet-time';
import { BRAKE_LABELS } from '../core/safety-fields';
import { Store } from '../core/store';

/** The summary line at the top of the card. `held` means bulk is not going out yet. */
interface Allowance {
  readonly held: boolean;
  readonly icon: string;
  readonly lead: string;
  readonly rest: string;
}

/** Icon per cause key from the server; an unknown key falls back to a shield. */
const CAUSE_ICONS: Readonly<Record<string, string>> = {
  reports: 'ti-flag',
  blocks: 'ti-ban',
  optouts: 'ti-user-minus',
  failed: 'ti-alert-triangle',
  volume: 'ti-send',
  optin: 'ti-user-check',
  newchats: 'ti-user-plus',
  replies: 'ti-messages',
};

/** Icon per brake code; an unknown code falls back to a hand. */
const BRAKE_ICONS: Readonly<Record<string, string>> = {
  reply_rate: 'ti-message-off',
  reports: 'ti-flag',
  blocks: 'ti-ban',
  failures: 'ti-alert-triangle',
  restricted: 'ti-lock-access',
  idle: 'ti-zzz',
  ban: 'ti-ban',
  delivery: 'ti-truck-delivery',
  stuck: 'ti-clock-pause',
  unstable: 'ti-wifi-off',
};

/**
 * The server explains the idle brake in terms of internal levels, which tenants never see;
 * this says the same thing in plain words.
 */
const IDLE_TEXT = "Nothing was delivered in the 3 days before today, so today's limit is lower.";

/** The ban brake holds 30 days from the ban (server humanize.js levelFor), so its `until` dates the ban. */
const BAN_BRAKE_MS = 30 * 86_400_000;

/** Below this internal level a number still looks new to WhatsApp, so the panel says how to look trusted. */
const TRUSTED_LEVEL = 4;

/**
 * How healthy the sending number is: one line for today's daily allowance and
 * how far it can grow, today's budgets and quiet-time windows, what is braking
 * it, and the block / report rate with who and when.
 *
 * The server grows a QR number's daily limit as people reply; how it does that
 * is deliberately not shown, only the number today and the most it reaches.
 *
 * Blocks are inferred (a message stuck at one tick for 24 hours), because
 * WhatsApp never tells a sender they were blocked. The copy says "may have".
 */
@Component({
  selector: 'app-sending-health',
  imports: [DatePipe, DecimalPipe, QuietTip],
  templateUrl: './sending-health.html',
  styleUrl: './sending-health.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:pointerdown)': 'outside($event)' },
})
export class SendingHealth {
  private readonly api = inject(Api);
  private readonly store = inject(Store);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly health = signal<SafetyHealth | null>(null);
  protected readonly safety = signal<SafetyStatus | null>(null);
  protected readonly causes = signal<SafetyCause[]>([]);

  protected readonly budgets = computed(() => this.safety()?.budgets ?? null);
  protected readonly brakes = computed(() => this.safety()?.brakes ?? []);
  /**
   * The one-line daily allowance: held for the questions, waiting after a new link,
   * no cap, or today's number and (while it can still grow) the most it reaches.
   */
  protected readonly allowance = computed<Allowance | null>(() => {
    const s = this.safety();
    if (!s) return null;
    // Safety off holds nothing and asks nothing (server channelUsage.js), whatever `asked` says.
    if (!s.enabled)
      return { held: false, icon: 'ti-infinity', lead: 'No daily limit', rest: '' };
    if (s.asked === false)
      return { held: true, icon: 'ti-help-circle', lead: 'Answer 2 questions to start sending', rest: '' };
    const wait = s.level?.resting;
    // A ban rests the number too; the wording matches the channel card's (channelUsage.js).
    if (wait?.active && s.brakes?.some((b) => b.code === 'ban'))
      return {
        held: true,
        icon: 'ti-ban',
        lead: 'WhatsApp banned this number.',
        rest: ' Bulk sending waits while it recovers.',
      };
    if (wait?.active)
      return {
        held: true,
        icon: 'ti-hourglass',
        lead: 'A newly linked number waits before bulk sending.',
        rest: wait.endsAt ? ` It starts ${this.when(wait.endsAt)}.` : '',
      };
    if (!s.limit && s.remaining === null)
      return { held: false, icon: 'ti-infinity', lead: 'No daily limit', rest: '' };
    return {
      held: false,
      icon: 'ti-send',
      lead: `${s.limit} messages a day`,
      rest: s.ceiling && s.ceiling > s.limit ? ` · rises gradually to ${s.ceiling} a day` : '',
    };
  });
  /** Trust tips show until the history alone earns TRUSTED_LEVEL; an idle day does not bring them back. */
  protected readonly looksNew = computed(() => {
    const lv = this.safety()?.level;
    return !!lv && lv.earned < TRUSTED_LEVEL;
  });
  /** The chat link customers tap to write first; a chat they open is never a new chat for us. */
  protected readonly chatLink = computed(() => {
    const account = this.store.connection().account.replace(/\D/g, '');
    return account ? `https://wa.me/${account}` : '';
  });
  protected readonly quiet = computed(() => this.safety()?.quiet ?? null);
  /** Today's windows in local time, judged against the server's clock so they tick on their own. */
  protected readonly slots = computed(() => {
    const q = this.quiet();
    return q ? quietSlots(q.windows, this.store.serverNow()) : [];
  });
  protected readonly resting = computed(() => this.slots().find((s) => s.state === 'now') ?? null);

  private readonly card = viewChild<ElementRef<HTMLElement>>('card');
  /** Window whose row has the pointer or focus, and where its tooltip hangs. */
  private readonly spot = signal<(TipAnchor & { readonly key: number }) | null>(null);
  /** A click froze the tooltip so touch users, who cannot hover, can read it. */
  protected readonly pinned = signal(false);
  /** Same words as the Campaigns strip, from the same helper, counting down on the same clock. */
  protected readonly tip = computed(() => {
    const w = this.slots().find((x) => x.key === this.spot()?.key);
    return w ? describeWindow(w, this.store.serverNow()) : null;
  });
  protected readonly lit = computed(() => this.tip()?.key ?? null);
  private readonly layout = tipLayout(this.spot);
  protected readonly place = this.layout.place;
  protected readonly tipTop = this.layout.top;
  protected readonly speech = windowSpeech;

  protected readonly usedPercent = computed(() => {
    const s = this.safety();
    return s?.limit ? Math.min(100, (s.used / s.limit) * 100) : 0;
  });

  /** Blocks + reports against the line where a campaign pauses itself. */
  protected readonly riskPercent = computed(() => {
    const h = this.health();
    if (!h?.pauseAtPercent) return 0;
    return Math.min(100, ((h.blockRatePercent + h.reportRatePercent) / h.pauseAtPercent) * 100);
  });

  protected readonly riskTone = computed(() => {
    const risk = this.riskPercent();
    return risk >= 100 ? 'tone-bad' : risk >= 50 ? 'tone-warn' : 'tone-ok';
  });

  constructor() {
    this.load();
    // The numbers move with sends, the connection and settings; reload on any.
    this.store.watch(['config', 'connection', 'history', 'stats'], () => this.load(false));
  }

  /** Reload in place, for a parent whose change the live events may not carry (safety overrides). */
  refresh(): void {
    this.load(false);
  }

  protected load(showSkeleton = true): void {
    if (showSkeleton) this.loading.set(true);
    this.error.set(null);
    this.api.safetyHealth().subscribe({
      next: ({ health, safety, causes }) => {
        this.health.set(health);
        this.causes.set(causes ?? []);
        this.safety.set(safety);
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected readonly duration = durationLabel;

  /** Hover or focus on a window row; ignored while another is pinned. */
  protected show(w: QuietSlot, e: Event): void {
    if (!this.pinned()) this.point(w, e.currentTarget as Element);
  }

  /** Touch fires a leave right after every tap, before the click that pins; that one is ignored. */
  protected hide(e?: PointerEvent): void {
    if (!this.pinned() && e?.pointerType !== 'touch') this.spot.set(null);
  }

  protected close(): void {
    this.pinned.set(false);
    this.spot.set(null);
  }

  /** A click pins a row's tooltip (the only way in on touch); clicking it again lets go. */
  protected pin(w: QuietSlot, e: MouseEvent): void {
    const el = e.currentTarget as Element;
    if (this.pinned() && this.lit() === w.key) {
      this.pinned.set(false);
      if (!isHovered(el)) this.spot.set(null);
      return;
    }
    this.point(w, el);
    this.pinned.set(true);
  }

  /** A tap or click outside the card closes a pinned tooltip. */
  protected outside(e: Event): void {
    if (this.spot() && !this.card()?.nativeElement.contains(e.target as Node)) this.close();
  }

  private point(w: QuietSlot, el: Element): void {
    const card = this.card()?.nativeElement;
    if (card) this.spot.set({ ...anchorBelow(card, el), key: w.key });
  }

  protected causeIcon(key: string): string {
    return CAUSE_ICONS[key] ?? 'ti-shield';
  }

  protected brakeIcon(code: string): string {
    return BRAKE_ICONS[code] ?? 'ti-hand-stop';
  }

  protected brakeLabel(code: string): string {
    return BRAKE_LABELS[code] ?? code;
  }

  protected brakeText(b: SendingBrake): string {
    if (b.code === 'idle') return IDLE_TEXT;
    // The server's ban text talks about rests; the brake lasts 30 days from the ban.
    if (b.code === 'ban' && b.until) {
      const on = new Date(Date.parse(b.until) - BAN_BRAKE_MS).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
      return `WhatsApp banned this number on ${on}. Its sending history restarted from then, and each further ban makes the wait before bulk sending longer.`;
    }
    return b.text;
  }

  private when(iso: string): string {
    return new Date(iso).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  /** Share of a budget used, 0-100; a budget of 0 (none today) reads as empty, not full. */
  protected share(b: Budget): number {
    return b.limit ? Math.min(100, (b.used / b.limit) * 100) : 0;
  }

  protected label(event: SafetyEvent): string {
    return event.kind === 'block' ? 'May have blocked you' : 'Complained';
  }
}
