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
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';

import { Channel, ChannelsApi, TenancyApi } from '../core/api';
import { PhoneInput } from '../core/phone-input';
import { Store } from '../core/store';
import { ChannelCard } from '../channels/channel-card';
import { liveState, localZone, plainError, timeZones } from '../channels/channel-meta';
import { LinkCard } from '../connection/link-card';
import { NumberQuestions } from '../connection/number-questions';
import { SafetyControls } from '../connection/safety-controls';
import { SendingHealth } from '../connection/sending-health';

/** Only the selected number streams live events; the rest are polled this often. */
const POLL_MS = 30_000;

/**
 * Live events reload the list at most this often. A run reports every send ('campaign'), and reloading on each
 * one asked for the whole list several times a second; the cards' figures do not need to move faster.
 */
const REFRESH_EVERY_MS = 10_000;

const emptyDraft = () => ({
  displayName: '',
  phoneNumber: '',
  timezone: localZone(),
});

/**
 * The business's WhatsApp, on one page: the selected number linked with a QR code, its limits and health,
 * and ban protection. It replaced two pages ("Connection" and "WhatsApp Numbers") that showed the same number
 * twice; a business with one number now sees one number.
 *
 * Several numbers: the selected one is expanded, the others compact. Linking another number selects it for the
 * length of the link (the server links the selected number) and then goes back, so a send running on the
 * first keeps its live progress on screen.
 */
