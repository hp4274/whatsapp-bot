import { Component, computed, inject, input, output, signal } from '@angular/core';

import { ClassInfo, Overview, SchoolApi, SchoolArea, SchoolMe, SendResult } from '../school-api';
import { Tilt } from '../tilt';

const RING = 2 * Math.PI * 52;

@Component({
  selector: 'school-overview',
  imports: [Tilt],
  templateUrl: './overview.html',
  styleUrl: './overview.scss',
})
export class OverviewTab {
  private readonly api = inject(SchoolApi);

  readonly classes = input<ClassInfo[]>([]);
  readonly classKey = input<string>('');
  readonly me = input<SchoolMe | null>(null);
  readonly navigate = output<SchoolArea>();

  protected readonly ring = RING;
  protected readonly today = new Date().toLocaleDateString('en-CA');
  protected readonly dateLabel = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  protected readonly dayNumber = String(new Date().getDate()).padStart(2, '0');
  protected readonly greeting = (() => {
    const h = new Date().getHours();
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  })();

  protected readonly data = signal<Overview | null>(null);
  protected readonly schoolName = signal('');
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  /** 0 -> 1 eased; every number on the page is scaled by it for the count-up. */
  protected readonly progress = signal(0);

  protected readonly confirming = signal(false);
  protected readonly sending = signal(false);
  protected readonly sendResult = signal<SendResult | null>(null);
  protected readonly sendError = signal('');

  protected readonly areas = computed(() => new Set(this.me()?.areas ?? []));

  // ponytail: rate may arrive as 0-1 or 0-100; values <= 1 are treated as a fraction.
  protected readonly ratePct = computed(() => {
    const r = this.data()?.attendance.rate ?? 0;
    return Math.round((r <= 1 ? r * 100 : r) * 10) / 10;
  });
  protected readonly gaugeOffset = computed(() => RING * (1 - (this.ratePct() * this.progress()) / 100));
  protected readonly feeTotal = computed(() => {
    const f = this.data()?.fees;
    return f ? f.collected + f.pending + f.overdue : 0;
  });

  constructor() {
    this.load();
    this.api.settings().subscribe({
      next: ({ settings }) => this.schoolName.set(settings.schoolName),
      error: () => undefined,
    });
  }

  protected load() {
    this.loading.set(true);
    this.error.set('');
    this.api.overview(this.today).subscribe({
      next: (o) => {
        this.data.set(o);
        this.loading.set(false);
        this.countUp();
      },
      error: (err: Error) => {
        this.error.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected n(value: number | undefined) {
    return Math.round((value ?? 0) * this.progress());
  }

  protected money(value: number, currency: string) {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'INR', maximumFractionDigits: 0 }).format(value);
    } catch {
      return `${currency} ${Math.round(value)}`;
    }
  }

  protected share(value: number) {
    const total = this.feeTotal();
    return total ? (value / total) * 100 : 0;
  }

  protected sendAbsent() {
    this.sending.set(true);
    this.sendError.set('');
    this.sendResult.set(null);
    this.api.notifyAttendance({ date: this.today, kinds: ['absent'] }).subscribe({
      next: (r) => {
        this.sendResult.set(r);
        this.sending.set(false);
        this.confirming.set(false);
        this.load();
      },
      error: (err: Error) => {
        this.sendError.set(err.message);
        this.sending.set(false);
      },
    });
  }

  private countUp() {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.progress.set(1);
      return;
    }
    this.progress.set(0);
    const start = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - start) / 1100);
      this.progress.set(1 - Math.pow(1 - p, 3));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}
