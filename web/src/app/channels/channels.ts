import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { Channel, ChannelsApi } from '../core/api';
import { Store } from '../core/store';
import { ChannelCard } from './channel-card';
import { liveState, localZone, timeZones, transportMeta } from './channel-meta';

/** Only the active number streams live events; the rest are polled this often. */
const POLL_MS = 30_000;

const emptyDraft = () => ({
  displayName: '',
  phoneNumber: '',
  transport: 'cloud_api',
  timezone: localZone(),
});

/**
 * Every WhatsApp number the tenant owns, as a rack of cards. Adding a number
 * only records it; credentials and QR login live on the Connection page, so
 * the form stays short and cannot half-connect a number.
 */
@Component({
  selector: 'app-channels',
  imports: [FormsModule, ChannelCard],
  templateUrl: './channels.html',
  styleUrl: './channels.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelsView {
  private readonly api = inject(ChannelsApi);
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly channels = signal<Channel[]>([]);
  protected readonly capabilities = signal<string[]>([]);
  protected readonly transports = signal<string[]>([]);
  protected readonly warnings = signal<Record<string, string>>({});
  protected readonly loading = signal(true);
  protected readonly loadError = signal('');
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly showForm = signal(false);
  protected readonly draft = signal(emptyDraft());
  protected readonly activeId = this.store.channelId;
  protected readonly zones = timeZones(localZone());
  protected readonly meta = transportMeta;

  private readonly firstField = viewChild<ElementRef<HTMLInputElement>>('firstField');

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

  protected readonly transportOptions = computed(() =>
    this.transports().map((value) => ({ value, ...transportMeta(value) })),
  );

  constructor() {
    this.refresh();
    this.store.watch(['channels', 'history', 'campaign'], () => this.refresh());

    // Connection events arrive for the number in use; reflect them on its card.
    effect(() => {
      this.store.connection().connected;
      untracked(() => {
        if (!this.loading()) this.refresh();
      });
    });

    // Other numbers do not stream events here, so poll gently while visible.
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') this.refresh();
    }, POLL_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  protected refresh() {
    this.api.list().subscribe({
      next: ({ channels, capabilities, transports, warnings }) => {
        this.channels.set(channels);
        this.capabilities.set(capabilities);
        this.transports.set(transports);
        this.warnings.set(warnings ?? {});
        this.loadError.set('');
        this.loading.set(false);
      },
      error: (err: Error) => {
        this.loadError.set(err.message);
        this.loading.set(false);
      },
    });
  }

  protected toggleForm() {
    const open = !this.showForm();
    this.showForm.set(open);
    this.formError.set('');
    if (open) {
      if (!this.transports().includes(this.draft().transport) && this.transports().length) {
        this.draft.update((d) => ({ ...d, transport: this.transports()[0] }));
      }
      queueMicrotask(() => this.firstField()?.nativeElement.focus());
    }
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
      this.formError.set('Give the number a label so your team can recognise it.');
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
        settings: { transport: d.transport as Channel['provider'] },
      })
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.showForm.set(false);
          this.draft.set(emptyDraft());
          this.refresh();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.formError.set(err.message);
        },
      });
  }

  /** Work on this number: later requests carry its id. */
  protected use(channel: Channel) {
    this.store.useChannel(channel.id);
    this.refresh();
  }

  /** Disconnected numbers go to the connection page, already pointed at them. */
  protected connect(channel: Channel) {
    this.store.useChannel(channel.id);
    this.router.navigate(['/connection'], { queryParams: { channel: channel.id } });
  }
}
