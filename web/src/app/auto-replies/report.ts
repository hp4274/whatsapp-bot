import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, output, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { Store } from '../core/store';
import { AutoRepliesApi, Report } from './auto-replies.api';

/** The ranges the report offers; the activity log behind "not answered" keeps 30 days by default. */
const RANGES: readonly { days: number; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
];

/** What a hot entry is, in a few words beside its label. */
const KIND: Record<Report['hot'][number]['kind'], string> = {
  keyword: 'Keyword',
  system: 'Built-in reply',
  faq: 'FAQ',
  orders: 'Orders',
  school: 'School',
};

/**
 * Auto-reply reports: how many messages came in and how many the bot answered, which keywords customers use most,
 * what they ask that nothing answers (each with a one-click "add a reply"), and where they stop part-way through a
 * menu or a rule's questions. Reloads live as messages arrive (topic 'auto-replies').
 *
 * Charts are plain CSS bars: two series at most, a legend, a hover title per bar, and a table view for anyone who
 * cannot use the bars. Colours are the validated --chart-1 / --chart-2 pair from styles.scss.
 */
@Component({
  selector: 'ar-report',
  templateUrl: './report.html',
  styleUrl: './report.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportPanel {
  private readonly api = inject(AutoRepliesApi);
  private readonly destroyRef = inject(DestroyRef);

  /** "Add a reply" on a question nothing answered: the page opens a new rule with this as its keyword. */
  readonly answer = output<string>();

  protected readonly ranges = RANGES;
  protected readonly kind = KIND;
  protected readonly days = signal(7);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly report = signal<Report | null>(null);

  /** The tallest day, so bars share one scale (never 0, so an empty range still draws). */
  protected readonly dayMax = computed(() =>
    Math.max(1, ...(this.report()?.byDay ?? []).map((d) => d.answered + d.unanswered)),
  );
  protected readonly hourMax = computed(() => Math.max(1, ...(this.report()?.hours ?? [])));
  protected readonly hotMax = computed(() => Math.max(1, ...(this.report()?.hot ?? []).map((h) => h.uses)));
  /** "7-8 pm", or null when nothing came in. */
  protected readonly busiest = computed(() => {
    const hours = this.report()?.hours ?? [];
    const max = Math.max(0, ...hours);
    return max ? hourRange(hours.indexOf(max)) : null;
  });

  constructor() {
    effect(() => {
      this.days();
      untracked(() => this.load());
    });
    inject(Store).watch(['auto-replies'], () => this.load(true));
  }

  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set('');
    this.api
      .report(this.days())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.report.set(r);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected pct(n: number, of: number): number {
    return Math.round((n / of) * 100);
  }

  /** "Mon 18" for a YYYY-MM-DD day. */
  protected dayLabel(date: string): string {
    return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  /** Label only some days under the bars, so 30 or 90 of them never collide. */
  protected showDayLabel(i: number, total: number): boolean {
    const step = total <= 7 ? 1 : total <= 31 ? 5 : 15;
    return i % step === 0 || i === total - 1;
  }

  protected hourLabel(h: number): string {
    return hourRange(h);
  }

  protected ago(iso: string): string {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (mins < 60) return `${Math.max(1, mins)} min ago`;
    const hours = Math.round(mins / 60);
    return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
  }
}

/** "7-8 pm" for hour 19. */
function hourRange(h: number): string {
  const fmt = (x: number) => `${x % 12 || 12}`;
  const half = (x: number) => (x % 24 < 12 ? 'am' : 'pm');
  return `${fmt(h)}-${fmt(h + 1)} ${half(h + 1 === 24 ? 23 : h)}`;
}
