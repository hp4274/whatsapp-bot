import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { LandingFooter } from '../landing/landing-footer';
import { LandingNav } from '../landing/landing-nav';
import { PageMeta } from '../landing/page-meta';
import {
  OTP_ENDPOINTS,
  OTP_ERRORS,
  OTP_LANGS,
  OTP_STATUSES,
  SampleLang,
  VERIFY_REASONS,
  codeSamples,
  printOtpGuide,
} from './otp-text';

/**
 * The WhatsApp OTP API guide at `/docs/whatsapp-otp-api`, open to anyone (no sign-in), so a business can send its
 * developer one link. The same reference the signed-in OTP page shows (otp-text.ts), with the landing page's look.
 * It names no account: the limits and keys live on the business's own OTP page.
 */
@Component({
  selector: 'app-otp-docs',
  imports: [RouterLink, LandingFooter, LandingNav],
  templateUrl: './otp-docs.html',
  styleUrls: ['../blog/blog.scss', './otp-docs.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class OtpDocs {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly origin = typeof location === 'undefined' ? '' : location.origin;

  protected readonly apiBase = `${this.origin}/api/v1`;
  protected readonly endpoints = OTP_ENDPOINTS;
  protected readonly reasons = VERIFY_REASONS;
  protected readonly statuses = OTP_STATUSES;
  protected readonly errors = OTP_ERRORS;
  protected readonly langs = OTP_LANGS;
  protected readonly lang = signal<SampleLang>('curl');
  protected readonly sample = computed(() => codeSamples(this.origin)[this.lang()]);
  protected readonly copied = signal(false);

  constructor() {
    const meta = inject(PageMeta);
    meta.set({
      title: 'WhatsApp OTP API - Wuzie',
      description: 'Send one-time codes to your customers on WhatsApp from your own app or website, and verify them: the Wuzie OTP API reference with examples.',
      path: '/docs/whatsapp-otp-api',
      type: 'article',
    });
    inject(DestroyRef).onDestroy(() => meta.clear());
  }

  protected download(): void {
    printOtpGuide({ base: this.origin });
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.sample());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // The code stays on screen to select by hand.
    }
  }

  /** The bare `#main` would resolve against `<base href="/">` and open the landing page, so focus it here. */
  protected skip(event: Event): void {
    event.preventDefault();
    this.host.querySelector<HTMLElement>('#main')?.focus();
  }
}
