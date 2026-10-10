import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  signal,
} from '@angular/core';

import { ArChips, ArMedia, ArSwitch, ArText } from './ar-fields';
import {
  ArToasts,
  AutoRepliesApi,
  AutoReplySettings,
  DAYS,
  DayHours,
  SystemKey,
  SystemStats,
  Weekday,
  ago,
} from './auto-replies.api';

/** The fixed set of built-in replies, in the order a conversation meets them. */
const CARDS: readonly { key: SystemKey; title: string; icon: string; blurb: string }[] = [
  {
    key: 'welcome',
    title: 'Welcome',
    icon: 'hand-move',
    blurb: 'First message from a brand-new contact',
  },
  {
    key: 'away',
    title: 'Away / hours',
    icon: 'moon',
    blurb: 'Outside business hours and on holidays',
  },
  {
    key: 'fallback',
    title: 'Default fallback',
    icon: 'help-circle',
    blurb: 'When nothing else matched',
  },
  { key: 'handoff', title: 'Human handoff', icon: 'headset', blurb: 'Customer asks for a person' },
];

type Draft = AutoReplySettings[SystemKey];

/**
 * The four built-in replies: compact tiles, one expanded editor below.
 *
 * The on/off switch on a tile saves immediately (and reverts on failure);
 * everything inside the expanded editor is a draft until Save, so a half-typed
 * message never goes live.
 */
@Component({
  selector: 'ar-system-cards',
  imports: [ArSwitch, ArText, ArMedia, ArChips],
  templateUrl: './system-cards.html',
  styleUrl: './system-cards.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SystemCards {
  private readonly api = inject(AutoRepliesApi);
  private readonly toasts = inject(ArToasts);

  readonly settings = model.required<AutoReplySettings>();
  readonly stats = input<SystemStats | null>(null);

  protected readonly cards = CARDS;
  protected readonly days = DAYS;
  protected readonly ago = ago;
  protected readonly open = signal<SystemKey | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly saving = signal(false);
  /** In-progress business name; null when the field shows the saved value. */
  protected readonly bizName = signal<string | null>(null);

  protected readonly openCard = computed(() => CARDS.find((c) => c.key === this.open()) ?? null);
  protected readonly dirty = computed(() => {
    const k = this.open();
    return !!k && JSON.stringify(this.draft()) !== JSON.stringify(this.settings()[k]);
  });

  // Typed views of the draft for the card-specific fields.
  protected readonly away = computed(() =>
    this.open() === 'away' ? (this.draft() as AutoReplySettings['away']) : null,
  );
  protected readonly fallback = computed(() =>
    this.open() === 'fallback' ? (this.draft() as AutoReplySettings['fallback']) : null,
  );
  protected readonly handoff = computed(() =>
    this.open() === 'handoff' ? (this.draft() as AutoReplySettings['handoff']) : null,
  );

  protected snippet(key: SystemKey): string {
    const s = this.settings()[key];
    return s.text?.trim() || 'No message written yet';
  }

  protected toggleOpen(key: SystemKey): void {
    if (this.open() === key) {
      this.open.set(null);
      return;
    }
    this.open.set(key);
    this.draft.set(structuredClone(this.settings()[key]));
  }

  protected patch(p: Partial<Draft>): void {
    const d = this.draft();
    if (d) this.draft.set({ ...d, ...p } as Draft);
  }

  protected setDay(day: Weekday, p: Partial<DayHours>): void {
    const a = this.away();
    if (a)
      this.patch({ hours: { ...a.hours, [day]: { ...a.hours[day], ...p } } } as Partial<Draft>);
  }

  protected num(e: Event): number {
    return Math.max(0, Number((e.target as HTMLInputElement).value) || 0);
  }

  protected v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected setEnabled(key: SystemKey, enabled: boolean): void {
    const prev = this.settings();
    this.settings.set({ ...prev, [key]: { ...prev[key], enabled } });
    if (this.open() === key) this.patch({ enabled });
    const title = CARDS.find((c) => c.key === key)?.title;
    this.put(
      { [key]: { enabled } },
      `${title} ${enabled ? 'on' : 'off'}`,
      (ok) => ok || this.settings.set(prev),
    );
  }

  protected saveCard(): void {
    const k = this.open();
    const d = this.draft();
    if (!k || !d) return;
    this.saving.set(true);
    this.put({ [k]: d }, 'Saved', (ok) => {
      this.saving.set(false);
      if (ok && this.open() === k) this.draft.set(structuredClone(this.settings()[k]));
    });
  }

  protected saveBizName(): void {
    const name = this.bizName()?.trim();
    this.bizName.set(null);
    if (name === undefined || name === this.settings().businessName) return;
    this.put({ businessName: name }, 'Business name saved');
  }

  private put(patch: Partial<AutoReplySettings>, ok: string, done?: (ok: boolean) => void): void {
    this.api.saveSettings(patch).subscribe({
      next: ({ settings }) => {
        this.settings.set(settings);
        this.toasts.ok(ok);
        done?.(true);
      },
      error: (err) => {
        this.toasts.error(err);
        done?.(false);
      },
    });
  }
}
