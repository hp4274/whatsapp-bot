import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { Observable, of, type Subscription } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';

import {
  Api,
  Campaign,
  CampaignsApi,
  type CampaignStartResult,
  type Channel,
  ChannelsApi,
  PacingPreset,
  SafetyStatus,
} from '../../core/api';
import { Auth } from '../../core/auth';
import type { SpreadPlan } from '../../core/api';
import { Store } from '../../core/store';
import { CampaignDraft, addDays, today } from '../draft';
import { CampaignPolicy } from '../policy-api';
import { formatDuration } from '../wa-format';

/** The server may add sending-window info to the safety preview. */
type Safety = SafetyStatus & {
  withinWindow?: boolean;
  withinSendingWindow?: boolean;
};

/** Used when the browser cannot list IANA zones (Intl.supportedValuesOf is missing). */
const FALLBACK_ZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
];

/** Every IANA zone the browser knows, with the current one guaranteed in the list. */
/** `YYYY-MM-DD` as "16 Oct 2026", read as a calendar day (UTC) so no zone shifts it. */
function dayLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  if (!y || !m || !d) return date;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** Wait this long after the last date/count change before asking the server for a plan. */
const SPREAD_DEBOUNCE_MS = 350;

/** The most phones the server's warm check reads (campaigns/routes.js warm-check): a hint, not a full count. */
const WARM_CHECK_MAX = 5000;

function zones(current: string): string[] {
  let list: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    list = intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    list = [];
  }
  if (!list.length) list = FALLBACK_ZONES;
  return list.includes(current) ? list : [current, ...list];
}

/**
 * When a send-now campaign of `size` finishes, from the server's estimate. `worst`: the days if
 * everyone is new to the number, when its new-chat budget sets the pace. Null within a day or uncapped.
 */
export function finishEstimate(
  s: Pick<Safety, 'enabled' | 'estimateSeconds' | 'budgets'> | null,
  size: number,
): { readonly days: number; readonly label: string; readonly worst: number | null } | null {
  const days = s?.estimateSeconds.days;
  const on = s?.estimateSeconds.finishesOn;
  if (!s?.enabled || !days || days < 2 || !on) return null;

  const chats = s.budgets?.newChats;
  const worst = chats?.limit ? 1 + Math.ceil(Math.max(0, size - chats.left) / chats.limit) : 0;
  const [y, m, d] = on.split('-').map(Number);
  const label = new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  return { days, label, worst: worst > days ? worst : null };
}

/** A shared campaign's finish `days` from today (1 = today) as the banner shows it; null when it all goes today. */
export function sharedFinish(
  days: number,
): { readonly days: number; readonly label: string; readonly worst: number | null } | null {
  if (days < 2) return null;
  const on = new Date();
  on.setDate(on.getDate() + days - 1);
  const label = on.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
  return { days, label, worst: null };
}

/**
 * Step 2: name, pace and timing, then send. Safety previews for all three
 * presets load together so switching pace is instant; blockers keep the send
 * button honest about why it is disabled.
 */
