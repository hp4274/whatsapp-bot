import { ChangeDetectionStrategy, Component, ElementRef, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

/** The page's sections in the bar, in page order; `id` is the section's anchor. */
const LINKS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'features', label: 'Bulk messaging' },
  { id: 'safety', label: 'Safety' },
  { id: 'replies', label: 'Replies' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'faq', label: 'FAQ' },
];

/**
 * The landing page's bar, after Kardlyz's marketing header: a floating bar inset
 * over the hero panel, bare (white type on the navy) at the top and frosted once
 * the page moves. Below `lg` the section links fold into a panel under the bar,
 * opened by the round menu button; Escape or a press outside closes it.
 *
 * In-page links are plain `#id` anchors; the landing page glides them with Lenis.
 */
@Component({
  selector: 'app-landing-nav',
  imports: [RouterLink],
  templateUrl: './landing-nav.html',
  styleUrl: './landing-nav.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:scroll)': 'onScroll()',
    '(document:keydown.escape)': 'menuOpen.set(false)',
    '(document:pointerdown)': 'onPointerDown($event)',
  },
})
export class LandingNav {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  /** The section on screen, for the link highlight. */
  readonly active = input('');

  protected readonly links = LINKS;
  /** Off the top of the page: the bar frosts so it reads over any section. */
  protected readonly scrolled = signal(false);
  protected readonly menuOpen = signal(false);

  protected onScroll(): void {
    this.scrolled.set(window.scrollY > 12);
  }

  /** A press outside the bar and its panel closes the panel, as Kardlyz's does. */
  protected onPointerDown(event: PointerEvent): void {
    if (this.menuOpen() && !this.host.contains(event.target as Node | null)) this.menuOpen.set(false);
  }
}
