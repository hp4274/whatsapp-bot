import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';

import { animate, stagger } from 'motion';

import { FeatureScene, type Said } from './feature-scene';
import { SPRING, still } from './motion';

/** Something a customer can tap, and what the business answers when they do. */
interface Option {
  readonly title: string;
  readonly note?: string;
  readonly reply: string;
}

interface Card {
  readonly title: string;
  readonly text: string;
  /** Which part of the shop photo it shows (its top has notification cards drawn in). */
  readonly crop: string;
  readonly option: Option;
}

/**
 * One WhatsApp message: plain text, a photo with a caption, reply buttons, a list menu, or a carousel of cards.
 * Buttons and lists are drawn as WhatsApp's own, which is how they are sent (`#deliverNativeFlow` in
 * `server/src/transports/baileys.js`).
 */
interface ChatLine {
  readonly side: 'in' | 'out';
  readonly text: string;
  readonly time: string;
  readonly photo?: boolean;
  readonly buttons?: readonly Option[];
  readonly list?: { readonly button: string; readonly rows: readonly Option[] };
  readonly cards?: readonly Card[];
}

/** What the customer sent back in the chat, and the business's answer to it. */
interface Answer {
  readonly said: string;
  readonly reply: string;
}

interface Variation {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly lines: readonly ChatLine[];
}

/** Seconds each feature stays up before the next one takes over. */
const ROTATE_SECONDS = 4;

/** The kinds of bulk message, slid through above the phone. Seen on the customer's phone: the business's messages come in. */
const BULK_VARIATIONS: readonly Variation[] = [
  {
    key: 'regular',
    label: 'Regular',
    icon: 'message',
    lines: [
      { side: 'in', text: 'Hi Priya, our Diwali sale starts Friday! 20% off every kurta, this week only.', time: '10:00' },
      { side: 'out', text: 'Is it on in the Pune store too?', time: '10:06' },
      { side: 'in', text: 'Yes, in every store and online.', time: '10:09' },
    ],
  },
  {
    key: 'images',
    label: 'With images',
    icon: 'photo',
    lines: [
      { side: 'in', text: 'Hi Priya, our Diwali sale starts Friday! 20% off every kurta, this week only.', time: '10:00', photo: true },
      { side: 'out', text: 'Looks lovely! Is it on in Pune too?', time: '10:06' },
      { side: 'in', text: 'Yes, in every store and online.', time: '10:09' },
    ],
  },
  {
    key: 'buttons',
    label: 'Reply buttons',
    icon: 'arrow-back-up',
    lines: [
      {
        side: 'in',
        text: 'Hi Priya, our Diwali sale starts Friday! Shall we remind you that morning?',
        time: '10:00',
        buttons: [
          { title: 'Yes, remind me', reply: 'Done, Priya. We will message you on Friday morning.' },
          { title: 'No, thanks', reply: 'No problem, Priya. We will not remind you.' },
        ],
      },
    ],
  },
  {
    key: 'list',
    label: 'List options',
    icon: 'list',
    lines: [
      {
        side: 'in',
        text: 'Hi Priya, our Diwali sale starts Friday! What are you shopping for?',
        time: '10:00',
        list: {
          button: 'See offers',
          rows: [
            { title: 'Kurtas', note: '20% off', reply: 'Every kurta is 20% off until Sunday, Priya.' },
            { title: 'Sarees', note: '15% off', reply: 'All cotton sarees are 15% off until Sunday.' },
            { title: 'Stoles', note: 'Buy 2, get 1 free', reply: 'Pick any three stoles and the third is free.' },
          ],
        },
      },
    ],
  },
  {
    key: 'carousel',
    label: 'Carousel',
    icon: 'carousel-horizontal',
    lines: [
      { side: 'in', text: 'Hi Priya, our Diwali picks are in. Swipe to see them.', time: '10:00' },
      {
        side: 'in',
        text: '',
        time: '10:00',
        cards: [
          { title: 'Block print kurta', text: '₹1,199, 20% off', crop: '53% 84%', option: { title: 'Hold one for me', reply: 'Your kurta is held until Sunday, Priya.' } },
          { title: 'Cotton sarees', text: '₹2,499, 15% off', crop: '25% 38%', option: { title: 'Hold one for me', reply: 'Your saree is held until Sunday, Priya.' } },
          { title: 'Indigo stoles', text: 'Buy 2, get 1 free', crop: '94% 100%', option: { title: 'Hold one for me', reply: 'Your stole is held until Sunday, Priya.' } },
        ],
      },
    ],
  },
];

