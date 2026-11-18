import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { Guide } from './guides';

/**
 * The written guide beside a page (the shell opens it from the panel's top-right "Guide" button). It only reads:
 * every task with numbered steps, folded so the list stays scannable, the first one open. It never closes on its own
 * - clicks in the page leave it open, so the user can follow the steps while doing them; the shell keeps it open
 * across reloads.
 */
@Component({
  selector: 'app-page-guide',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let g = guide();
    <header class="head">
      <span class="badge" aria-hidden="true"><i class="ti ti-book-2"></i></span>
      <div class="grow">
        <h2 id="guide-title">{{ g.title }}</h2>
        <p>{{ g.intro }}</p>
      </div>
      <button type="button" class="x" aria-label="Close the guide" (click)="closed.emit()">
        <i class="ti ti-x" aria-hidden="true"></i>
      </button>
    </header>

    <ol class="tasks">
      @for (t of g.tasks; track t.title; let i = $index) {
        <li>
          <details name="guide-task" [open]="i === 0">
            <summary>
              <span class="n" aria-hidden="true">{{ i + 1 }}</span>
              <span class="grow">{{ t.title }}</span>
              <i class="ti ti-chevron-down chev" aria-hidden="true"></i>
            </summary>
            <ol class="steps">
              @for (s of t.steps; track $index) {
                <li>{{ s }}</li>
              }
            </ol>
            @if (t.tip) {
              <p class="tip"><i class="ti ti-bulb" aria-hidden="true"></i>{{ t.tip }}</p>
            }
          </details>
        </li>
      }
    </ol>
  `,
  styleUrl: './page-guide.scss',
  host: { role: 'complementary', '[attr.aria-labelledby]': '"guide-title"' },
})
export class PageGuide {
  readonly guide = input.required<Guide>();
  readonly closed = output<void>();
}
