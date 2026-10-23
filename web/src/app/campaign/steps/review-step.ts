import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import type { Subscription } from 'rxjs';

import { Api, CampaignsApi, PacingPreset, SafetyStatus } from '../../core/api';
import type { SpreadPlan } from '../../core/api';
import { Store } from '../../core/store';
import { CampaignDraft, addDays, today } from '../draft';
import { CampaignPolicy } from '../policy-api';
import { formatDuration } from '../wa-format';

/** The server may add quiet-hours info to the safety preview. */
type Safety = SafetyStatus & {
  quietHoursStart?: number;
  quietHoursEnd?: number;
  withinWindow?: boolean;
  withinSendingWindow?: boolean;
};

/** Pacing presets; the server owns the actual delays and returns them per preset. */
const PRESETS: { value: PacingPreset; label: string; icon: string; text: string }[] = [
  { value: 'safe', label: 'Safe', icon: 'shield', text: 'Slowest, most human' },
  { value: 'balanced', label: 'Balanced', icon: 'scale', text: 'Recommended' },
  { value: 'fast', label: 'Fast', icon: 'bolt', text: 'Down to the policy floor' },
];

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
 * Step 2: name, pace and timing, then send. Safety previews for all three
 * presets load together so switching pace is instant; blockers keep the send
 * button honest about why it is disabled.
 */
