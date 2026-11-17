import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { Router, RouterLink } from '@angular/router';

import { LandingFooter } from '../landing/landing-footer';
import { LandingNav } from '../landing/landing-nav';
import { PageMeta } from '../landing/page-meta';
import { POSTS, readingMinutes } from './posts';

/**
 * One guide at `/blog/:slug`: the title in the ink header panel, the body in a reading column, ways to share it,
 * and the other guides. An unknown slug shows a not-found page with the way back, not a redirect, so a mistyped
 * link says what happened.
 *
 * The router reuses this component from one guide to the next, so the title, tags and scroll follow `slug`.
 */
@Component({
  selector: 'app-blog-post',
  imports: [DatePipe, RouterLink, LandingFooter, LandingNav],
  templateUrl: './blog-post.html',
  styleUrl: './blog.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BlogPost {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly router = inject(Router);

  /** From the route (`withComponentInputBinding`). */
  readonly slug = input.required<string>();

  protected readonly post = computed(() => POSTS.find((p) => p.slug === this.slug()) ?? null);
  protected readonly others = computed(() => POSTS.filter((p) => p.slug !== this.slug()));
  protected readonly minutes = readingMinutes;
  /** "Copy link" says it worked until the reader moves to another guide. */
  protected readonly copied = linkedSignal({ source: this.slug, computation: () => false });

  /** This guide's address on the current site, for sharing. */
  protected readonly url = computed(() => `${location.origin}/blog/${this.slug()}`);
  protected readonly whatsappShare = computed(
    () => `https://wa.me/?text=${encodeURIComponent(`${this.post()?.title ?? 'Wuzie blog'} ${this.url()}`)}`,
  );

  constructor() {
    const meta = inject(PageMeta);
    inject(DestroyRef).onDestroy(() => meta.clear());
    // A fresh load keeps the browser's own scroll; arriving by a link starts at the top (no scroll restoration).
    let first = !this.router.navigated;
    effect(() => {
      const post = this.post();
      meta.set(
        post
          ? { title: `${post.title} - Wuzie`, description: post.description, path: `/blog/${post.slug}`, type: 'article' }
          : { title: 'Guide not found - Wuzie', description: 'This guide does not exist or has moved.', path: '/blog', noindex: true },
      );
      if (!first) window.scrollTo(0, 0);
      first = false;
    });
  }

  /** The bare `#main` would resolve against `<base href="/">` and open the landing page, so focus it here. */
  protected skip(event: Event): void {
    event.preventDefault();
    this.host.querySelector<HTMLElement>('#main')?.focus();
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.url());
      this.copied.set(true);
    } catch {
      // Clipboard refused (an insecure origin or a denied permission): the address bar still has the link.
      this.copied.set(false);
    }
  }
}
