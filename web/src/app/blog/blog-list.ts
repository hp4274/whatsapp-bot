import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

import { LandingFooter } from '../landing/landing-footer';
import { LandingNav } from '../landing/landing-nav';
import { PageMeta } from '../landing/page-meta';
import { BLOG_DESCRIPTION, BLOG_TITLE, POSTS, type Post, readingMinutes } from './posts';

/**
 * Every guide, newest first, under the landing page's nav and close, so the blog reads as part of the
 * public site. Each card is one link (the title's, stretched over the card) so a screen reader hears it once.
 */
@Component({
  selector: 'app-blog-list',
  imports: [DatePipe, RouterLink, LandingFooter, LandingNav],
  templateUrl: './blog-list.html',
  styleUrl: './blog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlogList {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly posts: readonly Post[] = [...POSTS].sort((a, b) => b.published.localeCompare(a.published));
  protected readonly minutes = readingMinutes;

  constructor() {
    const meta = inject(PageMeta);
    meta.set({ title: BLOG_TITLE, description: BLOG_DESCRIPTION, path: '/blog' });
    inject(DestroyRef).onDestroy(() => meta.clear());
    // The router keeps the last page's scroll (no scroll restoration in app.config.ts); a fresh load keeps the browser's.
    if (inject(Router).navigated) afterNextRender(() => window.scrollTo(0, 0));
  }

  /** The bare `#main` would resolve against `<base href="/">` and open the landing page, so focus it here. */
  protected skip(event: Event): void {
    event.preventDefault();
    this.host.querySelector<HTMLElement>('#main')?.focus();
  }

  /** The guide a card shows as its picture: the post's first sample message. */
  protected sample(post: Post): string {
    for (const block of post.body) if (block.kind === 'example') return block.text;
    return post.description;
  }
}