interface Feature {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly title: string;
  readonly text: string;
  /** What is in it today; a coming-soon feature promises nothing this specific. */
  readonly points?: readonly string[];
  /** The message a scene shows; Bulk messages has its phone chat instead. */
  readonly said?: Said;
}

/** What a business can use today: the open services in `server/src/tenancy.js`. */
const AVAILABLE: readonly Feature[] = [
  {
    key: 'bulk',
    label: 'Bulk messages',
    icon: 'send',
    title: 'Message your whole list at once',
    text: 'Upload your contacts and send one campaign from your own number. Each person gets their own chat, with their name in it.',
    points: ['Send now or schedule it for later', 'Add images, PDFs and video', 'Watch sent, read and replied as it goes'],
  },
  {
    key: 'templates',
    label: 'Templates',
    icon: 'file-text',
    title: 'Write it once, reuse it every week',
    text: 'Save the messages you send most, with blanks for each person’s details, and start your next campaign from one.',
    points: ['Name, order or amount filled in for each person', 'Keep an image or file with the message', 'A preview before anything goes out'],
    said: { name: 'Rohan Mehta', text: 'Hi Rohan, your order #4822 has shipped and should reach you by Thursday.', time: '11:30' },
  },
  {
    key: 'contacts',
    label: 'Contacts',
    icon: 'address-book',
    title: 'Your customers, ready to message',
    text: 'Bring in your list from Excel or CSV, and group people so each campaign reaches the right ones.',
    points: ['Bad numbers and duplicates caught on import', 'Groups and tags, such as VIP or Recent buyers', 'Every message to a person kept in one place'],
    said: { name: 'Kavya Rao', text: 'Hi Kavya, as one of our VIP customers you get first look at the new collection.', time: '12:15' },
  },
  {
    key: 'numbers',
    label: 'WhatsApp numbers',
    icon: 'device-mobile',
    title: 'Use the number customers already know',
    text: 'Link your WhatsApp or WhatsApp Business number by scanning a QR code. There is no Meta approval to wait for.',
    points: ['Linked in a minute, like WhatsApp Web', 'A daily limit that protects your number', 'Send one campaign from several numbers at once, on bigger plans'],
    said: { name: 'Arjun Nair', text: 'Hi Arjun, this is Sunrise Traders. Your new price list is attached.', time: '15:02' },
  },
];

/**
 * On the way. Mirrors SOON_SERVICES in `admin/service-meta.ts`, with Integrations folded into API and Auto replies
 * added: a business can reach those today, but the landing page does not sell them yet. The chats are previews.
 * Orders and Appointments are left out on purpose: they are listed for the super admin only until they open.
 */