@Component({
  selector: 'app-review-step',
  imports: [DecimalPipe, FormsModule, RouterLink],
  templateUrl: './review-step.html',
  styleUrl: './review-step.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewStep {
  protected readonly draft = inject(CampaignDraft);
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly campaignsApi = inject(CampaignsApi);
  private readonly channelsApi = inject(ChannelsApi);
  private readonly auth = inject(Auth);
  /** Plan rules: the plan's sending speed, and whether scheduling is allowed. */
  protected readonly policy = inject(CampaignPolicy);

  protected readonly zones = zones(this.draft.timezone());
  /**
   * "More options" starts open only for a draft that already spreads or repeats. Read once: a live
   * binding would snap the fold shut the moment the user switched the option back off.
   */
  protected readonly advancedOpen = this.draft.scheduleMode() === 'spread' || !!this.draft.repeatEvery();
  protected readonly safety = signal<Partial<Record<PacingPreset, Safety>>>({});
  protected readonly loadingSafety = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  /** Armed by the first "Send now" click; "Yes, send now" sends. */
  protected readonly confirmSend = signal(false);
  /** Set after "Save draft", so the page can link to the saved campaign. */
  protected readonly draftSaved = signal<Campaign | null>(null);
  /** People missing a variable, from the server preview; a warning only, never a blocker. */
  protected readonly missingNote = signal('');

  protected readonly minDate = today();
  protected readonly spreadPlan = signal<SpreadPlan | null>(null);
  protected readonly spreadLoading = signal(false);
  protected readonly spreadError = signal('');
  /** Bumped by "Try again" so the check effect re-runs with an unchanged range. */
  protected readonly spreadRetry = signal(0);

  /** Client-side range problems; the server is only asked once these are clear. */
  protected readonly spreadRangeIssue = computed(() => {
    const d = this.draft;
    const from = d.spreadFrom();
    const to = d.spreadTo();
    if (!from || !to || !d.spreadTime()) return 'Pick a start date, end date and daily start time.';
    if (from < this.minDate) return 'The start date is in the past.';
    if (to < from) return 'The end date is before the start date.';
    return '';
  });

  /** Per-day bars scaled to the biggest batch; equal sizes give an even skyline. */
  protected readonly spreadBars = computed(() => {
    const plan = this.spreadPlan();
    if (!plan?.sizes.length) return [];
    const max = Math.max(...plan.sizes, 1);
    return plan.sizes.map((size, i) => ({
      size,
      pct: Math.max(12, (size / max) * 100),
      day: dayLabel(addDays(plan.startsOn || this.draft.spreadFrom(), i)),
    }));
  });

  protected readonly spreadSummary = computed(() => {
    const d = this.draft;
    if (!d.spreadActive()) return null;
    return { from: dayLabel(d.spreadFrom()), to: dayLabel(d.spreadTo()), time: d.spreadTime() };
  });

  protected readonly connected = computed(() => this.store.connection().connected);
  /**
   * "Now" needs this number connected: its own share would otherwise stay a draft that nothing starts when it
   * reconnects, while the shared numbers send theirs. Schedule it instead.
   */
  protected readonly canSendNow = computed(() => this.connected());
  /** Only admins may open the WhatsApp page; agents are told to ask one. */
  protected readonly isAdmin = computed(() => this.auth.atLeast('admin'));
  /**
   * This number's queue still holds another campaign's messages: the server refuses a second
   * start (409) and the new campaign would be left as a confusing draft, so say it up front.
   */
  protected readonly numberBusy = computed(() => this.store.stats().pending > 0);

  /** The business's numbers that may send campaigns. */
  protected readonly numbers = signal<Channel[]>([]);
  /** Other numbers switched on: the people are shared out and each number sends its own share. */
  protected readonly alsoFrom = signal<number[]>([]);
  /** The number this page is on; it always sends. */
  protected readonly ownId = computed(
    () => this.auth.channelId() ?? this.numbers().find((c) => c.isDefault)?.id ?? null,
  );
  /** The switched-on numbers that can take a share right now (a disconnected one cannot for "Now"). */
  protected readonly sharedIds = computed(() =>
    this.alsoFrom().filter((id) => this.numbers().some((c) => c.id === id && this.canShare(c))),
  );
  /** Each sending number's room today (this one, then the switched-on ones); Infinity = no cap or not known. */
  private readonly rooms = computed(() =>
    [this.ownId(), ...this.sharedIds()].map((id) => {
      const u = this.numbers().find((c) => c.id === id)?.health?.usage;
      if (!u) return Infinity;
      if (u.blocked || u.asked === false) return 0;
      return u.todayLimit === null ? Infinity : Math.max(0, u.todayLimit - u.sentToday);
    }),
  );
  /** How many people each sending number gets: dealt in turn, as the split route does. Same order as `rooms`. */
  protected readonly dealt = computed(() => {
    const n = 1 + this.sharedIds().length;
    return Array.from({ length: n }, (_, i) => Math.floor(this.size() / n) + (i < this.size() % n ? 1 : 0));
  });
  /** Each sending number's share that does not fit in its room today. Same order as `rooms`. */
  private readonly overBy = computed(() => this.dealt().map((share, i) => Math.max(0, share - this.rooms()[i])));

  /** Switched-on numbers that cannot send their whole share today, and why: their people wait, they are not lost. */
  protected readonly waiting = computed(() =>
    this.sharedIds().length
      ? [this.ownId(), ...this.sharedIds()].flatMap((id, i) => {
          const over = this.overBy()[i];
          const c = this.numbers().find((n) => n.id === id);
          if (!over || !c) return [];
          const u = c.health?.usage;
          const why =
            u?.asked === false
              ? 'until its 2 questions are answered on the WhatsApp page'
              : u?.blocked
                ? `while it is paused (${u.blocked})`
                : 'until its daily limit resets tomorrow';
          return [`${this.numberName(c)}: ${over} of its ${this.dealt()[i]} wait ${why}.`];
        })
      : [],
  );
  /** What this number sends: the whole list, or its share when numbers are switched on. Its own estimates use it. */
  protected readonly perNumber = computed(() => this.dealt()[0] ?? this.size());

  protected shareOf(id: number): number {
    return this.dealt()[[this.ownId(), ...this.sharedIds()].indexOf(id)] ?? 0;
  }

  /** Per number, how many of these people it already chats with; null until checked, and for non-file audiences. */
  protected readonly warm = signal<{ readonly checked: number; readonly warm: Readonly<Record<number, number>> } | null>(
    null,
  );
  /** The numbers' ids; equal while only their health changes, so a reconnect does not re-run the warm check. */
  private readonly numberIds = computed(() => this.numbers().map((c) => c.id), {
    equal: (a, b) => a.join() === b.join(),
  });
  /**
   * The number best placed to send now: connected, then the safest quality score, then the most of these people
   * already chatting with it (they skip its new-chat budget), then the most of today's limit left.
   */
  protected readonly recommendedId = computed(() => {
    const warm = this.warm()?.warm ?? {};
    const left = (c: Channel): number => {
      const u = c.health?.usage;
      if (!u) return 0;
      return u.todayLimit === null ? Number.MAX_SAFE_INTEGER : Math.max(0, u.todayLimit - u.sentToday);
    };
    const [best] = this.numbers()
      .filter((c) => c.health?.connected)
      .sort(
        (a, b) =>
          (b.health?.quality?.score ?? -1) - (a.health?.quality?.score ?? -1) ||
          (warm[b.id] ?? 0) - (warm[a.id] ?? 0) ||
          left(b) - left(a),
      );
    return best?.id ?? null;
  });
  /** The number switched on for the user because this one was not connected when the page opened. */
  protected readonly autoOn = signal<number | null>(null);
  private defaulted = false;

  /** "120 chatted with it before · 380 new to it" for one number, or '' before the check answers. */
  protected warmLabel(c: Channel): string {
    const check = this.warm();
    const n = check?.warm[c.id];
    if (!check || n === undefined) return '';
    const capped = this.draft.fileAudience().length > WARM_CHECK_MAX ? ` (of the first ${WARM_CHECK_MAX.toLocaleString()})` : '';
    return `${n.toLocaleString()} chatted with it before · ${(check.checked - n).toLocaleString()} new to it${capped}`;
  }

  protected numberName(c: Channel): string {
    return c.displayName || c.phoneNumber || c.health?.account || `Number #${c.id}`;
  }

  /** "Now" needs the number connected; a later time only needs it connected by then. */
  protected canShare(c: Channel): boolean {
    return this.draft.scheduleMode() !== 'now' || Boolean(c.health?.connected);
  }

  protected toggleNumber(id: number): void {
    this.alsoFrom.update((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  private loadNumbers(): void {
    this.channelsApi.list().subscribe({
      next: ({ channels }) => {
        this.numbers.set(channels.filter((c) => c.status === 'active' && c.capabilities.includes('campaigns')));
        if (!this.defaulted && this.numbers().length) this.defaultNumber();
      },
      error: () => this.numbers.set([]), // the card just stays hidden; sending from this number still works
    });
  }

  /**
   * Once, on the first list: this number cannot send right now, so the recommended one is switched on to send
   * with it. Later reloads never touch the switches again, so the user's own choice stands. The campaign stays
   * this number's.
   */
  private defaultNumber(): void {
    this.defaulted = true;
    const own = this.numbers().find((c) => c.id === this.ownId());
    const pick = this.recommendedId();
    if (!own || own.health?.connected || pick === null || pick === own.id || this.alsoFrom().includes(pick)) return;
    this.alsoFrom.update((ids) => [...ids, pick]);
    this.autoOn.set(pick);
  }

  protected readonly current = computed(() => this.safety()[this.draft.pacing()] ?? null);
  protected readonly size = computed(() => this.draft.estimatedSize());

  /** Spread mode: per-day overflow and contacts that would never be sent in the range. */
  protected readonly spreadShort = computed(() => {
    const plan = this.spreadPlan();
    if (!plan || !plan.dailyLimit || plan.perDay <= plan.dailyLimit) return null;
    return {
      perDay: plan.perDay - plan.dailyLimit,
      missed: Math.max(0, this.perNumber() - plan.days * plan.dailyLimit),
    };
  });

  /**
   * A QR number whose 2 questions are unanswered sends no bulk at all until they are, so
   * "goes out tomorrow" would be untrue: the page says what to do instead.
   */
  protected readonly held = computed(() => {
    const s = this.current();
    return !!s?.enabled && s.asked === false;
  });

  protected readonly overQuota = computed(() => {
    // A spread sends one batch a day: today's budget says nothing about the whole list.
    // Held for the questions, nothing is "over today's limit": the held banner explains it.
    if (this.draft.spreadActive()) return 0;
    // Shared: each number's own wait is named in `waiting` instead.
    if (this.sharedIds().length) return 0;
    if (this.held()) return 0;
    const s = this.current();
    return s && s.remaining !== null ? Math.max(0, this.perNumber() - s.remaining) : 0;
  });

  /**
   * When a send-now campaign finishes, from the server's estimate (today's budget, then the daily limit at
   * today's level). `worst`: the days if everyone is new to this number, when the new-chat budget sets the pace.
   * Null when it all goes today, or nothing is capped.
   */
  protected readonly finish = computed(() => {
    if (this.draft.spreadActive()) return null;
    // Shared: the slowest number decides, its overflow at its own daily limit. One that cannot send yet (limit 0)
    // has no date to give; `waiting` says what it waits for.
    if (this.sharedIds().length) {
      let days = 0;
      [this.ownId(), ...this.sharedIds()].forEach((id, i) => {
        const limit = this.numbers().find((c) => c.id === id)?.health?.usage?.todayLimit;
        if (this.overBy()[i] && limit) days = Math.max(days, 1 + Math.ceil(this.overBy()[i] / limit));
      });
      return sharedFinish(days);
    }
    return this.held() ? null : finishEstimate(this.current(), this.perNumber());
  });

  /**
   * How long the send takes, from the server's estimate for the chosen pace, when it all goes within today
   * (`finish` names the day otherwise). Each number sends its own share at once, so the share sets the time.
   */
  protected readonly takes = computed(() => {
    const s = this.current();
    if (this.draft.spreadActive() || this.held() || this.finish() || !s) return null;
    const seconds = s.estimateSeconds.typical;
    // No pacing (typical 0) has no duration worth stating: "about 0s" reads as broken.
    return this.perNumber() > 1 && seconds >= 1 ? { count: this.size(), time: formatDuration(seconds) } : null;
  });

  protected readonly buttonsLabel = computed(() => {
    const block = this.draft.interactive();
    if (!block) return 'None';
    const n =
      block.type === 'buttons'
        ? (block.buttons?.length ?? 0)
        : block.type === 'cta'
          ? (block.cta?.length ?? 0)
          : block.type === 'carousel'
            ? (block.carousel?.cards.length ?? 0)
            : (block.list?.sections ?? []).reduce((t, s) => t + s.rows.length, 0);
    return `${{ buttons: 'Reply buttons', cta: 'Call-to-action', list: 'List menu', carousel: 'Carousel' }[block.type]} (${n})`;
  });

  protected readonly confirmText = computed(() => {
    const who =
      this.draft.source() === 'retarget'
        ? 'this audience'
        : `${this.size().toLocaleString()} ${this.size() === 1 ? 'person' : 'people'}`;
    const s = this.current();
    // No pacing (typical 0) has no duration worth stating: "about 0s" reads as broken.
    const took =
      s && this.perNumber() > 1 && s.estimateSeconds.typical >= 1
        ? ` It will take about ${formatDuration(s.estimateSeconds.typical)}.`
        : '';
    return `Send to ${who} now?${took}`;
  });

  protected readonly sendsAt = computed(() => {
    const at = this.draft.scheduledAt();
    if (!at) return null;
    const tz = this.draft.timezone();
    return {
      at,
      zoned: at.toLocaleString(undefined, {
        timeZone: tz,
        dateStyle: 'medium',
        timeStyle: 'short',
      }),
      local: at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      // store.now() ticks every second, so a time that slips past while the page is open is caught too. Under a
      // minute ahead is refused as well (the sweeper may not reach it before it is due) but said as "too soon".
      past: at.getTime() < this.store.now() + 60_000,
      soon: at.getTime() >= this.store.now(),
    };
  });

  /** "Repeats every week until 31 Jan 2027" for the recap; null for a one-off. */
  protected readonly repeatSummary = computed(() => {
    const d = this.draft;
    const every = d.repeatEvery();
    if (!every) return null;
    const until = d.repeatUntil();
    return `Repeats every ${every}${until ? ` until ${dayLabel(until)}` : ''}`;
  });

  /** Reasons sending is not allowed yet, most important first; the first is shown under the button. */
  protected readonly blockers = computed(() => {
    const out: string[] = [];
    const d = this.draft;
    if (!d.audienceReady()) out.push('Choose an audience first.');
    if (!d.messageReady()) out.push('Finish the message (and fix any button errors).');
    if (d.interactive() && !this.policy.allowInteractive()) {
      out.push('Interactive buttons are not on your plan - remove them in the Message step.');
    }
    if (d.scheduleMode() === 'later') {
      const s = this.sendsAt();
      if (!s) out.push('Pick a valid date, time and time zone.');
      else if (s.past) {
        out.push(s.soon ? 'The scheduled time is less than a minute away. Pick a later time, or send now.'
          : 'The scheduled time is in the past.');
      }
    }
    // The server refuses a second run on a busy queue (409); a scheduled one simply waits its turn.
    if (d.scheduleMode() === 'now' && this.numberBusy()) {
      out.push('This number is still sending another campaign. Wait for it to finish, or schedule this one for later.');
    }
    if (d.repeatEvery() && d.repeatUntil() && d.repeatUntil() < this.minDate) {
      out.push('The repeat end date is in the past.');
    }
    if (d.scheduleMode() === 'spread') {
      const plan = this.spreadPlan();
      if (d.source() !== 'file') out.push('Spreading over several days only works with an uploaded file.');
      else if (this.spreadRangeIssue()) out.push(this.spreadRangeIssue());
      else if (this.sendsAt()?.past) {
        out.push('The first batch time has passed - pick a later start time or date.');
      } else if (this.spreadLoading()) out.push('Checking the daily plan...');
      else if (this.spreadError()) out.push(this.spreadError());
      else if (!plan) out.push('Waiting for the daily plan.');
      else if (!plan.feasible) {
        out.push(plan.reason ?? `This range is too short - it needs at least ${plan.minDays} days.`);
      }
    }
    return out;
  });

  constructor() {
    this.policy.load();
    this.loadNumbers();
    this.store.watch(['channels', 'connection'], () => this.loadNumbers());
    // A draft from before the rules loaded (or changed) is pulled back inside them.
    effect(() => {
      const d = this.draft;
      // The plan sets the speed; the draft follows it so the estimate matches what the server does.
      const planned = this.policy.maxSpeed();
      if (d.pacing() !== planned) untracked(() => d.pacing.set(planned));
      const mode = d.scheduleMode();
      const offPlan = !this.policy.allowScheduling() && mode !== 'now';
      // Switching the audience away from the file makes a spread impossible.
      if (offPlan || (mode === 'spread' && d.source() !== 'file')) {
        untracked(() => d.scheduleMode.set('now'));
      }
      // The server refuses a repeating spread, so choosing Spread drops the repeat.
      if (mode === 'spread' && (d.repeatEvery() || d.repeatUntil())) {
        untracked(() => {
          d.repeatEvery.set('');
          d.repeatUntil.set('');
        });
      }
    });
    /**
     * Live feasibility: debounced so typing a date does not fire a request per
     * keystroke; the cleanup cancels both the timer and any in-flight request,
     * so a stale answer can never overwrite a newer range (and nothing outlives
     * the component).
     */
    effect((onCleanup) => {
      const d = this.draft;
      this.spreadRetry();
      const active = d.spreadActive();
      // Each shared number spreads its own share over the same days. The typed numbers go too.
      const count = Math.ceil(d.fileAudience().length / (1 + this.sharedIds().length));
      const body = { count, from: d.spreadFrom(), to: d.spreadTo(), timezone: d.timezone() };
      const blocked = !active || count === 0 || this.spreadRangeIssue() !== '';
      untracked(() => {
        this.spreadError.set('');
        this.spreadPlan.set(null);
        this.spreadLoading.set(!blocked);
      });
      if (blocked) return;
      let sub: Subscription | undefined;
      const timer = setTimeout(() => {
        sub = this.campaignsApi.spreadCheck(body).subscribe({
          next: ({ plan }) => {
            this.spreadPlan.set(plan);
            this.spreadLoading.set(false);
          },
          error: (err: Error) => {
            this.spreadError.set(err.message);
            this.spreadLoading.set(false);
          },
        });
      }, SPREAD_DEBOUNCE_MS);
      onCleanup(() => {
        clearTimeout(timer);
        sub?.unsubscribe();
      });
    });
    // The pace changes once the plan loads, so it is tracked too; a newer ask cancels the older one.
    effect((onCleanup) => {
      const size = this.perNumber();
      const preset = this.draft.pacing();
      const sub = untracked(() => this.loadSafety(size, preset));
      onCleanup(() => sub.unsubscribe());
    });
    /**
     * Warm vs new per number, debounced and cancelled like the spread check. Only an uploaded file gives the page
     * its phones; a contacts or segment audience resolves on the server, so the card shows no counts for it.
     */
    effect((onCleanup) => {
      const phones = this.draft.fileAudience().map((c) => c.phone);
      const ids = this.numberIds();
      untracked(() => this.warm.set(null));
      if (!phones.length || ids.length < 2) return;
      let sub: Subscription | undefined;
      const timer = setTimeout(() => {
        sub = this.campaignsApi.warmCheck(phones.slice(0, WARM_CHECK_MAX), ids).subscribe({
          next: (check) => this.warm.set(check),
          error: () => this.warm.set(null), // only a hint: the card simply shows no counts
        });
      }, SPREAD_DEBOUNCE_MS);
      onCleanup(() => {
        clearTimeout(timer);
        sub?.unsubscribe();
      });
    });
  }

  private loadSafety(size: number, preset: PacingPreset): Subscription {
    this.loadingSafety.set(true);
    // Only the estimate is shown. The server answers at the plan's speed (bulk.maxSpeed), as the run
    // will send, whatever preset is asked for here.
    return this.campaignsApi
      .safetyFor(size, preset)
      .pipe(
        map((r) => r.safety),
        // Older servers ignore `pacing`; fall back to the plain preview.
        catchError(() => this.api.safety(size).pipe(map((r) => r.safety))),
      )
      .subscribe({
        next: (safety) => {
          this.loadingSafety.set(false);
          this.safety.set({ [preset]: safety });
        },
        error: () => this.loadingSafety.set(false),
      });
  }

  /** One click out of an infeasible range: stretch the end date to the server's minimum. */
  protected useMinDays(days: number): void {
    this.draft.spreadTo.set(addDays(this.draft.spreadFrom(), Math.max(1, days) - 1));
  }

  protected duration(seconds: number): string {
    return formatDuration(seconds);
  }

  /** Save without starting; only offered for "Now", where the status is draft. */
  protected saveDraft(): void {
    if (this.busy()) return;
    this.error.set('');
    this.draftSaved.set(null);
    this.busy.set(true);
    this.draft.save().subscribe({
      next: (campaign) => {
        this.busy.set(false);
        this.draftSaved.set(campaign);
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  /**
   * Ask the server which of the first recipients would miss a variable. Cheap
   * and advisory: an error here never stops the send.
   */
  private checkMissing(id: number): Observable<void> {
    this.missingNote.set('');
    if (!this.draft.usedVariables().length) return of(undefined);
    return this.campaignsApi.preview(id, 25).pipe(
      map((p) => {
        const people = p.previews.filter((x) => x.missing.length).length;
        if (people) {
          const vars = p.missing.map((v) => '{' + v + '}').join(', ');
          this.missingNote.set(
            `${people} of the first ${p.previews.length} people checked are missing ${vars} - they'll get the fallback or a blank.`,
          );
        }
      }),
      catchError(() => of(undefined)),
    );
  }

  protected send(confirmed = false): void {
    const d = this.draft;
    // A second click while the first save/start is in flight must not send twice.
    if (this.busy()) return;
    this.error.set('');
    this.draftSaved.set(null);
    if (this.blockers().length) {
      this.error.set(this.blockers()[0]);
      return;
    }
    const now = d.scheduleMode() === 'now';
    if (now && !this.canSendNow()) {
      this.error.set('Link a WhatsApp number before sending now - or schedule it instead.');
      return;
    }
    if (now && !confirmed) {
      this.confirmSend.set(true);
      return;
    }
    this.confirmSend.set(false);
    this.busy.set(true);
    const shared = this.sharedIds();
    d.save()
      .pipe(
        // Shared: this number keeps the first share, every other one gets a copy with its own.
        switchMap((campaign) =>
          shared.length ? this.campaignsApi.split(campaign.id, shared).pipe(map((r) => r.campaigns)) : of([campaign]),
        ),
        switchMap((all) => this.checkMissing(all[0].id).pipe(map(() => all))),
      )
      .subscribe({
        next: ([campaign, ...copies]) => {
          const others = copies.length ? ` and ${copies.length} more number${copies.length === 1 ? '' : 's'}` : '';
          if (!now) {
            this.busy.set(false);
            d.result.set({ campaign, started: false });
            const spread = this.spreadSummary();
            this.store.setStatus(
              (spread
                ? `Campaign "${campaign.name}" spread from ${spread.from} to ${spread.to}, daily at ${spread.time}`
                : `Campaign "${campaign.name}" scheduled for ${this.sendsAt()?.zoned ?? campaign.scheduledAt}`) +
                (others && `, from this number${others}`),
              'primary',
            );
            d.goTo(3);
            return;
          }
          // The server starts every number together; each sends its share at its own pace.
          this.start(campaign);
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }

  protected channelName(id: number | null): string {
    const c = this.numbers().find((n) => n.id === id);
    return c ? this.numberName(c) : 'Another number';
  }

  /** Which shared number is held or did not start: without it, it looks as if only one number sends. */
  private numberNotes(numbers: NonNullable<CampaignStartResult['numbers']>): string[] {
    if (numbers.length < 2) return [];
    // A number dealt nobody (no room today while another had some) is not sending, and nothing is wrong with it.
    const going = numbers.filter((n) => !n.error && n.queued > 0).length;
    return [
      going > 1 ? `Sending from ${going} numbers at once, each its own share at its own pace.` : '',
      ...numbers.flatMap((n) => {
        const name = this.channelName(n.channelId);
        if (n.error) return [`${name} did not start: ${n.error}`];
        if (!n.queued) return [];
        if (n.safety?.enabled && n.safety.asked === false) {
          return [`${name} holds its share until its 2 questions are answered.`];
        }
        if (n.safety?.remaining === 0) return [`${name} has no messages left today; its share goes tomorrow.`];
        return [];
      }),
    ];
  }

  private start(campaign: Campaign): void {
    const d = this.draft;
    this.campaignsApi.action(campaign.id, 'start').subscribe({
      next: (res) => {
        this.busy.set(false);
        const overQuota =
          res.safety && res.safety.remaining !== null
            ? Math.max(0, (res.numbers?.[0]?.queued ?? res.queued ?? 0) - res.safety.remaining)
            : 0;
        // The server's own notes may already explain a lowered speed; add ours only if they do not.
        const notes = [...(res.policyNotes ?? []), ...this.numberNotes(res.numbers ?? []).filter(Boolean)];
        const clamp = res.pacingClamped;
        if (clamp && !notes.some((n) => /speed|pace/i.test(n))) {
          notes.push(`Speed lowered to ${clamp.applied} by your plan.`);
        }
        if (this.missingNote()) notes.push(this.missingNote());
        d.result.set({
          ...res,
          campaign: res.campaign ?? campaign,
          started: true,
          policyNotes: notes,
          overQuota,
        });
        if (res.stats) this.store.stats.set(res.stats);
        this.store.setStatus(
          `Campaign started: ${res.queued ?? 0} queued, ${res.skipped ?? 0} skipped${notes.length ? '. ' + notes.join(' ') : ''}`,
          'primary',
        );
        d.goTo(3);
      },
      error: (err: Error) => {
        this.busy.set(false);
        // Some server reasons start in lower case ("that audience is empty"); the card shows a sentence.
        const why = err.message.charAt(0).toUpperCase() + err.message.slice(1);
        d.result.set({ campaign, started: false, error: why });
        this.store.setStatus(`Campaign saved but not started: ${why}`, 'warning');
        d.goTo(3);
      },
    });
  }
}
