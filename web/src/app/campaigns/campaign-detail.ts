import {
  ChangeDetectionStrategy,
  type ElementRef,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { finalize, type Observable } from 'rxjs';

import {
  Api,
  type Campaign,
  type CampaignAnalytics,
  CampaignsApi,
  type Channel,
  ChannelsApi,
  ContactsApi,
  type PacingPreset,
} from '../core/api';
import { Store } from '../core/store';
import {
  canCancel,
  count,
  dayKey,
  daysBetween,
  listCounts,
  localTime,
  outcome,
  pct,
  percent,
  progressOf,
  relativeTime,
  stopQuestion,
} from './campaign-format';
import { CampaignInsights } from './campaign-insights';
import { CampaignRecipients } from './campaign-recipients';
import { CampaignStatusPill } from './status-pill';

/** How often a finished campaign is re-read while Delivered / Read ticks may still be on their way. */
const RECEIPT_POLL_MS = 10_000;
/**
 * A scheduled campaign may be days away and its start arrives as a live event; this slow poll is
 * only the backstop for a dropped stream.
 */
const SCHEDULED_POLL_MS = 30_000;
/** Phones that stay off or unread for longer than this are not worth a poll. */
const RECEIPT_WINDOW_MS = 7 * 86_400_000;
/**
 * Live events re-read the campaign at most this often: the answer lists every recipient, and a running send
 * reports several events a second. Still well inside "updates live".
 */
const LIVE_GAP_MS = 3000;
/** A paused campaign changes when someone acts on it (an event): this poll is only the backstop. */
const PAUSED_POLL_MS = 30_000;

/**
 * One campaign: its schedule, live progress and controls, then analytics.
 *
 * Analytics is the primary load because it carries the campaign too; if it
 * fails the campaign is fetched on its own so the controls still work. Live
 * progress comes from the store's engine stats, which describe whichever
 * campaign is running, so it is only shown while this one is.
 */
@Component({
  selector: 'app-campaign-detail',
  imports: [RouterLink, CampaignStatusPill, CampaignInsights, CampaignRecipients],
  templateUrl: './campaign-detail.html',
  styleUrl: './campaign-detail.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    // A sleeping tab misses SSE events: ask again the moment it is looked at.
    '(document:visibilitychange)': 'onSeen()',
    '(window:focus)': 'onSeen()',
  },
})
export class CampaignDetailView {
  private readonly api = inject(CampaignsApi);
  private readonly contactsApi = inject(ContactsApi);
  protected readonly store = inject(Store);

  /** Route param, bound by withComponentInputBinding. */
  readonly id = input.required<string>();

  private readonly engine = inject(Api);

  private readonly channels = signal<Channel[]>([]);
  /** Shared over several numbers: one list per number, named as on the Numbers page, with its own state. */
  protected readonly numbers = computed(() =>
    (this.campaign()?.numbers ?? []).map(({ channelId, status, statusReason }) => {
      const c = this.channels().find((ch) => ch.id === channelId);
      return { channelId, status, statusReason, label: c?.displayName || c?.phoneNumber || `Number #${channelId}` };
    }),
  );
  /** One number of a shared campaign is held while the others send: the campaign reads running, so say it here. */
  protected readonly heldShare = computed(() => {
    const held = this.numbers().filter((n) => n.status === 'paused');
    if (this.status() !== 'running' || !held.length) return null;
    return `${held.map((n) => n.label).join(', ')}: ${held[0].statusReason?.replace(/^Paused: /, '') ?? 'paused'}`;
  });

  /** Its number cannot send (held for it, paused or deleted): the numbers that could send the rest instead. */
  protected readonly moveTargets = computed(() => {
    const c = this.campaign();
    if (c?.status !== 'paused') return [];
    const own = this.channels().find((ch) => ch.id === c.channelId);
    const stuck = !!c.options?.linkHold || !own || own.status !== 'active';
    if (!stuck) return [];
    return this.channels().filter(
      (ch) => ch.id !== c.channelId && ch.status === 'active' && ch.health?.connected && ch.capabilities.includes('campaigns'),
    );
  });
  protected readonly moveTo = signal<number | null>(null);