const COMING_SOON: readonly Feature[] = [
  {
    key: 'auto-replies',
    label: 'Auto replies',
    icon: 'message-bolt',
    title: 'Answers that go out on their own',
    text: 'Keywords, numbered menus and after-hours messages reply to customers in your words, even when nobody is at the desk.',
    said: { name: 'Priya Shah', text: 'Hi Priya! Reply with a number: 1  Check stock 2  Track my order 3  Talk to the team', time: '9:41' },
  },
  {
    key: 'ai',
    label: 'AI replies',
    icon: 'sparkles',
    title: 'Replies written for each question',
    text: 'AI answers the questions a fixed reply cannot, using what you have told it about your business.',
    said: { name: 'Neel Desai', text: 'Yes, XL is in stock, and orders placed today reach Pune by Thursday.', time: '14:12' },
  },
  {
    key: 'faq',
    label: 'FAQ',
    icon: 'help-circle',
    title: 'Common questions, answered for you',
    text: 'Add your answers once, and customers get them the moment they ask.',
    said: { name: 'Sana Khan', text: 'We are open until 6 pm on Sundays.', time: '16:40' },
  },
  {
    key: 'school',
    label: 'School assistant',
    icon: 'school',
    title: 'Fees, notices and parent questions',
    text: 'Keep parents up to date on fees, homework and attendance, and answer their questions on WhatsApp.',
    said: { name: 'Aarav’s parent', text: 'Reminder: Term 2 fees of ₹12,500 for Aarav (Class 6B) are due on 10 November.', time: '8:00' },
  },
  {
    key: 'payments',
    label: 'Payment reminders',
    icon: 'cash',
    title: 'Get paid without chasing',
    text: 'Follow up on invoices until they are paid, without writing each reminder yourself.',
    said: { name: 'Vikram Joshi', text: 'Hi Vikram, invoice #1042 for ₹2,500 is due on Friday. Reply 1 for a payment link.', time: '10:30' },
  },
  {
    key: 'leads',
    label: 'Leads',
    icon: 'user-search',
    title: 'Never lose an enquiry',
    text: 'Every new enquiry is saved, so your team can follow it up.',
    said: { name: 'Ishaan Verma', text: 'It is ₹9,000 for 3 months. Would you like a call? Reply 1 for yes.', time: '17:02' },
  },
  {
    key: 'subscriptions',
    label: 'Subscriptions',
    icon: 'refresh',
    title: 'Renewals that take one reply',
    text: 'Remind members before a plan ends and let them renew from the chat.',
    said: { name: 'Meera Nair', text: 'Hi Meera, your monthly plan ends on 12 November. Reply 1 to renew, 2 to pause.', time: '9:00' },
  },
  {
    key: 'events',
    label: 'Events',
    icon: 'confetti',
    title: 'Fill the room and know who is coming',
    text: 'Invite your list and collect bookings by reply.',
    said: { name: 'Tara Menon', text: 'Hi Tara, doors open at 7 pm on Saturday. Reply 1 to book your seat.', time: '11:00' },
  },
  {
    key: 'tickets',
    label: 'Tickets',
    icon: 'ticket',
    title: 'Support issues that do not get lost',
    text: 'Turn a complaint into a ticket with an owner, and keep the customer informed.',
    said: { name: 'Dev Patel', text: 'Sorry about that. Ticket #208 is open and Neha will reply today.', time: '12:49' },
  },
  {
    key: 'workflows',
    label: 'Workflows',
    icon: 'hierarchy-3',
    title: 'Follow-ups that run themselves',
    text: 'Set the steps once, such as a thank-you and then a review request, and they run for every customer.',
    said: { name: 'Arjun Nair', text: 'Thanks for your order, Arjun!', time: '10:00' },
  },
  {
    key: 'analytics',
    label: 'Analytics',
    icon: 'chart-bar',
    title: 'See which messages work',
    text: 'Compare your campaigns by who read them and who replied, so the next one does better.',
    said: { name: 'Priya Shah', text: 'Hi Priya, our Diwali sale starts Friday!', time: '10:00' },
  },
  {
    key: 'api',
    label: 'API & integrations',
    icon: 'api',
    title: 'Connect WhatsApp to your software',
    text: 'Send messages from the tools you already use and get replies back in them.',
    said: { name: 'Rohan Mehta', text: 'Hi Rohan, your payment of ₹1,850 was received. Thank you!', time: '19:44' },
  },
];

/**
 * The landing page's tour of the product: every feature down the side, and for the one picked, what it does and a
 * scene of it at work (FeatureScene). Bulk messages is a WhatsApp chat instead, with its kinds listed under it in the
 * rail and again as tabs below the phone; tapping a reply button, a list option or a card plays the customer's choice
 * and the answer. Names and figures are samples. Buttons, lists and the carousel are WhatsApp's own, as they are sent.
 */
@Component({
  selector: 'app-chat-preview',
  imports: [FeatureScene],
  templateUrl: './chat-preview.html',
  styleUrl: './chat-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(click)': 'autoplay.set(false)' },
})
export class ChatPreview {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  /** Features change by themselves until the visitor takes over; never for someone who asked for less motion. */
  protected readonly autoplay = signal(!matchMedia('(prefers-reduced-motion: reduce)').matches);
  protected readonly available = AVAILABLE;
  protected readonly comingSoon = COMING_SOON;
  protected readonly feature = signal(AVAILABLE[0]);
  protected readonly variations = BULK_VARIATIONS;
  /** Back to Regular whenever Bulk messages is picked again. */
  protected readonly variation = linkedSignal<Feature, Variation>({ source: this.feature, computation: () => BULK_VARIATIONS[0] });
  /** What the customer answered in this chat; another variation starts clean. */
  protected readonly picked = linkedSignal<Variation, Answer | null>({ source: this.variation, computation: () => null });
  /** The list whose options are open over the chat; another variation closes it. */
  protected readonly sheet = linkedSignal<Variation, ChatLine['list'] | null>({ source: this.variation, computation: () => null });
  protected readonly lastTime = computed(() => this.variation().lines.at(-1)?.time ?? '');
  private readonly thread = viewChild<ElementRef<HTMLElement>>('thread');
  /** Which way the last change of kind went, so the chat slides in from that side. */
  private dir = 1;

