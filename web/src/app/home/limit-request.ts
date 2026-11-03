import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  type ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';

import { Store } from '../core/store';
import {
  type LimitKey,
  type LimitRequest,
  LimitRequestsApi,
  type LimitRequestsState,
  REQUEST_STATUS,
  askLine,
  durationLabel,
} from './limit-requests-api';

/** One block of the form: which limit, the number wanted, and for how long. */
interface Ask {
  /** Stable across edits, for `track` and the control ids. */
  readonly id: number;
  readonly key: LimitKey | '';
  readonly value: number | null;
  readonly days: number;
}

/** What a new block asks for unless changed: a month is the usual "we have a busy season" answer. */
const DEFAULT_DAYS = 30;

/** The server takes at most this many asks in one request. */
const MAX_ASKS = 10;

/**
 * Request more: a business asks the platform admin for higher limits, each for a while or until changed. One column
 * of asks (as the product owner asked), then an optional note; earlier requests and their answers sit underneath so
 * the business sees what it already asked before asking again. Opened from Plan usage, owners and admins only.
 */
@Component({
  selector: 'app-limit-request',
  imports: [FormsModule, DatePipe],
  templateUrl: './limit-request.html',
  styleUrl: './limit-request.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'close()' },
})
export class LimitRequestDrawer {
  private readonly api = inject(LimitRequestsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly store = inject(Store);

  /** Sent: the parent closes the drawer and says so in the panel. */
  readonly sent = output<LimitRequest>();
  readonly closed = output<void>();

  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('closeButton');

  protected readonly state = signal<LimitRequestsState | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly asks = signal<readonly Ask[]>([]);
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  private nextId = 1;

  protected readonly limits = computed(() => this.state()?.limits ?? []);
  protected readonly durations = computed(() => this.state()?.durations ?? []);
  protected readonly requests = computed(() => this.state()?.requests ?? []);

  /** Limits already in a block: each can be asked for once. */
  protected readonly picked = computed(() => new Set(this.asks().map((a) => a.key)));

  /** The current value of each limit, as the "Now:" line under its select says it. */
  protected readonly nowText = computed(() => {
    const text = new Map<string, string>();
    for (const { key, now } of this.limits()) {
      text.set(
        key,
        now === null ? 'no limit' : now === 'plan' || (key === 'dailyLimit' && now === 0) ? "the plan's limit" : now.toLocaleString(),
      );
    }
    return text;
  });

  protected readonly canAdd = computed(
    () => this.asks().length < Math.min(MAX_ASKS, this.limits().length),
  );

  protected readonly valid = computed(() => {
    const asks = this.asks();
    return (
      asks.length > 0 &&
      this.picked().size === asks.length &&
      asks.every(
        (a) => a.key !== '' && Number.isInteger(a.value) && (a.value ?? 0) >= 1 && this.durations().includes(a.days),
      )
    );
  });

  protected readonly durationLabel = durationLabel;
  protected readonly askLine = askLine;
  protected readonly status = REQUEST_STATUS;

  constructor() {
    this.load();
    // An admin's answer changes the limits, which reaches open pages as `tenant` / `config`.
    this.store.watch(['tenant', 'config'], () => this.load(), 1000);
    // Focus moves into the dialog, so Tab and a screen reader start there.
    afterNextRender(() => this.closeButton()?.nativeElement.focus());
  }

  protected load(): void {
    this.loadError.set(null);
    this.api
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (state) => {
          this.state.set(state);
          if (!this.asks().length) this.add();
        },
        error: (err: Error) => {
          // A failed background refresh keeps the form and history already shown.
          if (!this.state()) this.loadError.set(err.message);
        },
      });
  }

  protected add(): void {
    if (!this.canAdd()) return;
    const key = this.limits().find((l) => !this.picked().has(l.key))?.key ?? '';
    const days = this.durations().includes(DEFAULT_DAYS) ? DEFAULT_DAYS : (this.durations()[0] ?? 0);
    this.asks.update((asks) => [...asks, { id: this.nextId++, key, value: null, days }]);
  }

  protected remove(id: number): void {
    this.asks.update((asks) => asks.filter((a) => a.id !== id));
  }

  protected patch(id: number, change: Partial<Omit<Ask, 'id'>>): void {
    this.asks.update((asks) => asks.map((a) => (a.id === id ? { ...a, ...change } : a)));
  }

  protected close(): void {
    if (!this.busy()) this.closed.emit();
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (this.busy() || !this.valid() || !(event.target as HTMLFormElement).reportValidity()) return;
    this.busy.set(true);
    this.error.set(null);
    this.api
      .create({
        items: this.asks().map((a) => ({ key: a.key as LimitKey, value: a.value ?? 0, days: a.days })),
        note: this.note().trim(),
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ request }) => {
          this.busy.set(false);
          this.sent.emit(request);
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }
}
