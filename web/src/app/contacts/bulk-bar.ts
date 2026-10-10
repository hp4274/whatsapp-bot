import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

import { BulkAction } from '../core/api';
import { splitTags } from './contact-util';

/** What the bar asks the page to run; the page decides ids vs. filter. */
export interface BulkRequest {
  action: BulkAction;
  tags?: string[];
  reason?: string;
}

type Mode = '' | BulkAction;

/**
 * The action bar that slides in over the table while rows are selected.
 * Anything that changes consent or deletes asks inline before it runs.
 */
@Component({
  selector: 'app-bulk-bar',
  imports: [FormsModule],
  templateUrl: './bulk-bar.html',
  styleUrl: './bulk-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BulkBar {
  readonly count = input.required<number>();
  readonly total = input(0);
  readonly allMatching = input(false);
  readonly pageAll = input(false);
  readonly busy = input(false);
  readonly knownTags = input<{ tag: string; count: number }[]>([]);

  readonly run = output<BulkRequest>();
  readonly export = output<void>();
  readonly selectAll = output<void>();
  readonly clear = output<void>();

  /** The action whose inline confirm/input step is open, or '' for none. */
  protected readonly mode = signal<Mode>('');
  protected readonly text = signal('');
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  constructor() {
    // Put the caret where the user is about to type.
    effect(() => {
      if (this.mode()) queueMicrotask(() => this.field()?.nativeElement.focus());
    });
  }

  protected start(mode: Mode) {
    this.mode.set(this.mode() === mode ? '' : mode);
    this.text.set('');
  }

  protected submit(event?: Event) {
    event?.preventDefault();
    const mode = this.mode();
    if (!mode) return;
    if (mode === 'addTags' || mode === 'removeTags') {
      const tags = splitTags(this.text());
      if (!tags.length) return;
      this.run.emit({ action: mode, tags });
    } else if (mode === 'optOut') {
      this.run.emit({ action: mode, reason: this.text().trim() || 'manual' });
    } else {
      this.run.emit({ action: mode });
    }
    this.mode.set('');
    this.text.set('');
  }

  protected cancel() {
    this.mode.set('');
    this.text.set('');
  }

  protected readonly plural = (n: number) => `${n.toLocaleString()} contact${n === 1 ? '' : 's'}`;
}