@Component({
  selector: 'app-review-step',
  imports: [FormsModule, RouterLink],
  templateUrl: './review-step.html',
  styleUrl: './review-step.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewStep {
  protected readonly draft = inject(CampaignDraft);
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly campaignsApi = inject(CampaignsApi);
  /** Plan rules: presets above the speed ceiling and scheduling can be switched off. */
  protected readonly policy = inject(CampaignPolicy);

  protected readonly presets = PRESETS;
  protected readonly zones = zones(this.draft.timezone());
  protected readonly safety = signal<Partial<Record<PacingPreset, Safety>>>({});
  protected readonly loadingSafety = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

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
  protected readonly current = computed(() => this.safety()[this.draft.pacing()] ?? null);
  protected readonly size = computed(() => this.draft.estimatedSize());

  /** Spread mode: per-day overflow and contacts that would never be sent in the range. */
  protected readonly spreadShort = computed(() => {
    const plan = this.spreadPlan();
    if (!plan || !plan.dailyLimit || plan.perDay <= plan.dailyLimit) return null;
    return {
      perDay: plan.perDay - plan.dailyLimit,
      missed: Math.max(0, this.size() - plan.days * plan.dailyLimit),
    };
  });

  protected readonly overQuota = computed(() => {
    // A spread sends one batch a day: today's budget says nothing about the whole list.
    if (this.draft.spreadActive()) return 0;
    const s = this.current();
    return s && s.remaining !== null ? Math.max(0, this.size() - s.remaining) : 0;
  });

  protected readonly quiet = computed(() => {
    const s = this.current();
    if (
      !s ||
      s.quietHoursStart === undefined ||
      s.quietHoursEnd === undefined ||
      s.quietHoursStart === s.quietHoursEnd
    )
      return null;
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
    return {
      from: hh(s.quietHoursStart),
      to: hh(s.quietHoursEnd),
      open: s.withinWindow ?? s.withinSendingWindow ?? true,
    };
  });

  protected readonly buttonsLabel = computed(() => {
    const meta = this.draft.metaMode() ? this.draft.metaTemplate() : null;
    if (meta) return `Meta template: ${meta.name}`;
    const block = this.draft.interactive();
    if (!block) return 'None';
    const n =
      block.type === 'buttons'
        ? (block.buttons?.length ?? 0)
        : block.type === 'cta'
          ? (block.cta?.length ?? 0)
          : (block.list?.sections ?? []).reduce((t, s) => t + s.rows.length, 0);
    return `${{ buttons: 'Reply buttons', cta: 'Call-to-action', list: 'List menu' }[block.type]} (${n})`;
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
      past: at.getTime() < Date.now() + 60_000,
    };
  });

  /** Reasons sending is not allowed yet, most important first; the first is shown under the button. */
  protected readonly blockers = computed(() => {
    const out: string[] = [];
    const d = this.draft;
    if (!d.audienceReady()) out.push('Choose an audience first.');
    if (!d.messageReady()) out.push('Finish the message (and fix any button errors).');
    if (d.interactive() && !this.policy.allowInteractive()) {
      out.push('Interactive buttons are not on your plan - remove them in the audience and message step.');
    }
    if (d.scheduleMode() === 'later') {
      const s = this.sendsAt();
      if (!s) out.push('Pick a valid date, time and time zone.');
      else if (s.past) out.push('The scheduled time is in the past.');
    }
    if (d.scheduleMode() === 'spread') {
      const plan = this.spreadPlan();
      if (d.source() !== 'file') out.push('Spreading over dates needs an uploaded file audience.');
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
    // A draft from before the rules loaded (or changed) is pulled back inside them.
    effect(() => {
      const d = this.draft;
      if (this.policy.tooFast(d.pacing())) untracked(() => d.pacing.set(this.policy.maxSpeed()));
      const mode = d.scheduleMode();
      const offPlan = !this.policy.allowScheduling() && mode !== 'now';
      // Switching the audience away from the file makes a spread impossible.
      if (offPlan || (mode === 'spread' && d.source() !== 'file')) {
        untracked(() => d.scheduleMode.set('now'));
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
      const count = d.validContacts().length;
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
    effect(() => {
      const size = this.size();
      untracked(() => this.loadSafety(size));
    });
  }

  private loadSafety(size: number): void {
    this.loadingSafety.set(true);
    // One pace for everyone (balanced, unless the plan caps it lower): only the estimate is shown.
    const preset = this.draft.pacing();
    this.campaignsApi.safetyFor(size, preset).subscribe({
      next: (r) => {
        this.loadingSafety.set(false);
        this.safety.set({ [preset]: r.safety });
      },
      error: () => {
        // Older servers ignore `pacing`; fall back to the plain preview.
        this.api.safety(size).subscribe({
          next: ({ safety }) => {
            this.loadingSafety.set(false);
            this.safety.set({ [this.draft.pacing()]: safety });
          },
          error: () => this.loadingSafety.set(false),
        });
      },
    });
  }

  protected pickPacing(preset: PacingPreset): void {
    if (this.policy.tooFast(preset)) return;
    this.draft.pacing.set(preset);
    if (!this.safety()[preset]) this.loadSafety(this.size());
  }

  /** One click out of an infeasible range: stretch the end date to the server's minimum. */
  protected useMinDays(days: number): void {
    this.draft.spreadTo.set(addDays(this.draft.spreadFrom(), Math.max(1, days) - 1));
  }

  protected duration(seconds: number): string {
    return formatDuration(seconds);
  }

  protected send(): void {
    const d = this.draft;
    this.error.set('');
    if (this.blockers().length) {
      this.error.set(this.blockers()[0]);
      return;
    }
    const now = d.scheduleMode() === 'now';
    if (now && !this.connected()) {
      this.error.set('Connect a WhatsApp number before sending now - or schedule it instead.');
      return;
    }
    this.busy.set(true);
    this.campaignsApi.create(d.buildCreate()).subscribe({
      next: ({ campaign }) => {
        if (!now) {
          this.busy.set(false);
          d.result.set({ campaign, started: false });
          const spread = this.spreadSummary();
          this.store.setStatus(
            spread
              ? `Campaign "${campaign.name}" spread from ${spread.from} to ${spread.to}, daily at ${spread.time}`
              : `Campaign "${campaign.name}" scheduled for ${this.sendsAt()?.zoned ?? campaign.scheduledAt}`,
            'primary',
          );
          d.goTo(3);
          return;
        }
        this.campaignsApi.action(campaign.id, 'start').subscribe({
          next: (res) => {
            this.busy.set(false);
            const overQuota =
              res.safety && res.safety.remaining !== null
                ? Math.max(0, (res.queued ?? 0) - res.safety.remaining)
                : 0;
            d.result.set({
              campaign: res.campaign ?? campaign,
              started: true,
              queued: res.queued,
              skipped: res.skipped,
              overQuota,
            });
            if (res.stats) this.store.stats.set(res.stats);
            // Plan rules applied at send time (opt-in skips, speed lowered) - say so.
            const notes = (res as { policyNotes?: string[] }).policyNotes ?? [];
            this.store.setStatus(
              `Campaign started: ${res.queued ?? 0} queued, ${res.skipped ?? 0} skipped${notes.length ? '. ' + notes.join(' ') : ''}`,
              'primary',
            );
            d.goTo(3);
          },
          error: (err: Error) => {
            this.busy.set(false);
            d.result.set({ campaign, started: false, error: err.message });
            this.store.setStatus(`Campaign saved but not started: ${err.message}`, 'warning');
            d.goTo(3);
          },
        });
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }
}
