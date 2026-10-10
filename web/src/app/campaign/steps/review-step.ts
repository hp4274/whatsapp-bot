import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';

import { Api, CampaignsApi, PacingPreset, SafetyStatus } from '../../core/api';
import { Store } from '../../core/store';
import { CampaignDraft } from '../draft';
import { formatDuration } from '../wa-format';

/** The server may add quiet-hours info to the safety preview. */
type Safety = SafetyStatus & {
  quietHoursStart?: number;
  quietHoursEnd?: number;
  withinWindow?: boolean;
  withinSendingWindow?: boolean;
};

const PRESETS: { value: PacingPreset; label: string; icon: string; text: string }[] = [
  { value: 'safe', label: 'Safe', icon: 'shield', text: 'Slowest, most human' },
  { value: 'balanced', label: 'Balanced', icon: 'balance', text: 'Recommended' },
  { value: 'fast', label: 'Fast', icon: 'bolt', text: 'Down to the policy floor' },
];

const FALLBACK_ZONES = ['UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Australia/Sydney'];

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

@Component({
  selector: 'app-review-step',
  imports: [FormsModule, RouterLink],
  templateUrl: './review-step.html',
  styleUrl: './review-step.scss',
})
export class ReviewStep {
  protected readonly draft = inject(CampaignDraft);
  protected readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly campaignsApi = inject(CampaignsApi);

  protected readonly presets = PRESETS;
  protected readonly zones = zones(this.draft.timezone());
  protected readonly safety = signal<Partial<Record<PacingPreset, Safety>>>({});
  protected readonly loadingSafety = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected readonly connected = computed(() => this.store.connection().connected);
  protected readonly current = computed(() => this.safety()[this.draft.pacing()] ?? null);
  protected readonly size = computed(() => this.draft.estimatedSize());

  protected readonly overQuota = computed(() => {
    const s = this.current();
    return s && s.remaining !== null ? Math.max(0, this.size() - s.remaining) : 0;
  });

  protected readonly quiet = computed(() => {
    const s = this.current();
    if (!s || s.quietHoursStart === undefined || s.quietHoursEnd === undefined || s.quietHoursStart === s.quietHoursEnd) return null;
    const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
    return { from: hh(s.quietHoursStart), to: hh(s.quietHoursEnd), open: s.withinWindow ?? s.withinSendingWindow ?? true };
  });

  protected readonly buttonsLabel = computed(() => {
    const meta = this.draft.metaMode() ? this.draft.metaTemplate() : null;
    if (meta) return `Meta template: ${meta.name}`;
    const block = this.draft.interactive();
    if (!block) return 'None';
    const n = block.type === 'buttons' ? block.buttons?.length ?? 0
      : block.type === 'cta' ? block.cta?.length ?? 0
        : (block.list?.sections ?? []).reduce((t, s) => t + s.rows.length, 0);
    return `${{ buttons: 'Reply buttons', cta: 'Call-to-action', list: 'List menu' }[block.type]} (${n})`;
  });

  protected readonly sendsAt = computed(() => {
    const at = this.draft.scheduledAt();
    if (!at) return null;
    const tz = this.draft.timezone();
    return {
      at,
      zoned: at.toLocaleString(undefined, { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }),
      local: at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
      past: at.getTime() < Date.now() + 60_000,
    };
  });

  protected readonly blockers = computed(() => {
    const out: string[] = [];
    const d = this.draft;
    if (!d.audienceReady()) out.push('Choose an audience first.');
    if (!d.messageReady()) out.push('Finish the message (and fix any button errors).');
    if (d.scheduleMode() === 'later') {
      const s = this.sendsAt();
      if (!s) out.push('Pick a valid date, time and time zone.');
      else if (s.past) out.push('The scheduled time is in the past.');
    }
    return out;
  });

  constructor() {
    effect(() => {
      const size = this.size();
      untracked(() => this.loadSafety(size));
    });
  }

  private loadSafety(size: number): void {
    this.loadingSafety.set(true);
    forkJoin({
      safe: this.campaignsApi.safetyFor(size, 'safe'),
      balanced: this.campaignsApi.safetyFor(size, 'balanced'),
      fast: this.campaignsApi.safetyFor(size, 'fast'),
    }).subscribe({
      next: (r) => {
        this.loadingSafety.set(false);
        this.safety.set({ safe: r.safe.safety, balanced: r.balanced.safety, fast: r.fast.safety });
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
    this.draft.pacing.set(preset);
    if (!this.safety()[preset]) this.loadSafety(this.size());
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
          this.store.setStatus(`Campaign "${campaign.name}" scheduled for ${this.sendsAt()?.zoned ?? campaign.scheduledAt}`, 'primary');
          d.goTo(4);
          return;
        }
        this.campaignsApi.action(campaign.id, 'start').subscribe({
          next: (res) => {
            this.busy.set(false);
            const overQuota = res.safety && res.safety.remaining !== null ? Math.max(0, (res.queued ?? 0) - res.safety.remaining) : 0;
            d.result.set({ campaign: res.campaign ?? campaign, started: true, queued: res.queued, skipped: res.skipped, overQuota });
            if (res.stats) this.store.stats.set(res.stats);
            this.store.setStatus(`Campaign started: ${res.queued ?? 0} queued, ${res.skipped ?? 0} skipped`, 'primary');
            d.goTo(4);
          },
          error: (err: Error) => {
            this.busy.set(false);
            d.result.set({ campaign, started: false, error: err.message });
            this.store.setStatus(`Campaign saved but not started: ${err.message}`, 'warning');
            d.goTo(4);
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
