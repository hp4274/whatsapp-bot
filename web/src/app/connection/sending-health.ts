import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
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
import { BRAKE_LABELS } from '../core/safety-fields';
import { Store } from '../core/store';

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
 * this says the same thing in plain words, with the server's own count of quiet days (3 or more).
 */
const idleText = (serverText: string): string => {
  const days = /in the (\d+) days/.exec(serverText)?.[1] ?? '3';
  return `Nothing was delivered in the ${days} days before today, so today's limit is lower.`;
};

/** Number health reloads at most this often while live events stream in (a run reports every send). */
const RELOAD_EVERY_MS = 2000;

/** The ban brake holds 30 days from the ban (server humanize.js levelFor), so its `until` dates the ban. */
const BAN_BRAKE_MS = 30 * 86_400_000;

/** Below this internal level a number still looks new to WhatsApp, so the panel says how to look trusted. */
const TRUSTED_LEVEL = 4;

/**
 * How healthy the sending number is: what is braking it, today's budgets, and the
 * block / report rate with who and when. The daily allowance itself is on the
 * number's card, the one place it is said.
 *
 * The server grows a QR number's daily limit as people reply; how it does that
 * is deliberately not shown, only the number today and the most it reaches.
 *
 * Blocks are inferred (a message still at one tick 48 hours after sending, judged
 * once by the server's health scan), because WhatsApp never tells a sender they
 * were blocked. The copy says "may have".
 */
@Component({
  selector: 'app-sending-health',
  imports: [DatePipe, DecimalPipe],
  templateUrl: './sending-health.html',
  styleUrl: './sending-health.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  /** Skipped the questions: the number runs at the plan's day, so only that day is shown. */
  protected readonly skipped = computed(() => this.safety()?.level?.start?.answers?.skipped === true);
  protected readonly brakes = computed(() => this.safety()?.brakes ?? []);
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
    // The numbers move with sends, the connection, settings, the admin and the number's questions; reload on any.
    // At most every 2s (RELOAD_EVERY_MS): a run reports every send, and each reload asks the server for a health scan.
    this.store.watch(['config', 'connection', 'history', 'stats', 'tenant', 'channels'], () =>
      this.reloadSoon(),
    );
    inject(DestroyRef).onDestroy(() => clearTimeout(this.reloadTimer));
  }

  private lastLoad = 0;
  private reloadTimer: ReturnType<typeof setTimeout> | undefined;

  /** A throttle, not a debounce: a steady stream of sends still reloads every 2s instead of never. */
  private reloadSoon(): void {
    if (this.reloadTimer !== undefined) return;
    const wait = Math.max(0, this.lastLoad + RELOAD_EVERY_MS - Date.now());
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      this.load(false);
    }, wait);
  }

  /** Reload in place, for a parent whose change the live events may not carry (safety overrides). */
  refresh(): void {
    this.load(false);
  }

  protected load(showSkeleton = true): void {
    this.lastLoad = Date.now();
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
    if (b.code === 'idle') return idleText(b.text);
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

  /** Share of a budget used, 0-100; a budget of 0 (none today) reads as empty, not full. */
  protected share(b: Budget): number {
    return b.limit ? Math.min(100, (b.used / b.limit) * 100) : 0;
  }

  protected label(event: SafetyEvent): string {
    return event.kind === 'block' ? 'May have blocked you' : 'Complained';
  }
}
