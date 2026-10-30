import {
  ChangeDetectionStrategy,
  booleanAttribute,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { ChannelsApi, NumberStart, NumberStartBody, NumberStartResult } from '../core/api';
import { Store } from '../core/store';

/** Answer labels in the server's order: the index (0-3) is what gets posted. */
const AGE_CHOICES: readonly string[] = ['Under 1 month', '1–6 months', '6–24 months', '2+ years'];
const USAGE_CHOICES: readonly string[] = [
  'New or hardly used',
  'Light personal use',
  'Regular daily chats',
  'Busy business number',
];

/**
 * The 2 questions a newly linked QR number answers before it sends in bulk.
 *
 * An old, busy number can start at a higher daily limit than a fresh SIM, and
 * only the business knows which it linked. Bulk is held until the questions are
 * answered or knowingly skipped, so skipping asks for an explicit acceptance of
 * the ban risk; the server records that acceptance. A 409 means someone else
 * answered first, which is treated as done rather than as an error.
 */
@Component({
  selector: 'app-number-questions',
  templateUrl: './number-questions.html',
  styleUrl: './number-questions.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  // Nothing to ask: the host collapses so a parent's card around it does not show empty.
  // A popup lives in the top layer, so its host takes no room (and must not be display: none).
  host: { '[style.display]': "blank() ? 'none' : popup() ? 'contents' : null" },
})
export class NumberQuestions {
  private readonly api = inject(ChannelsApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dialogRef = viewChild<ElementRef<HTMLDialogElement>>('dialog');
  private readonly resultRef = viewChild<ElementRef<HTMLElement>>('resultCard');
  private readonly askRef = viewChild<ElementRef<HTMLDialogElement>>('ask');

  readonly channelId = input.required<number>();
  /** Ask in a modal that opens by itself (right after linking) instead of inline. */
  readonly popup = input(false, { transform: booleanAttribute });
  /** The questions are settled (answered, skipped or answered elsewhere): the parent should refresh. */
  readonly done = output<NumberStartResult>();

  protected readonly ageChoices = AGE_CHOICES;
  protected readonly usageChoices = USAGE_CHOICES;

  protected readonly info = signal<NumberStart | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly age = signal<number | null>(null);
  protected readonly usage = signal<number | null>(null);
  protected readonly saving = signal(false);
  protected readonly saveError = signal<string | null>(null);
  /** Set once the start is applied; `already` when another session answered first. */
  protected readonly result = signal<NumberStartResult | null>(null);

  protected readonly skipOpen = signal(false);
  protected readonly accepted = signal(false);
  protected readonly skipError = signal<string | null>(null);

  /** Answered before this view opened: nothing to show. */
  protected readonly blank = computed(
    () => !this.loading() && !this.error() && !this.result() && !!this.info()?.asked,
  );
  /** Closed with Later or Done: the popup stays shut until the page is opened again. */
  protected readonly dismissed = signal(false);
  /** The popup is up while there is something to ask, an error, or the outcome to read. */
  protected readonly askOpen = computed(
    () => this.popup() && !this.loading() && !this.blank() && !this.dismissed(),
  );
  protected readonly canSubmit = computed(
    () => this.age() !== null && this.usage() !== null && !this.saving(),
  );
  /** The second sentence only makes sense while the limit still has room to grow. */
  protected readonly grows = computed(() => {
    const r = this.result();
    return !!r && r.todayLimit !== null && r.planLimit !== null && r.planLimit > r.todayLimit;
  });

  constructor() {
    effect(() => {
      const id = this.channelId();
      untracked(() => this.load(id));
    });
    // Answered or skipped in another session (a /api/channels write): the popup closes here too.
    inject(Store).watch(['channels'], () => {
      if (!this.saving() && !this.result()) this.load(this.channelId(), true);
    });
    // The native <dialog> gives focus trapping and Escape for free; it just needs opening.
    effect(() => {
      const dialog = this.dialogRef()?.nativeElement;
      if (!dialog) return;
      if (this.skipOpen() && !dialog.open) dialog.showModal();
      if (!this.skipOpen() && dialog.open) dialog.close();
    });
    effect(() => {
      const ask = this.askRef()?.nativeElement;
      if (!ask) return;
      if (this.askOpen() && !ask.open) ask.showModal();
      if (!this.askOpen() && ask.open) ask.close();
    });
    // The form (and its focused button or the dialog) is gone once settled: focus the outcome instead.
    effect(() => this.resultRef()?.nativeElement.focus());
  }

  /** Also the error banner's Try again. `quiet` keeps what shows while it reloads (a live update). */
  protected load(id = this.channelId(), quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set(null);
    this.api
      .startInfo(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) => {
          this.info.set(info);
          // Pre-select from the chat history, never over a choice already made; the business still confirms.
          if (info.suggested && this.age() === null && this.usage() === null) {
            this.age.set(info.suggested.age);
            this.usage.set(info.suggested.usage);
          }
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.loading.set(false);
          this.error.set(`Could not load the questions: ${err.message}`);
        },
      });
  }

  protected submit(event: Event): void {
    event.preventDefault();
    const age = this.age();
    const usage = this.usage();
    if (age === null || usage === null) return;
    this.send({ age, usage }, this.saveError);
  }

  protected openSkip(): void {
    this.accepted.set(false);
    this.skipError.set(null);
    this.skipOpen.set(true);
  }

  /** Native close (Escape) and Cancel both land here; both are held off while a skip is saving. */
  protected closeSkip(): void {
    this.skipOpen.set(false);
  }

  protected confirmSkip(event: Event): void {
    event.preventDefault();
    if (!this.accepted()) return;
    this.send({ skip: true, accept: true }, this.skipError);
  }

  private send(body: NumberStartBody, errorSlot: WritableSignal<string | null>): void {
    this.saving.set(true);
    errorSlot.set(null);
    this.api
      .start(this.channelId(), body)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => (res.already ? this.settleAlready() : this.settle(res)),
        error: (err: Error) => {
          this.saving.set(false);
          errorSlot.set(err.message);
        },
      });
  }

  private settle(res: NumberStartResult): void {
    this.saving.set(false);
    this.skipOpen.set(false);
    this.result.set(res);
    this.done.emit(res);
  }

  /** Answered elsewhere first: read the limits it started at, so the card still says something true. */
  private settleAlready(): void {
    this.api
      .startInfo(this.channelId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (info) =>
          this.settle({ todayLimit: info.todayLimit, planLimit: info.planLimit, already: true }),
        error: () => this.settle({ todayLimit: null, planLimit: null, already: true }),
      });
  }
}
