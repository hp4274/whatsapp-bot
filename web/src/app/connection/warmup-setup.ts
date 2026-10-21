import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { Api, AppConfig } from '../core/api';

/**
 * The tiers shown to a fresh number. They mirror TIERS in the server's
 * campaign/humanize.js; what is enforced always comes from the server, so a
 * stale figure here can only mislead the copy, never the limit.
 */
const TIERS: readonly {
  readonly n: number;
  readonly name: string;
  readonly perDay: string;
  readonly how: string;
}[] = [
  { n: 1, name: 'Warm-up', perDay: '250', how: 'Every new number starts here. Slow, spaced out.' },
  { n: 2, name: 'Growing', perDay: '2,000', how: 'Unlocks after 1,000 messages in a week.' },
  { n: 3, name: 'Established', perDay: '10,000', how: 'Unlocks after 5,000 messages in a week.' },
];

/**
 * Dialog asking whether the SIM is fresh, opened the moment a connection
 * succeeds. A new number sent to at full speed is banned fast, so a fresh one
 * is offered the tier warm-up. Skipping (either question, or Escape) sends to
 * the plan's limits with the tier system off. Opened again later from the
 * connection card (`isLater`), it starts at the tiers and can be cancelled.
 */
@Component({
  selector: 'app-warmup-setup',
  templateUrl: './warmup-setup.html',
  styleUrl: './warmup-setup.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(keydown.escape)': 'escape()' },
})
export class WarmupSetup {
  private readonly api = inject(Api);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host: ElementRef<HTMLElement> = inject(ElementRef);

  /** Opened from the connection card instead of by a fresh connection. */
  readonly isLater = input(false);
  /** Warm-up is on right now, so the way out is labelled as leaving it. */
  readonly warmingUp = input(false);
  /** The saved config once an answer is stored. */
  readonly answered = output<AppConfig>();
  /** Closed without changing anything (only when `isLater`). */
  readonly dismissed = output<void>();

  protected readonly tiers = TIERS;
  protected readonly stage = signal<'ask' | 'tiers'>('ask');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    afterNextRender(() => {
      if (this.isLater()) this.stage.set('tiers');
      this.host.nativeElement.querySelector('button')?.focus();
    });
  }

  protected escape(): void {
    if (this.busy()) return;
    if (this.isLater()) this.dismissed.emit();
    else this.choose('plan');
  }

  protected choose(choice: 'warmup' | 'plan'): void {
    this.busy.set(true);
    this.error.set(null);
    this.api
      .saveConfig({ warmupChoice: choice, tierSystem: choice === 'warmup' })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        // The choice is forced onto the echo: a server that drops the unknown key
        // (an older build still running) would otherwise leave this dialog open for good.
        next: ({ config }) => {
          this.busy.set(false);
          this.answered.emit({ ...config, warmupChoice: choice, tierSystem: choice === 'warmup' });
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.busy.set(false);
        },
      });
  }
}
