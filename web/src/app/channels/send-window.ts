import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { Channel, ChannelPatch } from '../core/api';
import { WEEKDAYS, nowIn, timeZones, toMinutes } from './channel-meta';

/**
 * Edit when a number may send: weekdays, opening hours and the timezone they
 * are read in. The preview line answers "would a message go out right now?"
 * for the draft, before anything is saved.
 */
@Component({
  selector: 'app-send-window',
  imports: [FormsModule],
  templateUrl: './send-window.html',
  styleUrl: './send-window.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SendWindow {
  private readonly destroyRef = inject(DestroyRef);

  readonly channel = input.required<Channel>();
  readonly busy = input(false);
  readonly save = output<ChannelPatch>();

  protected readonly weekdays = WEEKDAYS;
  protected readonly zones = computed(() => timeZones(this.channel().timezone));

  protected readonly enabled = linkedSignal(() => Boolean(this.channel().businessHours));
  protected readonly start = linkedSignal(() => this.channel().businessHours?.start ?? '09:00');
  protected readonly end = linkedSignal(() => this.channel().businessHours?.end ?? '18:00');
  protected readonly zone = linkedSignal(() => this.channel().timezone || 'UTC');
  protected readonly days = linkedSignal(() => {
    const saved = this.channel().businessHours?.days;
    return new Set(
      saved?.length ? saved.map((d) => d.toLowerCase().slice(0, 3)) : WEEKDAYS.map((d) => d.id),
    );
  });

  /** Ticks every 30s so the "right now" line does not go stale. */
  private readonly clock = signal(Date.now());

  protected readonly problem = computed(() => {
    if (!this.enabled()) return '';
    if (!this.start() || !this.end()) return 'Set both an opening and a closing time.';
    if (toMinutes(this.start()) >= toMinutes(this.end()))
      return 'Closing time must be after opening time (overnight windows are not supported).';
    if (!this.days().size) return 'Pick at least one day.';
    return '';
  });

  protected readonly now = computed(() => {
    this.clock();
    return nowIn(this.zone());
  });

  protected readonly openNow = computed(() => {
    if (!this.enabled()) return true;
    const now = this.now();
    return (
      this.days().has(now.day) &&
      now.minutes >= toMinutes(this.start()) &&
      now.minutes < toMinutes(this.end())
    );
  });

  /** Save stays disabled until the draft differs from what the server has. */
  protected readonly dirty = computed(() => {
    const ch = this.channel();
    const saved = ch.businessHours;
    if (this.zone() !== (ch.timezone || 'UTC')) return true;
    if (this.enabled() !== Boolean(saved)) return true;
    if (!saved || !this.enabled()) return false;
    const savedDays = new Set(
      saved.days?.length ? saved.days.map((d) => d.slice(0, 3)) : WEEKDAYS.map((d) => d.id),
    );
    const draftDays = this.days();
    return (
      saved.start !== this.start() ||
      saved.end !== this.end() ||
      savedDays.size !== draftDays.size ||
      [...draftDays].some((d) => !savedDays.has(d))
    );
  });

  constructor() {
    const timer = setInterval(() => this.clock.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected toggleDay(id: string) {
    const next = new Set(this.days());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.days.set(next);
  }

  protected preset(kind: 'weekdays' | 'all') {
    const ids = WEEKDAYS.map((d) => d.id);
    this.days.set(new Set(kind === 'all' ? ids : ids.slice(0, 5)));
  }

  protected submit(event: Event) {
    event.preventDefault();
    if (this.problem()) return;
    if (!this.enabled()) {
      this.save.emit({ timezone: this.zone(), businessHours: null });
      return;
    }
    const days = WEEKDAYS.map((d) => d.id).filter((id) => this.days().has(id));
    this.save.emit({
      timezone: this.zone(),
      businessHours: {
        start: this.start(),
        end: this.end(),
        ...(days.length < 7 ? { days } : {}),
      },
    });
  }

  protected alwaysOpen() {
    this.enabled.set(false);
    this.save.emit({ timezone: this.zone(), businessHours: null });
  }
}
