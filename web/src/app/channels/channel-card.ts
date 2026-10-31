import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Observable } from 'rxjs';

import { Channel, ChannelPatch, ChannelsApi } from '../core/api';
import { NumberQuestions } from '../connection/number-questions';
import { ChannelSettings } from './channel-settings';
import { LIVE_LABEL, describeDays, liveState, transportMeta } from './channel-meta';

type Editing = 'name' | 'phone' | null;

/** Read once: the tilt is decorative, so a mid-session preference change can wait for a reload. */
const REDUCED =
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * One WhatsApp number: live state, today's sends, quality, and its controls.
 * The daily allowance is one plain line; a newly linked QR number that has not
 * answered its 2 questions can answer them right on the card.
 */
@Component({
  selector: 'app-channel-card',
  imports: [ChannelSettings, NumberQuestions],
  templateUrl: './channel-card.html',
  styleUrl: './channel-card.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.active]': 'active()',
    '[class.off]': "channel().status !== 'active'",
    '[class.open]': 'open()',
    '[attr.data-state]': 'state()',
    '(pointermove)': 'tilt($event)',
    '(pointerleave)': 'untilt()',
  },
})
export class ChannelCard {
  private readonly api = inject(ChannelsApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly channel = input.required<Channel>();
  readonly capabilities = input<string[]>([]);
  readonly active = input(false);
  /** The page's pick of the number to send on next (channels.ts recommendedId). */
  readonly recommended = input(false);
  readonly canDelete = input(false);

  /** Something changed server-side: the page should reload the list. */
  readonly changed = output<void>();
  /** Make this the number later requests run against. */
  readonly use = output<void>();
  /** Open the Connection page for this number (QR scan or credentials). */
  readonly connect = output<void>();

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly editing = signal<Editing>(null);
  protected readonly draftValue = signal('');
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');

  protected readonly state = computed(() => liveState(this.channel()));
  protected readonly stateLabel = computed(() => LIVE_LABEL[this.state()]);
  protected readonly transport = computed(() =>
    transportMeta(this.channel().health?.transport || this.channel().provider),
  );
  protected readonly needsConnect = computed(() => this.state() === 'disconnected');

  protected readonly usage = computed(() => this.channel().health?.usage ?? null);
  /** The inline questions form, opened from the "Answer" button. */
  protected readonly asking = signal(false);
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
    if (!hours) return 'Always open';
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
    queueMicrotask(() => {
      const el = this.editor()?.nativeElement;
      el?.focus();
      el?.select();
    });
  }

  protected cancelEdit() {
    this.editing.set(null);
  }

  protected commitEdit(event?: Event) {
    event?.preventDefault();
    const field = this.editing();
    if (!field) return;
    const value = this.draftValue().trim();
    if (field === 'name' && !value) {
      this.error.set('A number needs a label.');
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
    this.run(this.api.update(this.channel().id, patch), done);
  }

  protected makeDefault() {
    this.run(this.api.makeDefault(this.channel().id));
  }

  protected remove() {
    this.run(this.api.remove(this.channel().id));
  }

  private run(call: Observable<unknown>, done?: () => void) {
    this.busy.set(true);
    this.error.set('');
    call.subscribe({
      next: () => {
        this.busy.set(false);
        done?.();
        this.changed.emit();
      },
      error: (err: Error) => {
        this.busy.set(false);
        this.error.set(err.message);
      },
    });
  }

  // --------------------------------------------------------------- tilt --
  /** A few degrees of perspective toward the pointer; off when editing or reduced motion. */
  protected tilt(event: PointerEvent) {
    if (REDUCED || this.open() || event.pointerType !== 'mouse') return;
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

  protected toggleOpen() {
    this.untilt();
    this.open.update((v) => !v);
  }
}
