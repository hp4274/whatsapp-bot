import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

/** One number and one kind of shadow trigger (server: adminOps.shadowReview). */
interface ShadowRow {
  readonly tenantName: string;
  readonly channelId: number;
  readonly number: string;
  /** A brake code (`delivery`, `stuck`, `unstable`) or a level note (`level:<reason>`). */
  readonly kind: string;
  readonly count: number;
  /** Hours a brake would have paused bulk; 0 for level notes. */
  readonly pauseHours: number;
  readonly lastAt: string;
}

/** Plain names for the shadow kinds; an unknown one shows its code. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  delivery: 'Delivery brake',
  stuck: 'Stuck brake',
  unstable: 'Unstable connection',
  'level:demote_delivery': 'Demotion (delivery)',
  'level:demote_stuck': 'Demotion (stuck)',
  'level:demote_replies': 'Demotion (replies)',
  'level:hold_health': 'Promotion held (health)',
  'level:hold_probation': 'Promotion held (probation)',
  'level:engaged': 'Engagement reward',
};

/**
 * What shadow mode would have done across every number in the last 7 days.
 *
 * The delivery, stuck and unstable brakes, demotion and the promotion gate only log while
 * `sending.brakesMode` is shadow. This is the one place to read a week of them side by side
 * before switching to enforce, instead of opening each number.
 */
@Component({
  selector: 'app-shadow-review',
  imports: [DatePipe],
  templateUrl: './shadow-review.html',
  styleUrl: './shadow-review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShadowReview {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rows = signal<readonly ShadowRow[]>([]);

  protected readonly totalHours = computed(() => this.rows().reduce((sum, r) => sum + r.pauseHours, 0));
  protected readonly numbers = computed(() => new Set(this.rows().map((r) => r.channelId)).size);

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.http
      .get<{ rows: ShadowRow[] }>('/api/admin/shadow-review')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ rows }) => {
          this.rows.set(rows);
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load the shadow review.');
          this.loading.set(false);
        },
      });
  }

  protected label(kind: string): string {
    return KIND_LABELS[kind] ?? kind;
  }
}
