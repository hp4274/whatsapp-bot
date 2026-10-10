import { Component, ElementRef, computed, inject, input, output, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { Observable } from 'rxjs';

import { Channel, ChannelPatch, ChannelsApi } from '../core/api';
import { ChannelSettings } from './channel-settings';
import { LIVE_LABEL, describeDays, liveState, transportMeta } from './channel-meta';

type Editing = 'name' | 'phone' | null;

const REDUCED = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** One WhatsApp number: live state, today's budget, quality, and its controls. */
@Component({
  selector: 'app-channel-card',
  imports: [DatePipe, ChannelSettings],
  templateUrl: './channel-card.html',
  styleUrl: './channel-card.scss',
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
  readonly canDelete = input(false);

  /** Something changed server-side: the page should reload the list. */
  readonly changed = output<void>();
  readonly use = output<void>();
  readonly connect = output<void>();

  protected readonly open = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly editing = signal<Editing>(null);
  protected readonly draftValue = signal('');
  private readonly editor = viewChild<ElementRef<HTMLInputElement>>('editor');

  protected readonly state = computed(() => liveState(this.channel()));
  protected readonly stateLabel = computed(() => LIVE_LABEL[this.state()]);
  protected readonly transport = computed(() => transportMeta(this.channel().health?.transport || this.channel().provider));
  protected readonly needsConnect = computed(() => this.state() === 'disconnected');

  protected readonly usage = computed(() => this.channel().health?.usage ?? null);
  protected readonly warmup = computed(() => this.channel().health?.warmup ?? null);
  protected readonly quality = computed(() => this.channel().health?.quality ?? null);
  protected readonly hints = computed(() => this.quality()?.hints ?? []);

  /** 0..1 share of today's cap, or null when there is no cap. */
  protected readonly usedShare = computed(() => {
    const u = this.usage();
    if (!u || !u.dailyLimit) return null;
    return Math.min(1, u.sentToday / u.dailyLimit);
  });

  protected readonly meterTone = computed(() => {
    const share = this.usedShare() ?? 0;
    return share >= 0.9 ? 'hot' : share >= 0.7 ? 'warm' : 'cool';
  });

  protected readonly warmupSteps = computed(() => {
    const w = this.warmup();
    if (!w) return [];
    // Too many segments become noise; cap the strip at 14 and scale.
    const steps = Math.min(w.totalDays, 14);
    const done = Math.round((w.day / w.totalDays) * steps);
    return Array.from({ length: steps }, (_, i) => i < done);
  });

  protected readonly windowText = computed(() => {
    const hours = this.channel().businessHours;
    if (!hours) return 'Always open';
    return `${describeDays(hours.days)} · ${hours.start}-${hours.end}`;
  });

  protected readonly hintIcon = { bad: 'error', warn: 'warning', info: 'info', ok: 'check_circle' } as const;

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
    this.save(field === 'name' ? { displayName: value } : { phoneNumber: value }, () => this.editing.set(null));
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
