import { DOCUMENT, Injectable, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';

/** What a public page tells search engines and link previews about itself. */
export interface PageInfo {
  readonly title: string;
  readonly description: string;
  /** The page's own path, such as `/blog/some-post`; the canonical URL is this on the current origin. */
  readonly path: string;
  readonly type?: 'website' | 'article';
  /** A not-found view: answers as a normal page, so it asks search engines not to index the address. */
  readonly noindex?: boolean;
}

/**
 * Title, description, Open Graph tags and the canonical link for the public pages (landing and blog).
 *
 * The app shell never sets these, so a public page clears them when it goes (`clear`): a stale canonical
 * pointing at a blog post must not follow the visitor to the sign-in screen.
 *
 * shortcut: the tags are set in the browser. Google renders JavaScript and reads them; WhatsApp and Facebook
 * link previews do not, and see only index.html. Prerender the public routes if previews must show each post.
 */
@Injectable({ providedIn: 'root' })
export class PageMeta {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly doc = inject(DOCUMENT);

  set(page: PageInfo): void {
    const url = this.doc.location.origin + page.path;
    this.title.setTitle(page.title);
    this.meta.updateTag({ name: 'description', content: page.description });
    this.meta.updateTag({ property: 'og:title', content: page.title });
    this.meta.updateTag({ property: 'og:description', content: page.description });
    this.meta.updateTag({ property: 'og:type', content: page.type ?? 'website' });
    this.meta.updateTag({ property: 'og:url', content: url });
    this.meta.updateTag({ property: 'og:site_name', content: 'Wuzie' });
    this.canonical().href = url;
    if (page.noindex) this.meta.updateTag({ name: 'robots', content: 'noindex' });
    else this.meta.removeTag('name="robots"');
  }

  clear(): void {
    for (const selector of ['name="description"', 'property="og:title"', 'property="og:description"', 'property="og:type"', 'property="og:url"', 'property="og:site_name"', 'name="robots"']) {
      this.meta.removeTag(selector);
    }
    this.doc.head.querySelector('link[rel="canonical"]')?.remove();
  }

  private canonical(): HTMLLinkElement {
    const found = this.doc.head.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (found) return found;
    const link = this.doc.createElement('link');
    link.rel = 'canonical';
    this.doc.head.appendChild(link);
    return link;
  }
}
