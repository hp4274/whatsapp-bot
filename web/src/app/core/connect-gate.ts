import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';

import { ChannelsApi } from './api';
import { Auth } from './auth';
import { Store } from './store';

/** The page a business can still open before it has a number: linking one, and adding one. */
const OPEN_PAGES = ['/whatsapp'];

/**
 * The popup a business sees until its first WhatsApp number is linked: nothing else works without one.
 * It cannot be closed; only connecting a number (admins) or signing out ends it. Once any number was ever
 * linked it never shows again, so a number that drops offline later only gets the usual offline warnings.
 *
 * It also keeps the selected number honest. The shell mounts it for every role, and it already reads the
 * number list, so it is the one place that notices a selected number that no longer exists (deleted here or
 * in another session). Left in place, that id made every number-scoped request 404, across reloads.
 */
@Component({
  selector: 'app-connect-gate',
  imports: [RouterLink],
  templateUrl: './connect-gate.html',
  styleUrl: './connect-gate.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConnectGate {
  private readonly auth = inject(Auth);
  private readonly channelsApi = inject(ChannelsApi);
  private readonly router = inject(Router);
  private readonly store = inject(Store);

  readonly signOut = output<void>();

  /** Whether any number was ever linked; null until the list answers (and on an error, so it fails open). */
  private readonly linked = signal<boolean | null>(null);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );
  /** Agents cannot open the WhatsApp page (roleGuard('admin')): they are told to ask an admin. */
  protected readonly canConnect = computed(() => this.auth.atLeast('admin'));
  private readonly applies = computed(() => {
    const tenant = this.auth.tenant();
    return (
      !this.auth.isSuperAdmin() &&
      !!tenant &&
      tenant.services.includes('whatsapp_channels') &&
      tenant.subscription?.state !== 'expired' &&
      !this.auth.blocked()
    );
  });
  /**
   * A number is picked inside a business session (a super admin acting as one included): its id must still be
   * on the list. Checked even where the gate itself does not apply, because the stale id breaks every page.
   */
  private readonly checksPick = computed(
    () => this.auth.channelId() !== null && !!this.auth.tenantId() && !this.auth.blocked(),
  );
  protected readonly open = computed(
    () => this.applies() && this.linked() === false && !OPEN_PAGES.some((p) => this.url().startsWith(p)),
  );

  private readonly dialog = viewChild<ElementRef<HTMLDialogElement>>('dialog');

  constructor() {
    effect(() => {
      if (this.applies() || this.checksPick()) this.load();
    });
    this.store.watch(['channels', 'connection'], () => (this.applies() || this.checksPick()) && this.load());
    effect(() => {
      const el = this.dialog()?.nativeElement;
      if (el && !el.open) el.showModal();
    });
  }

  /** Only the newest list answer counts: an older one landing late could show the modal again. */
  private seq = 0;

  private load(): void {
    // Read now, not when the answer lands: a pick made while the list was in flight is checked by its own load.
    const picked = this.auth.channelId();
    const n = ++this.seq;
    this.channelsApi.list().subscribe({
      next: ({ channels }) => {
        if (n !== this.seq) return;
        this.linked.set(
          channels.some((c) => c.health?.connected || c.health?.connecting || !!c.providerAccountId),
        );
        // Back to the main number; useChannel tells every open page to reload against it.
        if (picked !== null && picked === this.auth.channelId() && !channels.some((c) => c.id === picked)) {
          this.store.useChannel(null);
        }
      },
      error: () => n === this.seq && this.linked.set(null),
    });
  }
}