  /** The last action's result, said next to the buttons (the sidebar line is off screen on a phone). */
  protected readonly notice = signal('');
  /** A refused action, next to the buttons: the page banner (with Try again) is for a page that failed to load. */
  protected readonly actionError = signal('');
  /** When the campaign's own number sends again (ms epoch): its countdown, not the selected number's. */
  private readonly nextAt = signal(0);
  protected readonly nextIn = computed(() => Math.ceil((this.nextAt() - this.store.now()) / 1000));
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private throttle: ReturnType<typeof setTimeout> | undefined;
  private disarm: ReturnType<typeof setTimeout> | undefined;
  protected readonly stopQuestion = stopQuestion;

  /**
   * Why the platform paused or stopped this run (auto-pause on failures, the
   * business's message cap, the kill switch, an admin action). Server-written.
   */
  protected readonly statusReason = computed(
    () => (this.campaign()?.options as { statusReason?: string | null } | undefined)?.statusReason ?? null,
  );
  /**
   * The repeat schedule and the runs it links to. The server writes `nextId`,
   * `previousId` and `recurrenceNote`; null for a campaign that is neither
   * repeating nor part of a series.
   */
  protected readonly series = computed(() => {
    const o = this.campaign()?.options;
    if (!o) return null;
    const r = o.recurrence;
    if (!r && !o.nextId && !o.previousId && !o.recurrenceNote) return null;
    let until = '';
    if (r?.until) {
      const [y, m, d] = r.until.split('-').map(Number);
      until = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
        timeZone: 'UTC',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      });
    }
    return {
      repeats: r ? `Repeats every ${r.every}${until ? ` (until ${until})` : ''}` : null,
      nextId: o.nextId ?? null,
      previousId: o.previousId ?? null,
      note: o.recurrenceNote ?? null,
    };
  });
  private readonly recipientsTable = viewChild(CampaignRecipients);
  protected readonly campaign = signal<Campaign | null>(null);
  /** The name being typed while renaming; null when not renaming. Any state may be renamed, running included. */
  protected readonly renaming = signal<string | null>(null);
  protected readonly savingName = signal(false);
  /** A refused rename, shown under the box (the page-wide error would replace the whole page). */
  protected readonly nameError = signal('');
  private readonly nameBox = viewChild<ElementRef<HTMLInputElement>>('nameBox');
  protected readonly analytics = signal<CampaignAnalytics | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);
  protected readonly error = signal('');
  /** Which control is in flight; every control disables while any one is. */
  protected readonly busy = signal<string | null>(null);
  protected readonly confirmCancel = signal(false);
  /** When the analytics on screen were read (ms epoch); null until the first answer. */
  protected readonly updatedAt = signal<number | null>(null);
  /** Analytics requests in flight, for the funnel's refresh spinner. */
  protected readonly inflight = signal(0);
  /**
   * Request counter and the newest one applied. Analytics is slow on a big campaign, so an older
   * answer can land after a newer one and put stale counts back; it is dropped instead. An
   * older answer that lands first is still applied, so a busy run never starves the screen.
   */
  private issued = 0;
  private applied = 0;
  private lastAsk = 0;

  protected readonly numericId = computed(() => Number(this.id()));
  protected readonly status = computed(() => this.campaign()?.status ?? 'draft');
  protected readonly pacing = computed<PacingPreset>(
    () => this.campaign()?.options?.pacing ?? 'balanced',
  );
  /** A segment campaign stores no audience until it starts: its size is the segment's live count. */
  private readonly segmentCount = signal<number | null>(null);
  protected readonly audience = computed(
    () =>
      this.analytics()?.funnel.audience ||
      this.campaign()?.audienceSize ||
      this.analytics()?.funnel.queued ||
      this.segmentCount() ||
      0,
  );
  protected readonly failedCount = computed(
    () => this.analytics()?.funnel.failed ?? this.campaign()?.stats?.failed ?? 0,
  );
  protected readonly canRetry = computed(() => {
    const s = this.status();
    return this.failedCount() > 0 && (s === 'done' || s === 'cancelled' || s === 'paused');
  });
  protected readonly canCancel = computed(() => canCancel(this.status()));

  /**
   * The headline answer ("1,240 of 1,300 delivered · 52 failed") above the detailed numbers.
   * Uses the analytics funnel when it loaded, else the campaign's own stored stats.
   */
  protected readonly outcome = computed(() => {
    const c = this.campaign();
    if (!c) return null;
    const funnel = this.analytics()?.funnel;
    return outcome(c.status, this.audience(), funnel ?? listCounts(c.stats), !!c.options?.linkHold);
  });

  /**
   * Progress from this campaign's own counts (re-read every few seconds while it runs), kept while it is paused
   * so "230 of 2,598 done" does not vanish. Not the selected number's engine totals: those miss a campaign on
   * another number and mix campaigns sharing one.
   */
  protected readonly live = computed(() => {
    const c = this.campaign();
    if (!c || (c.status !== 'running' && c.status !== 'paused')) return null;
    const p = progressOf(c, this.store.now());
    return { ...p, total: p.total || this.audience(), running: c.status === 'running' };
  });

  /**
   * Multi-day ("spread") progress, null for a one-off send. The day is counted on
   * the campaign's calendar (the running or next-booked day), not by batches sent,
   * so a skipped day still reads as the day it is.
   */
  protected readonly spread = computed(() => {
    const c = this.campaign();
    const s = c?.options?.spread;
    if (!c || !s?.total) return null;
    const days = daysBetween(s.from, s.to) + 1;
    const at =
      c.status === 'scheduled' && c.scheduledAt
        ? new Date(c.scheduledAt)
        : new Date(this.store.now());
    const day = Math.min(
      days,
      Math.max(1, daysBetween(s.from, dayKey(at, c.options.timezone)) + 1),
    );
    const sent = c.stats?.sent ?? s.cursor ?? 0;
    return { day, days, sent, total: s.total, pct: percent(sent, s.total) };
  });

  /**
   * Today's batch is out and the next one is booked for a later local day, so
   * "start" means "send that one now". The server decides the same way; this
   * only picks the label, so a timezone mismatch costs a wrong word, not a wrong send.
   */
  protected readonly canContinueEarly = computed(() => {
    const c = this.campaign();
    if (c?.status !== 'scheduled' || !c.options?.spread?.cursor || !c.scheduledAt) return false;
    const zone = c.options.timezone;
    return dayKey(new Date(c.scheduledAt), zone) > dayKey(new Date(this.store.now()), zone);
  });

  protected readonly localTime = localTime;
  protected readonly count = count;
  protected readonly pct = pct;
  /** Reads the store's ticking clock, so "in 5s" runs down by itself. */
  protected readonly relativeTime = (iso: string | null | undefined) =>
    relativeTime(iso, this.store.now());

  /**
   * The segment whose live count stands in for the audience, or null. Equal across reloads that
   * change nothing here, so a poll does not fetch every segment again.
   */
  private readonly countedSegment = computed(() => {
    const c = this.campaign();
    const waiting = c?.status === 'draft' || c?.status === 'scheduled';
    return waiting && !c?.audienceSize ? (c?.segmentId ?? null) : null;
  });

  protected startRename(c: Campaign): void {
    this.nameError.set('');
    this.renaming.set(c.name);
    // Focus and select the name once the box is drawn.
    setTimeout(() => this.nameBox()?.nativeElement.select());
  }

  protected saveName(): void {
    const c = this.campaign();
    const name = this.renaming()?.trim();
    if (!c || !name) return;
    if (name === c.name) return this.renaming.set(null);
    this.savingName.set(true);
    this.api.rename(c.id, name).pipe(finalize(() => this.savingName.set(false))).subscribe({
      next: ({ campaign }) => {
        this.campaign.update((cur) => (cur ? { ...cur, name: campaign.name } : cur));
        this.renaming.set(null);
      },
      error: (err: Error) => this.nameError.set(err.message),
    });
  }

  constructor() {
    effect(() => {
      const segmentId = this.countedSegment();
      if (segmentId === null) {
        untracked(() => this.segmentCount.set(null));
        return;
      }
      untracked(() =>
        this.contactsApi.segments().subscribe({
          next: ({ segments }) =>
            this.segmentCount.set(segments.find((x) => x.id === segmentId)?.count ?? null),
          error: () => this.segmentCount.set(null),
        }),
      );
    });
    effect(() => {
      this.id();
      untracked(() => {
        this.loading.set(true);
        this.campaign.set(null);
        this.analytics.set(null);
        this.updatedAt.set(null);
        this.notFound.set(false);
        // Whatever is still in flight belongs to the previous campaign.
        this.applied = ++this.issued;
        this.reload();
      });
    });
    this.store.watch(['campaigns', 'campaign', 'history', 'analytics'], () => this.reloadSoon(), 700);
    // Names only, for a shared campaign's lists: a failure leaves "Number #id".
    inject(ChannelsApi).list().subscribe({ next: ({ channels }) => this.channels.set(channels), error: () => {} });
    // Events sent while the stream was down are gone: read again once it is back.
    let wasOnline = this.store.streamOnline();
    effect(() => {
      const online = this.store.streamOnline();
      if (online && !wasOnline) untracked(() => this.reload());
      wasOnline = online;
    });
    // SSE can drop silently (proxy resets, sleeping tabs), so poll as a backstop: fast while a run
    // is live, slowly while it is paused or waits for its start, and slowly once it is done for as
    // long as Delivered / Read ticks can still arrive. A hidden tab asks nothing (onSeen catches up).
    const poll = setInterval(() => {
      if (this.loading() || document.visibilityState !== 'visible') return;
      const since = Date.now() - this.lastAsk;
      const status = this.status();
      if (status === 'running') {
        if (since >= LIVE_GAP_MS) this.reload();
      } else if (status === 'paused') {
        if (since >= PAUSED_POLL_MS) this.reload();
      } else if (status === 'scheduled') {
        if (since >= SCHEDULED_POLL_MS) this.reload();
      } else if (this.receiptsPending() && since >= RECEIPT_POLL_MS) this.reload();
    }, 3000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(poll);
      clearTimeout(this.throttle);
      clearTimeout(this.noticeTimer);
      clearTimeout(this.disarm);
    });
  }

  /**
   * A live event: re-read, at most once every LIVE_GAP_MS (the answer lists every recipient), and the last event
   * of a burst always lands. A hidden tab waits for onSeen.
   */
  private reloadSoon(): void {
    if (this.throttle || document.visibilityState !== 'visible') return;
    const wait = Math.max(0, LIVE_GAP_MS - (Date.now() - this.lastAsk));
    this.throttle = setTimeout(() => {
      this.throttle = undefined;
      this.reload();
    }, wait);
  }

  /** "Next message in Xs" from the campaign's own number: the page's selected one may be another. */
  private readNext(c: Campaign): void {
    if (c.status !== 'running') return this.nextAt.set(0);
    const asked = Date.now();
    this.engine.queueNext(1, c.channelId, c.id).subscribe({
      next: ({ waitingSeconds }) => this.nextAt.set(asked + (waitingSeconds ?? 0) * 1000),
      error: () => this.nextAt.set(0),
    });
  }

  /** Said next to the buttons for a few seconds. */
  private say(text: string): void {
    clearTimeout(this.noticeTimer);
    this.actionError.set('');
    this.notice.set(text);
    this.noticeTimer = setTimeout(() => this.notice.set(''), 5000);
  }

  /**
   * Ticks land minutes to hours after the last send, long after the status says `done`, so
   * "finished" is not "settled": some sends are still short of Read, and recently enough to care.
   */
  private receiptsPending(): boolean {
    const funnel = this.analytics()?.funnel;
    if (!funnel || !['done', 'cancelled', 'paused'].includes(this.status())) return false;
    const ended = Date.parse(this.campaign()?.finishedAt ?? '');
    return funnel.sent > funnel.read && !(Date.now() - ended > RECEIPT_WINDOW_MS);
  }

  /** Tab shown or window focused; both events fire together, so the second is ignored. */
  protected onSeen(): void {
    if (document.visibilityState !== 'visible' || this.loading() || Date.now() - this.lastAsk < 1000) return;
    this.reload();
  }

  /** The banner's Try again: with nothing on screen yet, the skeleton shows while it asks. */
  protected tryAgain(): void {
    this.error.set('');
    if (!this.campaign()) this.loading.set(true);
    this.reload();
  }

  protected reload(): void {
    const id = this.numericId();
    if (!Number.isFinite(id) || id <= 0) {
      this.notFound.set(true);
      this.loading.set(false);
      return;
    }
    const ticket = ++this.issued;
    const stale = () => ticket < this.applied;
    this.lastAsk = Date.now();
    this.inflight.update((n) => n + 1);
    this.api
      .analytics(id)
      .pipe(finalize(() => this.inflight.update((n) => n - 1)))
      .subscribe({
        next: (data) => {
          if (stale()) return;
          this.applied = ticket;
          this.analytics.set(data);
          this.campaign.set(data.campaign);
          this.readNext(data.campaign);
          this.updatedAt.set(Date.now());
          this.error.set('');
          this.loading.set(false);
        },
        // Analytics failing does not mean the campaign is gone: ask for it directly.
        error: (err: Error) => {
          if (stale()) return;
          this.api.get(id).subscribe({
            next: ({ campaign }) => {
              if (stale()) return;
              this.campaign.set(campaign);
              this.error.set(`Analytics unavailable: ${err.message}`);
              this.loading.set(false);
            },
            error: (inner: Error) => {
              if (stale()) return;
              if (/not found|404/i.test(inner.message)) this.notFound.set(true);
              else this.error.set(inner.message);
              this.loading.set(false);
            },
          });
        },
      });
  }

  private run<T extends { campaign: Campaign }>(
    label: string,
    call: () => Observable<T>,
    ok: string | ((res: T) => string),
  ) {
    // A fast double click lands before the disabled state renders; the second would 409.
    if (this.busy()) return;
    this.busy.set(label);
    this.actionError.set('');
    call().subscribe({
      next: (res) => {
        this.busy.set(null);
        this.keep(res.campaign);
        this.say(typeof ok === 'string' ? ok : ok(res));
        this.reload();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.notice.set('');
        this.actionError.set(err.message);
      },
    });
  }

  protected act(action: 'start' | 'pause' | 'resume'): void {
    const early = action === 'start' && this.canContinueEarly();
    const done = {
      start: 'Campaign started.',
      pause: 'Campaign paused.',
      resume: 'Campaign resumed.',
    };
    this.run(
      action,
      () => this.api.action(this.numericId(), action),
      ({ queued, carried, policyNotes }) =>
        [
          early ? `Sent ${queued ?? 0} now${carried ? `; ${carried} more go out tomorrow` : ''}.` : done[action],
          ...(policyNotes ?? []),
        ].join(' '),
    );
  }

  /** First click arms Stop (it cannot be undone, unlike Pause); the second stops. Disarms by itself after 4 s. */
  protected cancel(): void {
    clearTimeout(this.disarm);
    if (!this.confirmCancel()) {
      this.confirmCancel.set(true);
      this.disarm = setTimeout(() => this.confirmCancel.set(false), 4000);
      return;
    }
    this.confirmCancel.set(false);
    this.run(
      'cancel',
      () => this.api.action(this.numericId(), 'cancel'),
      'Campaign stopped. Messages not sent yet were cancelled.',
    );
  }

  /** Its number cannot send: the people it has not reached get it from the picked number instead. */
  protected move(): void {
    const to = this.moveTo() ?? this.moveTargets()[0]?.id;
    if (to === undefined) return;
    this.run('move', () => this.api.move(this.numericId(), to), ({ people }) =>
      `The remaining ${people.toLocaleString()} ${people === 1 ? 'person goes' : 'people go'} out from the other number now.`,
    );
  }

  /** An action's answer carries no list number: keep the one the page has. */
  private keep(campaign: Campaign): void {
    this.campaign.set({ ...campaign, number: campaign.number ?? this.campaign()?.number });
  }

  protected retry(): void {
    if (this.busy()) return;
    this.busy.set('retry');
    this.actionError.set('');
    this.api.retryFailed(this.numericId()).subscribe({
      next: ({ campaign, queued }) => {
        this.busy.set(null);
        this.keep(campaign);
        this.say(`Re-queued ${queued} failed recipient${queued === 1 ? '' : 's'}.`);
        this.reload();
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.actionError.set(err.message);
      },
    });
  }

  /** Filters the recipient table to failures and scrolls to it. */
  protected showFailed(): void {
    this.recipientsTable()?.showStatus('FAILED');
  }

  protected exportCsv(): void {
    if (this.busy()) return;
    this.busy.set('export');
    this.api.exportCsv(this.numericId()).subscribe({
      next: (blob) => {
        this.busy.set(null);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `campaign-${this.id()}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      },
      error: (err: Error) => {
        this.busy.set(null);
        this.error.set(err.message);
      },
    });
  }
}
