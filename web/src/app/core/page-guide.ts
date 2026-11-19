import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { GUIDE_SHOTS } from './guide-shots';
import { Guide, GUIDES } from './guides';

/**
 * The written guide beside a page (the shell opens it from the panel's top-right "Guide" button). It only reads:
 * every task with numbered steps, folded so the list stays scannable, the first one open. It never closes on its own
 * - clicks in the page leave it open, so the user can follow the steps while doing them; the shell keeps it open
 * across reloads. A step with a screenshot (GUIDE_SHOTS, made by server/scripts/guide-shots.mjs) shows it under its
 * words; clicking it opens the full-size image over the page, closed by its button, Esc or a click outside.
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
              @for (s of t.steps; track $index; let j = $index) {
                @let shot = key() + '/' + (i + 1) + '-' + (j + 1);
                <li>
                  {{ s }}
                  @if (shots.has(shot)) {
                    <button
                      type="button"
                      class="shot"
                      [attr.aria-label]="'Screenshot of step ' + (j + 1) + ', opens full size'"
                      (click)="zoom.set({ src: 'assets/guides/' + shot + '.webp', text: s }); viewer.showModal()"
                    >
                      <img [src]="'assets/guides/' + shot + '.webp'" alt="" width="760" height="475" loading="lazy" decoding="async" />
                    </button>
                  }
                </li>
              }
            </ol>
            @if (t.tip) {
              <p class="tip"><i class="ti ti-bulb" aria-hidden="true"></i>{{ t.tip }}</p>
            }
          </details>
        </li>
      }
    </ol>

    <!-- Native modal: Esc closes it and focus stays inside; a click on the backdrop (the dialog itself) closes too. -->
    <dialog
      #viewer
      class="viewer"
      aria-label="Screenshot"
      (click)="$event.target === viewer && viewer.close()"
      (close)="zoom.set(null)"
    >
      @if (zoom(); as z) {
        <figure>
          <img [src]="z.src" [alt]="z.text" width="760" height="475" />
          <figcaption>{{ z.text }}</figcaption>
        </figure>
      }
      <button type="button" class="x" aria-label="Close the screenshot" (click)="viewer.close()">
        <i class="ti ti-x" aria-hidden="true"></i>
      </button>
    </dialog>
  `,
  styleUrl: './page-guide.scss',
  host: { role: 'complementary', '[attr.aria-labelledby]': '"guide-title"' },
})
export class PageGuide {
  readonly guide = input.required<Guide>();
  readonly closed = output<void>();

  protected readonly shots = GUIDE_SHOTS;
  /** The screenshot shown full size, with its step's words as the caption. */
  protected readonly zoom = signal<{ src: string; text: string } | null>(null);
  /** The guide's key in GUIDES: the screenshots' folder. */
  protected readonly key = computed(() => Object.keys(GUIDES).find((k) => GUIDES[k] === this.guide()) ?? '');
}
