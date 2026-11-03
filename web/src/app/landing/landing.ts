import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import Lenis from 'lenis';
import { animate, inView, scroll, stagger } from 'motion';

import { Tilt } from '../school/tilt';
import { ChatPreview } from './chat-preview';
import { LandingNav } from './landing-nav';
import { LeadForm } from './lead-form';
import { CountUp, EASE_OUT, FanOut, Reveal, SPRING, still } from './motion';

/** The hero's slides: a photo of customers getting a message, with its own headline and line. */
const SLIDES: readonly { readonly image: string; readonly who: string; readonly title: string; readonly lede: string }[] = [
  {
    image: 'hero-shop.jpg',
    who: 'a clothes shop',
    title: 'Send bulk WhatsApp messages',
    lede: 'Reach every customer at once from the WhatsApp number you already use. Each message carries the person’s name, goes out at a careful pace that protects your number, and every reply lands in one shared inbox.',
  },
  {
    image: 'hero-studio.jpg',
    who: 'a pottery studio',
    title: 'Remind every class at once',
    lede: 'Class times, changes and fee reminders reach every student by name, from the number they already know, and their replies come back to one inbox.',
  },
  {
    image: 'hero-music.jpg',
    who: 'a music club',
    title: 'Fill every seat on Saturday',
    lede: 'Announce the line-up to your whole list with the poster and a booking link. Each message greets them by name and goes out at a pace that keeps your number safe.',
  },
  {
    image: 'hero-campus.jpg',
    who: 'a campus club',
    title: 'Reach every member on campus',
    lede: 'Passes, schedules and reminders go out to every student in one send, each with their own name, and every reply lands in one shared inbox.',
  },
];

/** How long each hero slide stays up. */
const SLIDE_MS = 4000;

/** Everything beyond bulk sending, grouped the way the app's sidebar groups them; `tone` picks the tint and the picture. */
const FACILITIES: readonly {
  readonly heading: string;
  readonly tone: 'blue' | 'green' | 'violet';
  readonly items: readonly { readonly icon: string; readonly name: string; readonly text: string }[];
}[] = [
  {
    heading: 'Messaging',
    tone: 'blue',
    items: [
      { icon: 'device-mobile', name: 'Multiple numbers', text: 'Manage sales and support from one login.' },
      { icon: 'file-text', name: 'Message templates', text: 'Save and reuse frequent replies.' },
      { icon: 'school', name: 'School assistant', text: 'Handle fee notices and parent questions.' },
    ],
  },
  {
    heading: 'Customers',
    tone: 'green',
    items: [
      { icon: 'user', name: 'Contacts', text: 'Keep each customer’s message history together.' },
      { icon: 'credit-card', name: 'Payment reminders', text: 'Follow up on invoices until they’re paid.' },
      { icon: 'calendar', name: 'Appointments', text: 'Remind customers the day before a booking.' },
    ],
  },
  {
    heading: 'Team & integrations',
    tone: 'violet',
    items: [
      { icon: 'hierarchy-3', name: 'Workflows', text: 'Automate thank-yous and follow-ups.' },
      { icon: 'code', name: 'API & webhooks', text: 'Send messages and receive replies in your software.' },
      { icon: 'users', name: 'Team roles', text: 'Set access for agents, admins and owners.' },
    ],
  },
];

/** The Messaging picture: one login, several linked numbers. */
const NUMBERS = [
  { icon: 'shopping-bag', tone: 'green', name: 'Sales', phone: '+91 98200 45678' },
  { icon: 'headset', tone: 'blue', name: 'Support', phone: '+91 98200 76543' },
  { icon: 'file-invoice', tone: 'yellow', name: 'Accounts', phone: '+91 98200 10987' },
] as const;

/** Who it is for; the agency line is the multi-business tenancy the platform is built on. */
const AUDIENCES: readonly { readonly icon: string; readonly name: string; readonly text: string }[] = [
  { icon: 'building-store', name: 'Shops and online brands', text: 'Sale announcements, new arrivals and order updates to every customer at once.' },
  { icon: 'school', name: 'Schools and coaching', text: 'Fee reminders, holiday notices and results to every parent, each with their child’s name.' },
  { icon: 'stethoscope', name: 'Clinics and services', text: 'Tomorrow’s appointment reminders sent in one go, confirmations collected by reply.' },
  { icon: 'briefcase', name: 'Agencies', text: 'Run bulk campaigns for many clients, each on its own number with its own contacts.' },
];

