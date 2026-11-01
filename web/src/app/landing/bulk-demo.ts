import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { animate } from 'motion';

import { EASE_OUT, SegThumb, fanOut, still } from './motion';

interface Recipient {
  readonly name: string;
  /** Values for the template's `{fields}`; `name` is filled from `name`. */
  readonly vars: Readonly<Record<string, string>>;
}

interface Campaign {
  readonly key: string;
  readonly label: string;
  readonly icon: string;
  readonly title: string;
  readonly total: number;
  readonly template: string;
  readonly attach: string;
  readonly attachIcon: string;
  readonly recipients: readonly Recipient[];
}

/** One sample campaign per kind of business. Names, figures and files are sample content. */
const CAMPAIGNS: readonly Campaign[] = [
  {
    key: 'shop',
    label: 'Offer',
    icon: 'building-store',
    title: 'Diwali sale 2026',
    total: 1240,
    template: 'Hi {name}, our Diwali sale is live: {offer} off everything till Sunday. Reply SHOP to order.',
    attach: 'diwali-sale.jpg',
    attachIcon: 'photo',
    recipients: [
      { name: 'Priya', vars: { offer: '30%' } },
      { name: 'Rohan', vars: { offer: '30%' } },
      { name: 'Kavya', vars: { offer: '40%' } },
      { name: 'Arjun', vars: { offer: '30%' } },
    ],
  },
  {
    key: 'school',
    label: 'Fees',
    icon: 'school',
    title: 'Term 2 fee reminder',
    total: 860,
    template: 'Dear {name}, Term 2 fees of {amount} for {student} are due on 10 Nov. Reply 1 for the payment link.',
    attach: 'fee-schedule.pdf',
    attachIcon: 'file-type-pdf',
    recipients: [
      { name: 'Mr Sharma', vars: { amount: '₹12,500', student: 'Aarav' } },
      { name: 'Mrs Iyer', vars: { amount: '₹9,800', student: 'Diya' } },
      { name: 'Mr Khan', vars: { amount: '₹12,500', student: 'Zoya' } },
      { name: 'Mrs Patel', vars: { amount: '₹11,200', student: 'Vihaan' } },
    ],
  },
  {
    key: 'clinic',
    label: 'Reminders',
    icon: 'stethoscope',
    title: 'Tomorrow’s appointments',
    total: 140,
    template: 'Hi {name}, see you tomorrow at {time} with Dr. Iyer. Reply C to confirm or R to reschedule.',
    attach: 'clinic-map.jpg',
    attachIcon: 'photo',
    recipients: [
      { name: 'Meera', vars: { time: '10:30' } },
      { name: 'Kabir', vars: { time: '11:00' } },
      { name: 'Anaya', vars: { time: '12:15' } },
      { name: 'Dev', vars: { time: '16:00' } },
    ],
  },
];

/** A recipient's state, in the order the app's recipient report shows them. */
const STATES: readonly { readonly label: string; readonly icon: string }[] = [
  { label: 'Queued', icon: 'clock' },
  { label: 'Sending', icon: 'loader-2' },
  { label: 'Sent', icon: 'check' },
  { label: 'Delivered', icon: 'checks' },
  { label: 'Read', icon: 'checks' },
];

/** Ticks to the end: the last of four recipients reads at tick 7 (3 + 4). At 650ms a tick the send is over in under 5s, then it stops (WCAG 2.2.2). */
const DONE = 7;

/**
 * The landing hero's live thing: one campaign going out, once. The template
 * sits at the top with its fields marked; on start it presses like a sent
 * message and the recipient rows fan out of it (the page's signature move).
 * Each row shows the message as that person gets it and walks from queued to
 * read, while the totals for the whole send count up smoothly. Picking a
 * campaign, or Send again, runs it from the start.
 */
@Component({
  selector: 'app-bulk-demo',
  imports: [SegThumb],
  templateUrl: './bulk-demo.html',
  styleUrl: './bulk-demo.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BulkDemo {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  protected readonly campaigns = CAMPAIGNS;
  protected readonly states = STATES;

  protected readonly key = signal(CAMPAIGNS[0].key);
  protected readonly c = computed(() => CAMPAIGNS.find((x) => x.key === this.key()) ?? CAMPAIGNS[0]);
  /** Send clock; with reduced motion it rests on the finished campaign. */
  private readonly tick = signal(still() ? DONE : 0);
  /** Bumped on every (re)start so the fan-out runs again after the rows render. */
  private readonly run = signal(0);
  private timer: ReturnType<typeof setInterval> | undefined;

  /** The template split into text and `{field}` parts, so the fields can be marked. */
  protected readonly parts = computed(() =>
    this.c()
      .template.split(/(\{\w+\})/)
      .filter(Boolean)
      .map((text) => ({ text, field: text.startsWith('{') })),
  );
  protected readonly done = computed(() => this.tick() >= DONE);
  /** Shown progress, eased towards the clock by Motion so the totals count instead of jumping. */
  protected readonly shown = signal(still() ? 1 : 0);
  protected readonly sent = computed(() => Math.round(this.c().total * this.shown()));
  protected readonly delivered = computed(() => Math.round(this.sent() * 0.97));
  protected readonly read = computed(() => Math.round(this.sent() * 0.72));

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => clearInterval(this.timer));
    if (still()) return;

    let counting: { stop(): void } | undefined;
    effect(() => {
      const to = Math.min(this.tick() / DONE, 1);
      const from = untracked(this.shown);
      counting?.stop();
      // A restart drops straight back to zero; only forward progress is animated.
      if (to <= from) this.shown.set(to);
      else counting = animate(from, to, { duration: 0.6, ease: EASE_OUT, onUpdate: (v) => this.shown.set(v) });
    });

    let first = true;
    afterRenderEffect(() => {
      this.run();
      const compose = this.el.querySelector('.compose');
      if (!compose) return;
      animate(compose, { scale: [1, 0.97, 1] }, { duration: 0.35, delay: first ? 0.45 : 0 });
      fanOut(compose, [...this.el.querySelectorAll('.rows li')], first ? 0.6 : 0.15);
      first = false;
    });

    afterNextRender(() => this.start());
  }

  protected pick(key: string): void {
    this.key.set(key);
    this.start();
  }

  /** Runs the send from the first tick; a no-op under reduced motion, which shows the finished send. */
  protected start(): void {
    if (still()) return;
    clearInterval(this.timer);
    this.tick.set(0);
    this.run.update((n) => n + 1);
    this.timer = setInterval(() => {
      if (this.tick() >= DONE) clearInterval(this.timer);
      else this.tick.update((t) => t + 1);
    }, 650);
  }

  /** Row `i` starts one tick after the row above it and moves one state per tick. */
  protected state(i: number): number {
    return Math.max(0, Math.min(this.tick() - i, STATES.length - 1));
  }

  protected personal(r: Recipient): string {
    return this.c().template.replace(/\{(\w+)\}/g, (_, k: string) => (k === 'name' ? r.name : (r.vars[k] ?? '')));
  }

  protected fmt(n: number): string {
    return n.toLocaleString('en-IN');
  }
}