@Component({
  selector: 'app-whatsapp',
  imports: [
    FormsModule,
    ChannelCard,
    LinkCard,
    NumberQuestions,
    PhoneInput,
    SafetyControls,
    SendingHealth,
  ],
  templateUrl: './whatsapp.html',
  styleUrl: './whatsapp.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WhatsApp {
  private readonly api = inject(ChannelsApi);
  private readonly tenancy = inject(TenancyApi);
  protected readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);

  /** `?channel=` (withComponentInputBinding): an old link, or another page, naming the number to work on. */
  readonly channel = input<string>();

  protected readonly channels = signal<Channel[]>([]);
  protected readonly capabilities = signal<string[]>([]);
  protected readonly warnings = signal<Record<string, string>>({});
  protected readonly loading = signal(true);
  /** A list has arrived. A failed first load leaves an empty list that says nothing about which numbers exist. */
  private readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly showForm = signal(false);
  protected readonly draft = signal(emptyDraft());
  protected readonly zones = timeZones(localZone());
  /** The plan's number cap (null = none); undefined until /plan-usage answers. */
  protected readonly cap = signal<number | null | undefined>(undefined);

  /** The business is running its own anti-ban limits (see SafetyControls). */
  protected readonly customSafety = signal(false);
  protected readonly safetyOff = signal(false);

  /** The number the 2 questions are asked for; `n` makes each ask a fresh popup, even for the same number. */
  protected readonly asking = signal<{ id: number; n: number } | null>(null);
  /** The number to go back to once another number's link finishes or is called off. */
  private readonly returnTo = signal<number | null>(null);
  /** A send was going out when the detour started, so the notice can say it keeps going (and not claim one otherwise). */
  protected readonly detourSending = signal(false);
  /** The number whose link card should start linking by itself (its "Link with QR code" was the click). */
  protected readonly autoLink = signal<number | null>(null);
  /** "Link with QR code" while a send runs on the selected number: waiting for the inline confirm. */
  protected readonly confirmLink = signal<Channel | null>(null);
  /** One status line after switching back ("Back on Sales desk"). */
  protected readonly notice = signal('');

  private readonly firstField = viewChild<ElementRef<HTMLInputElement>>('firstField');
  private readonly recoverRef = viewChild<ElementRef<HTMLElement>>('recover');
  private readonly confirmGo = viewChild<ElementRef<HTMLButtonElement>>('confirmGo');

  /** The main number: requests that name no number run against it. */
  private readonly defaultId = computed(() => {
    const list = this.channels();
    return (list.find((c) => c.isDefault) ?? list[0])?.id ?? null;
  });
  /** The selected number: the stored pick, else the main number. */
  protected readonly activeId = computed(() => this.store.channelId() ?? this.defaultId());
  protected readonly selected = computed(() => this.channels().find((c) => c.id === this.activeId()) ?? null);
  protected readonly others = computed(() => this.channels().filter((c) => c.id !== this.activeId()));
  protected readonly multi = computed(() => this.channels().length > 1);
  /** Add only while the plan has room; unknown (still loading) shows nothing rather than a button that may 403. */
  protected readonly canAdd = computed(() => {
    const cap = this.cap();
    return cap !== undefined && (cap === null || this.channels().length < cap);
  });

  /** Why the selected number cannot send, for the header pill (the link card says the rest). */
  private readonly stop = computed(() => {
    const c = this.store.connection();
    return c.code === 'WHATSAPP_BANNED' ? 'ban' : (c.paused?.by ?? null);
  });
  protected readonly banned = computed(() => this.stop() === 'ban');
  /** The ban checklist opens itself on a ban; the ban card's link opens it too. */
  protected readonly recoverOpen = linkedSignal(() => this.banned());

  protected readonly status = computed(() => {
    const c = this.store.connection();
    const stop = this.stop();
    if (stop) return { tone: stop === 'ban' ? 'tone-bad' : 'tone-warn', text: stop === 'ban' ? 'Banned' : 'Paused' };
    if (c.connected) return { tone: 'tone-ok', text: 'Connected' };
    if (this.store.qr()) return { tone: 'tone-warn', text: 'Waiting for scan' };
    if (this.store.connecting()) return { tone: 'tone-warn', text: 'Connecting' };
    return { tone: 'tone-mute', text: 'Not linked' };
  });

  /**
   * A send is going out from the selected number: switching away hides its live progress. From the live stats,
   * not the list's `health.running`, which only says the number's engine is loaded (server channelHealth).
   */
  protected readonly sendRunning = computed(() => {
    const s = this.store.stats();
    return s.state === 'RUNNING' && s.pending > 0;
  });

  /** Header strip counts; "attention" is an active number that is offline or flagged for quality. */
  protected readonly summary = computed(() => {
    const list = this.channels();
    const usage = list.map((c) => c.health?.usage?.sentToday ?? 0);
    return {
      total: list.length,
      connected: list.filter((c) => liveState(c) === 'connected').length,
      sentToday: usage.reduce((a, b) => a + b, 0),
      attention: list.filter(
        (c) =>
          c.status === 'active' &&
          (liveState(c) === 'disconnected' ||
            ['warn', 'bad'].includes(c.health?.quality?.level ?? 'ok')),
      ).length,
    };
  });

  /**
   * The one number to send on next: active, connected, bulk not held, highest health score,
   * then most of today's quota left. None with a single number: there is nothing to choose.
   */
  protected readonly recommendedId = computed(() => {
    const list = this.channels();
    const ready = list.filter(
      (c) =>
        c.status === 'active' &&
        c.health?.connected &&
        !c.health.usage?.blocked &&
        c.health.usage?.asked !== false,
    );
    if (list.length < 2 || !ready.length) return null;
    const score = (c: Channel) => c.health?.quality?.score ?? 0;
    const left = (c: Channel) => {
      const u = c.health?.usage;
      return u?.todayLimit == null ? Infinity : u.todayLimit - u.sentToday;
    };
    return ready.reduce((best, c) =>
      score(c) > score(best) || (score(c) === score(best) && left(c) > left(best)) ? c : best,
    ).id;
  });

  /** WhatsApp's terms note for QR-linked numbers, from the server. */
  protected readonly warning = computed(() => this.warnings()['baileys'] ?? '');

  constructor() {
    this.refresh();
    this.tenancy.planUsage().subscribe({
      next: ({ usage }) => this.cap.set(usage.metrics.find((m) => m.metric === 'channels')?.limit ?? null),
      // Unknown: offer Add, and let the server's own plan message answer if it is over.
      error: () => this.cap.set(null),
    });
    // Connection events notify 'channels' too (Store.handle), so linking on this page lands here.
    this.store.watch(['channels', 'campaign'], () => this.refreshSoon(), 0);

    // Other numbers do not stream events here, so poll gently while visible.
    const timer = setInterval(() => {
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible';
      if (visible && Date.now() - this.lastRefresh >= REFRESH_EVERY_MS) this.refresh();
    }, POLL_MS);
    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      clearTimeout(this.refreshTimer);
    });

    effect(() => {
      const list = this.channels();
      const picked = this.store.channelId();
      const raw = this.channel();
      const main = this.defaultId();
      if (!this.loaded()) return;
      untracked(() => {
        // A stored pick that is gone (deleted elsewhere) falls back to the main number. The connect gate does
        // the same app-wide; here it also covers a list that changed while the page was open.
        if (picked !== null && !list.some((c) => c.id === picked)) this.store.useChannel(null);
        // No pick means "the main number", and the live stream was opened for the one that was main then. When
        // the main number moves ("Make main number", or another session), pin that one, so the expanded card,
        // its live state and Unlink keep meaning the same number. Gone (deleted): pin the new main instead,
        // which reopens the stream for it.
        const before = this.lastMain;
        this.lastMain = main;
        if (picked === null && before !== null && main !== null && main !== before) {
          this.store.useChannel(list.some((c) => c.id === before) ? before : main);
        }
        if (raw === undefined) return;
        const id = Number(raw);
        if (list.some((c) => c.id === id) && id !== this.activeId()) this.store.useChannel(id);
        // Honoured once: a reload must not keep switching back to it.
        this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });
      });
    });
  }

  private seq = 0;
  private lastRefresh = 0;
  /** The main number at the last list, for noticing that it moved (see the housekeeping effect). */
  private lastMain: number | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** A throttle, not a debounce: a steady stream of sends still reloads every REFRESH_EVERY_MS instead of never. */
  private refreshSoon(): void {
    if (this.refreshTimer !== undefined) return;
    const wait = Math.max(400, this.lastRefresh + REFRESH_EVERY_MS - Date.now());
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.refresh();
    }, wait);
  }

  protected refresh() {
    this.lastRefresh = Date.now();
    // Only the newest answer lands: an older, slower one would put back a number just deleted or renamed.
    const n = ++this.seq;
    this.api.list().subscribe({
      next: ({ channels, capabilities, warnings }) => {
        if (n !== this.seq) return;
        this.channels.set(channels);
        this.capabilities.set(capabilities);
        this.warnings.set(warnings ?? {});
        this.loadError.set('');
        this.loading.set(false);
        this.loaded.set(true);
      },
      error: (err: Error) => {
        if (n !== this.seq) return;
        this.loadError.set(plainError(err.message));
        this.loading.set(false);
      },
    });
  }

  protected toggleForm() {
    const open = !this.showForm();
    this.showForm.set(open);
    this.formError.set('');
    if (open) afterNextRender(() => this.firstField()?.nativeElement.focus(), { injector: this.injector });
  }

  protected setDraft<K extends keyof ReturnType<typeof emptyDraft>>(
    key: K,
    value: ReturnType<typeof emptyDraft>[K],
  ) {
    this.draft.update((d) => ({ ...d, [key]: value }));
  }

  protected create(event: Event) {
    event.preventDefault();
    const d = this.draft();
    if (!d.displayName.trim()) {
      this.formError.set('Give the number a name your team will recognise.');
      this.firstField()?.nativeElement.focus();
      return;
    }
    this.busy.set(true);
    this.formError.set('');
    this.api
      .create({
        displayName: d.displayName.trim(),
        phoneNumber: d.phoneNumber.trim(),
        timezone: d.timezone,
        settings: { transport: 'baileys' },
      })
      .subscribe({
        next: ({ channel }) => {
          this.busy.set(false);
          this.showForm.set(false);
          this.draft.set(emptyDraft());
          this.channels.update((list) => [...list, channel]);
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.formError.set(plainError(err.message));
        },
      });
  }

  /** A card saved: take the server's copy in place instead of reloading every number. */
  protected replace(channel: Channel) {
    this.channels.update((list) => list.map((c) => (c.id === channel.id ? channel : c)));
  }

  /** Deleted: gone from the list, and if it was the selected number, the main number takes over. */
  protected removed(channel: Channel) {
    this.channels.update((list) => list.filter((c) => c.id !== channel.id));
    if (this.store.channelId() === channel.id) this.store.useChannel(null);
    if (this.returnTo() === channel.id) this.returnTo.set(null);
    this.refresh();
  }

  protected use(channel: Channel) {
    this.returnTo.set(null);
    this.notice.set('');
    this.store.useChannel(channel.id);
  }

  /** "Link with QR code" on another number: ask first when that hides a running send. */
  protected link(channel: Channel) {
    if (this.sendRunning()) {
      this.confirmLink.set(channel);
      // An alertdialog takes focus, or a keyboard user is left on a card that no longer did anything.
      afterNextRender(() => this.confirmGo()?.nativeElement.focus(), { injector: this.injector });
      return;
    }
    this.startLink(channel);
  }

  protected startLink(channel: Channel) {
    this.confirmLink.set(null);
    this.notice.set('');
    const previous = this.activeId();
    this.detourSending.set(this.sendRunning());
    this.returnTo.set(previous !== channel.id ? previous : null);
    this.autoLink.set(channel.id);
    this.store.useChannel(channel.id);
  }

  /** The selected number just linked: ask its 2 questions, then go back if this was a detour. */
  protected linked() {
    const id = this.activeId();
    if (id !== null) this.ask(id);
    this.goBack();
  }

  protected goBack() {
    this.autoLink.set(null);
    const back = this.returnTo();
    if (back === null) return;
    this.returnTo.set(null);
    const name = this.channels().find((c) => c.id === back)?.displayName;
    this.store.useChannel(back);
    if (name) this.notice.set(`Back on ${name}.`);
  }

  protected ask(id: number) {
    this.asking.set({ id, n: (this.asking()?.n ?? 0) + 1 });
  }

  /** The ban card's "how to ask for a review": open the checklist and bring it into view. */
  protected openRecover() {
    this.recoverOpen.set(true);
    afterNextRender(() => this.recoverRef()?.nativeElement.scrollIntoView({ block: 'start' }), {
      injector: this.injector,
    });
  }

  protected toggled(event: Event) {
    this.recoverOpen.set((event.target as HTMLDetailsElement).open);
  }

  /** The name of the number a detour will return to, for the inline confirm. */
  protected readonly selectedName = computed(() => this.selected()?.displayName ?? 'this number');
  protected readonly returnName = computed(() => {
    const back = this.returnTo();
    return back === null ? '' : (this.channels().find((c) => c.id === back)?.displayName ?? '');
  });
}
