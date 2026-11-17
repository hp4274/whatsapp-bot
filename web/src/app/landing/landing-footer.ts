import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** The landing page's sections the footer points to, in reading order; `id` is the section's anchor. */
const LINKS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'features', label: 'Bulk messaging' },
  { id: 'how', label: 'How it works' },
  { id: 'safety', label: 'Safety' },
  { id: 'explore', label: 'All features' },
  { id: 'access', label: 'Free Access' },
  { id: 'faq', label: 'FAQ' },
];

/**
 * The ink close every public page ends on: one last ask, the giant wordmark and the footer links.
 * Shared by the landing page and the blog, so a reader of a post can still reach every section.
 *
 * On the landing page (`inPage`) section links are plain `#id` anchors the page glides to; anywhere else
 * a bare `#id` would resolve against `<base href="/">` and reload the app, so they route to `/` with a fragment.
 */
@Component({
  selector: 'app-landing-footer',
  imports: [RouterLink],
  templateUrl: './landing-footer.html',
  styleUrl: './landing-footer.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LandingFooter {
  /** True on the landing page itself, where the sections are on this page. */
  readonly inPage = input(true);

  protected readonly links = LINKS;
  protected readonly year = new Date().getFullYear();
}
