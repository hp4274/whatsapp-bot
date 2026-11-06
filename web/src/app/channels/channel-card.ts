import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Observable } from 'rxjs';

import { Channel, ChannelPatch, ChannelsApi } from '../core/api';
import { ChannelSettings } from './channel-settings';
import { LIVE_LABEL, describeDays, liveState, plainError, transportMeta } from './channel-meta';
import { PhoneInput } from '../core/phone-input';

type Editing = 'name' | 'phone' | null;

/** Read once: the tilt is decorative, so a mid-session preference change can wait for a reload. */
const REDUCED =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One WhatsApp number: live state, today's sends, quality, and its controls.
 *
 * Expanded (the selected number) it carries the link card in its projection slot, the daily allowance line,
 * its sending hours and hints. Compact (another of several numbers) it shows only what tells numbers apart:
 * status, today's sends, whether it is sending, and the one action that applies. Both keep the rarely used
 * settings in the Advanced fold.
 */
@Component({
  selector: 'app-channel-card',
  imports: [ChannelSettings, PhoneInput],
  templateUrl: './channel-card.html',
  styleUrl: './channel-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.active]': 'active() && multi()',
    '[class.expanded]': 'expanded()',
    '[class.off]': "channel().status !== 'active'",
    '[attr.data-state]': 'state()',
    '(pointermove)': 'tilt($event)',
    '(pointerleave)': 'untilt()',
  },
})
export class ChannelCard {
  private readonly api = inject(ChannelsApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  readonly channel = input.required<Channel>();
  readonly capabilities = input<string[]>([]);
  /** The number later requests act on. */
  readonly active = input(false);
  /** The full card: link card, allowance and hours. Off, the compact card of another number. */
  readonly expanded = input(false);
  /** The business has several numbers: only then do "main number" and "recommended" mean anything. */
  readonly multi = input(false);
  /** The page's pick of the number to send on next (whatsapp.ts recommendedId). */
  readonly recommended = input(false);
  readonly canDelete = input(false);
  /**
   * A send is going out from this number. Only the selected number streams its run (Store.stats); the list's
   * `health.running` only says the number's engine is loaded, which is true of every linked number.
   */
  readonly sending = input(false);
  /** Linking starts a session: held off while a number is mid-link. */
  readonly linkBusy = input(false);

  /** Saved: the server's copy of this number, so the page updates its list without reloading it. */
  readonly updated = output<Channel>();
  /** The main number moved: every card's badge changes, so the page reloads the list. */
  readonly changed = output<void>();
  /** Deleted on the server. */
  readonly removed = output<void>();
  /** Make this the number later requests run against. */
  readonly use = output<void>();
  /** Link this (unlinked) number with a QR code. */
  readonly connect = output<void>();
  /** Open the 2 start questions for this number. */
  readonly ask = output<void>();

  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly editing = signal<Editing>(null);
  protected readonly draftValue = signal('');
  /** The name box, or the phone field (whose own box is inside it). */
  private readonly editor = viewChild('editor', { read: ElementRef<HTMLElement> });

  protected readonly state = computed(() => liveState(this.channel()));
  protected readonly stateLabel = computed(() => LIVE_LABEL[this.state()]);
  protected readonly transport = computed(() =>
    transportMeta(this.channel().health?.transport || this.channel().provider),
  );
  protected readonly needsConnect = computed(() => this.state() === 'disconnected');

  protected readonly usage = computed(() => this.channel().health?.usage ?? null);
  protected readonly quality = computed(() => this.channel().health?.quality ?? null);
  protected readonly hints = computed(() => this.quality()?.hints ?? []);
  /** 60 is where the server's "bad" hints land, 90 a used-up cap alone. */
  protected readonly scoreTone = computed(() => {
    const score = this.quality()?.score ?? 100;
    return score >= 90 ? 'tone-ok' : score >= 70 ? 'tone-warn' : 'tone-bad';
  });

  /** 0..1 share of today's cap, or null when there is no cap. */
  protected readonly usedShare = computed(() => {
    const u = this.usage();
    if (!u || !u.todayLimit) return null;
    return Math.min(1, u.sentToday / u.todayLimit);
  });

  /** Bar colour shifts before the cap is hit, so a busy number is noticed early. */
  protected readonly meterTone = computed(() => {
    const share = this.usedShare() ?? 0;
    return share >= 0.9 ? 'hot' : share >= 0.7 ? 'warm' : 'cool';
  });

  protected readonly windowText = computed(() => {
    const hours = this.channel().businessHours;
    if (!hours) return 'Any time';
    return `${describeDays(hours.days)} · ${hours.start}-${hours.end}`;
  });

  protected readonly hintIcon = {
    bad: 'alert-circle',
    warn: 'alert-triangle',
    info: 'info-circle',
    ok: 'circle-check',
  } as const;

  // -------------------------------------------------------- inline edit --
  protected startEdit(field: Exclude<Editing, null>) {
    this.error.set('');
    this.editing.set(field);
    this.draftValue.set(field === 'name' ? this.channel().displayName : this.channel().phoneNumber);
    // After the render that creates the field: a microtask ran before it existed, so focus fell to the body.
    afterNextRender(
      () => {
        const host = this.editor()?.nativeElement;
        const el = host instanceof HTMLInputElement ? host : host?.querySelector('input');
        el?.focus();
        el?.select();
      },
      { injector: this.injector },
    );
  }

  protected cancelEdit() {
    this.editing.set(null);
    this.error.set('');
  }

  protected commitEdit(event?: Event) {
    event?.preventDefault();
    const field = this.editing();
    if (!field) return;
    const value = this.draftValue().trim();
    if (field === 'name' && !value) {
      this.error.set('Give the number a name your team will recognise.');
      return;
    }
    const current = field === 'name' ? this.channel().displayName : this.channel().phoneNumber;
    if (value === current) {
      this.editing.set(null);
      return;
    }
    this.save(field === 'name' ? { displayName: value } : { phoneNumber: value }, () =>
      this.editing.set(null),
    );
  }

  protected editKey(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.cancelEdit();
    }
  }

  // ------------------------------------------------------------ actions --
  protected save(patch: ChannelPatch, done?: () => void) {
    this.run(this.api.update(this.channel().id, patch), ({ channel }) => {
      done?.();
      // The PATCH answer has no live health; keep the card's until the next list load brings it.
      this.updated.emit({ ...channel, health: channel.health ?? this.channel().health });
    });
  }

  protected makeDefault() {
    this.run(this.api.makeDefault(this.channel().id), () => this.changed.emit());
  }

  protected remove() {
    this.run(this.api.remove(this.channel().id), () => this.removed.emit());
  }

  private run<T>(call: Observable<T>, done: (value: T) => void) {
    this.busy.set(true);
    this.error.set('');
    call.subscribe({
      next: (value) => {
        this.busy.set(false);
        done(value);
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(plainError(err.message));
      },
    });
  }

  // --------------------------------------------------------------- tilt --
  /** A few degrees of perspective toward the pointer; not on the expanded card, nor with reduced motion. */
  protected tilt(event: PointerEvent) {
    if (REDUCED || this.expanded() || event.pointerType !== 'mouse') return;
    const el = this.host.nativeElement;
    const rect = el.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width - 0.5;
    const y = (event.clientY - rect.top) / rect.height - 0.5;
    el.style.setProperty('--ry', `${(x * 4).toFixed(2)}deg`);
    el.style.setProperty('--rx', `${(-y * 4).toFixed(2)}deg`);
  }

  protected untilt() {
    const el = this.host.nativeElement;
    el.style.removeProperty('--rx');
    el.style.removeProperty('--ry');
  }
}