  constructor() {
    let inView = false;
    let shown = 0;
    const seen = new IntersectionObserver(([entry]) => (inView = entry.isIntersecting), { threshold: 0.3 });
    seen.observe(this.host);
    // Counted in seconds, so the next feature gets its full time after a pause or a scroll back.
    const timer = setInterval(() => {
      shown = this.autoplay() && inView && !document.hidden && !this.reaching() ? shown + 1 : 0;
      if (shown < ROTATE_SECONDS) return;
      shown = 0;
      this.advance();
    }, 1000);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      seen.disconnect();
    });

    // Each change slides in: a new feature's text, picture and points one after another; another kind of bulk
    // message only its text (its chat bubbles pop in by themselves). Not on first paint: the section's reveal has that.
    let onShow: Feature | null = null;
    effect(() => {
      const feature = this.feature();
      this.variation();
      const first = onShow === null;
      const whole = feature !== onShow;
      onShow = feature;
      if (first || still()) return;
      afterNextRender(
        () => {
          if (whole) {
            animate(this.host.querySelectorAll('.stage > *'), { opacity: [0, 1], y: [18, 0] }, { ...SPRING, delay: stagger(0.07) });
            return;
          }
          // Another kind of bulk message: the chat slides in sideways, from the side the visitor went.
          const thread = this.thread()?.nativeElement;
          if (thread) animate(thread, { opacity: [0, 1], x: [this.dir * 48, 0] }, SPRING);
          animate(this.host.querySelectorAll('.stage .about'), { opacity: [0, 1], y: [18, 0] }, SPRING);
        },
        { injector: this.injector },
      );
    });
  }

  /** About to pick something. Not any hover: the section fills the screen, so a resting mouse would stop it for good. */
  private reaching(): boolean {
    return this.host.matches(':focus-within') || Boolean(this.host.querySelector('.rail:hover, .cta:hover'));
  }

  /** Through Bulk's kinds first, then on to the next feature. */
  private advance(): void {
    const kind = BULK_VARIATIONS.indexOf(this.variation());
    if (this.feature().key === 'bulk' && kind < BULK_VARIATIONS.length - 1) {
      this.dir = 1;
      this.variation.set(BULK_VARIATIONS[kind + 1]);
    } else {
      // Coming-soon features are listed, never shown: the slide goes round the available ones only.
      this.feature.set(AVAILABLE[(AVAILABLE.indexOf(this.feature()) + 1) % AVAILABLE.length]);
    }
    // Below `lg` the list is a row to swipe: bring the new chip into sight, once Bulk's kinds have folded away.
    afterNextRender(
      () => {
        const rail = this.host.querySelector('.rail');
        const chip = rail?.querySelector('.row[aria-pressed="true"]');
        if (!rail || !chip) return;
        rail.scrollBy({ left: chip.getBoundingClientRect().left - rail.getBoundingClientRect().left - 16, behavior: 'smooth' });
      },
      { injector: this.injector },
    );
  }

  /** Pick a kind of bulk message from the tabs. */
  protected show(v: Variation): void {
    this.dir = BULK_VARIATIONS.indexOf(v) < BULK_VARIATIONS.indexOf(this.variation()) ? -1 : 1;
    this.variation.set(v);
  }

  /** The arrows: one kind back or on, round from the last to the first. */
  protected step(by: 1 | -1): void {
    const n = BULK_VARIATIONS.length;
    this.dir = by;
    this.variation.set(BULK_VARIATIONS[(BULK_VARIATIONS.indexOf(this.variation()) + by + n) % n]);
  }

  /** The customer answers with the button, list option or card they tapped. */
  protected pick(option: Option): void {
    this.sheet.set(null);
    this.picked.set({ said: option.title, reply: option.reply });
    // After Angular has drawn the two new bubbles.
    setTimeout(() => this.thread()?.nativeElement.scrollTo({ top: 1e6 }));
  }

  /** On to the next card, or back to the first from the last: a mouse cannot swipe. */
  protected nextCard(strip: HTMLElement): void {
    const atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 8;
    strip.scrollTo({ left: atEnd ? 0 : strip.scrollLeft + 196, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }
}