/**
 * Pricing is hidden for now (the section is commented out in landing.html); kept so it can come back as it was.
 *
 * The default plan catalogue, mirrored from `server/src/billing/plans.js`.
 * shortcut: an operator can override a plan in the database and this will not follow; add a public
 * plans endpoint if prices start to be edited there.
 */
const PLANS: readonly {
  readonly name: string;
  readonly price: string;
  readonly per: string;
  readonly text: string;
  readonly featured: boolean;
  readonly items: readonly string[];
}[] = [
  {
    name: 'Starter',
    price: '₹999',
    per: 'a month',
    text: 'For a single shop getting started.',
    featured: false,
    items: [
      '1,000 messages a month',
      '1,000 contacts, up to 1,000 per campaign',
      '1 WhatsApp number, 2 team members',
      'Auto-replies, templates and shared inbox',
    ],
  },
  {
    name: 'Business',
    price: '₹2,999',
    per: 'a month',
    text: 'For a growing team sending every week.',
    featured: true,
    items: [
      '25,000 messages a month',
      '25,000 contacts, up to 25,000 per campaign',
      '5 WhatsApp numbers, 15 team members',
      'Payment reminders, tickets and appointments',
      'Workflows, analytics and the API',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    per: 'per contract',
    text: 'Every service, no limits.',
    featured: false,
    items: [
      'Unlimited messages, numbers and contacts',
      'Every service, including AI and the school assistant',
      'Sending limits tuned to your numbers',
    ],
  },
];

const FAQS: readonly { readonly q: string; readonly a: string }[] = [
  {
    q: 'How many messages can I send a day?',
    a: 'It depends on your number. A new number starts with a small daily limit that grows as the number becomes established, up to 1,000 a day per number. Add more numbers to send more. Your plan sets the monthly total.',
  },
  {
    q: 'Will my number get banned?',
    a: 'No tool can promise that. Wapzo lowers the risk: it caps how much a number sends a day, leaves random gaps between messages, holds bulk sends in your quiet hours and pauses a campaign when too many messages fail.',
  },
  {
    q: 'Do I need the WhatsApp Business API?',
    a: 'No. You link the WhatsApp or WhatsApp Business number you already use by scanning a QR code, the same way WhatsApp Web works. There is no Meta approval to wait for.',
  },
  {
    q: 'Can I send images, PDFs and buttons?',
    a: 'Text, images, documents and video, yes. Native WhatsApp buttons and lists are not available on linked numbers, so options are numbered replies your customers answer with a digit.',
  },
  {
    q: 'What happens when people reply?',
    a: 'Replies land in the shared inbox, where your team answers them, and auto-replies can answer common questions straight away.',
  },
  {
    q: 'How do I get an account?',
    a: 'Accounts are set up for you. Request access, tell us about your business, and we create your workspace and send the sign-in details. Every paid plan starts with a 14-day free trial.',
  },
];

/** The how-it-works QR tile: 9x9, with the three corner finder blocks a real code has. Decorative. */
const QR: readonly number[] = [
  '111010111',
  '101001101',
  '111010111',
  '000110000',
  '101101101',
  '010010110',
  '111011010',
  '101001101',
  '111010111',
]
  .join('')
  .split('')
  .map(Number);

/** Where the FAQ's "Write to us" goes; account requests use the form (LeadForm). */
const CONTACT_EMAIL = 'connection@zarklyx.com';

/**
 * The public front page for a visitor from search: Wapzo is bulk WhatsApp
 * messaging first, so the hero shows customers getting their message, and the replies,
 * inbox and the rest follow. Signed-in users never see it (`landingGuard`).
 *
 * Colour follows 60-30-10 on the dashboard's tokens: the ground and cards are
 * the 60, the brand navy fields (hero, safety, close) the 30, the brand blue
 * only on actions and live state the 10.
 *
 * Motion (the `motion` package) drives the scroll work: the reading bar, the
 * nav marking the section on screen, the hero's spring entrance and every
 * section's reveal. Lenis smooths the page's scrolling, in-page links included (`jump`).
 */
@Component({
  selector: 'app-landing',
  imports: [RouterLink, Reveal, FanOut, CountUp, Tilt, ChatPreview, LandingNav, LeadForm],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(click)': 'jump($event)' },
})
export class Landing {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly slides = SLIDES;
  /** The hero slide on show, and the one sliding out to the left as it comes in. */
  protected readonly slide = signal(0);
  protected readonly prev = signal(-1);
  private timer?: ReturnType<typeof setInterval>;
  protected readonly facilities = FACILITIES;
  protected readonly numbers = NUMBERS;
  protected readonly audiences = AUDIENCES;
  protected readonly plans = PLANS;
  protected readonly faqs = FAQS;
  protected readonly qr = QR;
  protected readonly year = new Date().getFullYear();
  /** The section on screen, for the nav's highlight. */
  protected readonly active = signal('');

  /** Smooth scrolling for this page only; it is torn down on leaving, as the app shell scrolls its own panel. */
  private lenis: Lenis | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      // Lenis honours reduced motion by itself: scrolling then tracks the input 1:1 and jumps are instant.
      this.lenis = new Lenis({ autoRaf: true });
      destroyRef.onDestroy(() => this.lenis?.destroy());

      // A band across the middle of the screen: whichever section crosses it is "current".
      // The callback returns a leave handler: without one, inView stops watching after the first entry.
      const stops = [...this.el.querySelectorAll<HTMLElement>('section[id]')].map((s) =>
        inView(
          s,
          () => {
            this.active.set(s.id);
            return () => undefined;
          },
          { margin: '-45% 0px -45% 0px' },
        ),
      );
      // Reduced motion keeps the slider still; the dots still switch it.
      if (!still()) this.autoplay();
      destroyRef.onDestroy(() => clearInterval(this.timer));

      if (!still()) {
        const bar = this.el.querySelector('.progress');
        if (bar) stops.push(scroll(animate(bar, { scaleX: [0, 1] }, { ease: 'linear' })));
        // The hero's first slide: the headline wipes up out of a mask, the rest rises after it.
        const h1 = this.el.querySelector('h1');
        if (h1) animate(h1, { clipPath: ['inset(-10% -4% 100% -4%)', 'inset(-10% -4% -12% -4%)'], y: [28, 0] }, { duration: 0.9, ease: EASE_OUT });
        animate(this.el.querySelectorAll('.hero-copy > :not(h1)'), { opacity: [0, 1], y: [24, 0] }, { ...SPRING, delay: stagger(0.08, { startDelay: 0.25 }) });
        // The footer's wordmark rises into place as the close scrolls into view.
        const giant = this.el.querySelector('.giant');
        if (giant) stops.push(scroll(animate(giant, { y: ['45%', '0%'] }, { ease: 'linear' }), { target: giant, offset: ['start end', 'end end'] }));
      }
      destroyRef.onDestroy(() => stops.forEach((stop) => stop()));
    });
  }

  /** Shows hero slide `i`; a chosen slide gets its full time before the next one comes. */
  protected go(i: number): void {
    if (i === this.slide()) return;
    this.prev.set(this.slide());
    this.slide.set(i);
    if (this.timer !== undefined) this.autoplay();
  }

  private autoplay(): void {
    clearInterval(this.timer);
    this.timer = setInterval(() => document.hidden || this.go((this.slide() + 1) % SLIDES.length), SLIDE_MS);
  }

  /**
   * In-page links (`#id`) glide there with Lenis, landing below the floating bar. Lenis's own anchor option
   * would leave the browser's instant jump in place and skip the focus move the skip link exists for.
   */
  protected jump(event: MouseEvent): void {
    const link = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href^="#"]');
    const target = link && document.getElementById(link.hash.slice(1));
    if (!link || !target) return;
    event.preventDefault();
    // Lenis honours the section's scroll-margin-top (landing.scss), so it lands below the floating bar.
    if (this.lenis) this.lenis.scrollTo(target);
    else target.scrollIntoView();
    if (link.classList.contains('skip-to-content')) target.focus({ preventScroll: true });
  }

  /** A mailto with the subject and a short brief filled in, so the request arrives answerable. */
  protected mail(subject: string): string {
    const body =
      'Hi Wapzo team,\n\nBusiness name:\nWhat we do:\nWhatsApp numbers we would link:\nRoughly how many contacts:\n\nThanks';
    return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }
}
