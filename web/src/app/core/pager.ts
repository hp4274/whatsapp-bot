import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

/** The page index actually shown: a list that shrank (filter, delete, live reload) never leaves an empty page. */
export function clampPage(page: number, total: number, size: number): number {
  return Math.min(Math.max(0, page), Math.max(0, Math.ceil(total / size) - 1));
}

/** One page of `items`; pair it with `<app-pager>` bound to the same page signal. */
export function pageOf<T>(items: readonly T[], page: number, size: number): T[] {
  const start = clampPage(page, items.length, size) * size;
  return items.slice(start, start + size);
}

/**
 * The list footer the campaigns list started with, shared: "11–20 of 84" and first, previous, next and last.
 * It hides itself while everything fits on one page. Reset `page` to 0 when a filter changes
 * (`linkedSignal(() => { this.filter(); return 0; })`), so a new search starts at the top.
 */
@Component({
  selector: 'app-pager',
  template: `
    @if (total() > size()) {
      <nav class="pager" [attr.aria-label]="label()">
        <span class="range">{{ from() }}&ndash;{{ to() }} of {{ total() }}</span>
        <div class="btns">
          <button class="btn ghost" type="button" aria-label="First page" [disabled]="at() === 0" (click)="go(0)">
            <i class="ti ti-chevrons-left" aria-hidden="true"></i>
          </button>
          <button class="btn ghost" type="button" aria-label="Previous page" [disabled]="at() === 0" (click)="go(at() - 1)">
            <i class="ti ti-chevron-left" aria-hidden="true"></i>
          </button>
          <span class="no" aria-live="polite">Page {{ at() + 1 }} of {{ count() }}</span>
          <button class="btn ghost" type="button" aria-label="Next page" [disabled]="at() >= count() - 1" (click)="go(at() + 1)">
            <i class="ti ti-chevron-right" aria-hidden="true"></i>
          </button>
          <button class="btn ghost" type="button" aria-label="Last page" [disabled]="at() >= count() - 1" (click)="go(count() - 1)">
            <i class="ti ti-chevrons-right" aria-hidden="true"></i>
          </button>
        </div>
      </nav>
    }
  `,
  styles: `
    .pager {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-sm);
      padding: 10px 4px 4px;
      font-size: 12.5px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }
    .btns { display: flex; align-items: center; gap: 2px; }
    .no { padding: 0 8px; }
    .btn { width: 34px; min-height: 34px; padding: 0; background: transparent; border-color: transparent; }
    @media (max-width: 720px) { .pager { justify-content: center; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Pager {
  readonly total = input.required<number>();
  readonly size = input.required<number>();
  readonly page = model.required<number>();
  /** Names the nav for screen readers when a screen has more than one list. */
  readonly label = input('Pages');

  protected readonly count = computed(() => Math.max(1, Math.ceil(this.total() / this.size())));
  protected readonly at = computed(() => clampPage(this.page(), this.total(), this.size()));
  protected readonly from = computed(() => this.at() * this.size() + 1);
  protected readonly to = computed(() => Math.min(this.total(), (this.at() + 1) * this.size()));

  protected go(page: number): void {
    this.page.set(clampPage(page, this.total(), this.size()));
  }
}
