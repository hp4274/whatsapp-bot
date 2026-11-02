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
import { BulkDemo } from './bulk-demo';
import { ChatPreview } from './chat-preview';
import { LandingNav } from './landing-nav';
import { CountUp, EASE_OUT, FanOut, Reveal, SPRING, still } from './motion';

/** Everything a bulk send can carry, under the three showcased rows. */
const BULK_KIT: readonly { readonly icon: string; readonly name: string; readonly text: string }[] = [
  { icon: 'table-import', name: 'Import any list', text: 'Excel or CSV; bad numbers and duplicates are caught before you send.' },
  { icon: 'users-group', name: 'Groups and tags', text: 'Send to VIPs, one class or last month’s buyers, not everyone.' },
  { icon: 'photo', name: 'Images, PDFs and video', text: 'A poster, a price list or a fee schedule goes with the text.' },
  { icon: 'calendar-time', name: 'Schedule it', text: 'Write it tonight, let it go out at 10 tomorrow morning.' },
  { icon: 'arrows-shuffle', name: 'Message variations', text: 'Rotate greetings and wording so no two messages are identical.' },
  { icon: 'refresh', name: 'Retry the failed', text: 'One click re-queues only the people it did not reach.' },
];

/** Everything beyond bulk sending, grouped the way the app's sidebar groups them. */
const FACILITIES: readonly {
  readonly heading: string;
  readonly items: readonly { readonly icon: string; readonly name: string; readonly text: string }[];
}[] = [
  {
    heading: 'Messaging',
    items: [
      { icon: 'device-mobile', name: 'Several numbers', text: 'Run sales, support and accounts on separate numbers from one login.' },
      { icon: 'file-text', name: 'Templates', text: 'Save the messages you send every week and reuse them in a click.' },
      { icon: 'school', name: 'School assistant', text: 'Fees, circulars and parent questions, ready made for schools.' },
    ],
  },
  {
    heading: 'Customers',
    items: [
      { icon: 'address-book', name: 'Contacts', text: 'One record per customer, with every message you have exchanged.' },
      { icon: 'cash', name: 'Payment reminders', text: 'Polite, timed nudges for unpaid invoices, stopped once paid.' },
      { icon: 'calendar-event', name: 'Appointments', text: 'Bookings with a reminder the day before.' },
    ],
  },
  {
    heading: 'Platform',
    items: [
      { icon: 'hierarchy-3', name: 'Workflows', text: 'A new order sends a thank-you, then a review request a week later.' },
      { icon: 'api', name: 'API and webhooks', text: 'Send from your own software and hear about every reply.' },
      { icon: 'users', name: 'Team roles', text: 'Agents answer chats, admins run campaigns, owners see everything.' },
    ],
  },
];

/** Who it is for; the agency line is the multi-business tenancy the platform is built on. */
const AUDIENCES: readonly { readonly icon: string; readonly name: string; readonly text: string }[] = [
  { icon: 'building-store', name: 'Shops and online brands', text: 'Sale announcements, new arrivals and order updates to every customer at once.' },
  { icon: 'school', name: 'Schools and coaching', text: 'Fee reminders, holiday notices and results to every parent, each with their child’s name.' },
  { icon: 'stethoscope', name: 'Clinics and services', text: 'Tomorrow’s appointment reminders sent in one go, confirmations collected by reply.' },
  { icon: 'briefcase', name: 'Agencies', text: 'Run bulk campaigns for many clients, each on its own number with its own contacts.' },
];

/**
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

/** Where "Request access" goes; accounts are issued by the platform, so there is no sign-up form. */
const CONTACT_EMAIL = 'connection@zarklyx.com';

/**
 * The public front page for a visitor from search: Wapzo is bulk WhatsApp
 * messaging first, so the hero is a campaign going out, and the replies,
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
  imports: [RouterLink, Reveal, FanOut, CountUp, Tilt, BulkDemo, ChatPreview, LandingNav],
  templateUrl: './landing.html',
  styleUrl: './landing.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(click)': 'jump($event)' },
})
export class Landing {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly kit = BULK_KIT;
  protected readonly facilities = FACILITIES;
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
      if (!still()) {
        const bar = this.el.querySelector('.progress');
        if (bar) stops.push(scroll(animate(bar, { scaleX: [0, 1] }, { ease: 'linear' })));
        // The hero as one sequence: the headline wipes up out of a mask, the rest rises after it,
        // and the campaign card comes into focus from a blur before it starts sending.
        const h1 = this.el.querySelector('h1');
        if (h1) animate(h1, { clipPath: ['inset(-10% -4% 100% -4%)', 'inset(-10% -4% -12% -4%)'], y: [28, 0] }, { duration: 0.9, ease: EASE_OUT });
        animate(this.el.querySelectorAll('.hero-copy > :not(h1)'), { opacity: [0, 1], y: [24, 0] }, { ...SPRING, delay: stagger(0.08, { startDelay: 0.25 }) });
        const demo = this.el.querySelector<HTMLElement>('.hero-demo');
        if (demo) {
          animate(demo, { opacity: [0, 1], y: [40, 0], filter: ['blur(12px)', 'blur(0px)'] }, { duration: 0.9, delay: 0.2, ease: EASE_OUT })
            // A resting filter still makes a compositing layer; clear it once the card has landed.
            // Motion commits the last frame after the promise settles, so wait one frame.
            .then(() => requestAnimationFrame(() => demo.style.removeProperty('filter')));
        }
        // The footer's wordmark rises into place as the close scrolls into view.
        const giant = this.el.querySelector('.giant');
        if (giant) stops.push(scroll(animate(giant, { y: ['45%', '0%'] }, { ease: 'linear' }), { target: giant, offset: ['start end', 'end end'] }));
      }
      destroyRef.onDestroy(() => stops.forEach((stop) => stop()));
    });
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
