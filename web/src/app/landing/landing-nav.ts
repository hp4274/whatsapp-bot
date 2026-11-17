import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, input, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { Auth } from '../core/auth';

/** The page's sections in the bar, in page order; `id` is the section's anchor. */
const LINKS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'explore', label: 'All features' },
  { id: 'features', label: 'Bulk messaging' },
  { id: 'safety', label: 'Safety' },
  // { id: 'pricing', label: 'Pricing' }, // the pricing section is hidden for now (landing.html)
  { id: 'faq', label: 'FAQ' },
];

/**
 * The landing page's bar, after Kardlyz's marketing header: a floating bar inset
 * over the hero panel, bare (white type on the navy) at the top and frosted once
 * the page moves. Below `lg` the section links fold into a panel under the bar,
 * opened by the round menu button; Escape or a press outside closes it.
 *
 * On the landing page (`inPage`) section links are plain `#id` anchors the page glides to with Lenis. The blog
 * sets `inPage` false: there a bare `#id` resolves against `<base href="/">` and reloads the app, so the links
 * route to `/` with the fragment, and the landing page scrolls to it on arrival.
 */
@Component({
  selector: 'app-landing-nav',
  imports: [RouterLink, RouterLinkActive],
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
  private readonly auth = inject(Auth);

  /** The section on screen, for the link highlight. */
  readonly active = input('');
  /** True on the landing page, where the sections are on this page. */
  readonly inPage = input(true);

  /** Signed in: the bar's last link goes to the dashboard, not the sign-in form. */
  protected readonly signedIn = computed(() => !!this.auth.user());
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
