import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';

import { CatalogDrawer } from '../channels/catalog-drawer';
import { CatalogLocked } from '../channels/catalog-locked';
import { Channel, ChannelsApi } from '../core/api';
import { Store } from '../core/store';

/** Where a number stands for the catalog, and what the row offers. */
type CatalogState = 'business' | 'personal' | 'unknown' | 'offline';

/**
 * WhatsApp Catalog: every linked number and whether its catalog can be used. The catalog belongs to the WhatsApp
 * Business app, so a Business number opens it here (browse, import into Orders); a regular WhatsApp number shows it
 * locked with the way to switch; a number whose app type is not known yet can still open it, and WhatsApp's answer
 * decides.
 *
 * The drawer and the locked dialog are the same ones the WhatsApp page uses. "Link a WhatsApp Business number"
 * hands off to that page (?relink=<id>), which owns the sign-out + new QR flow.
 */
@Component({
  selector: 'app-catalog-page',
  imports: [RouterLink, CatalogDrawer, CatalogLocked],
  templateUrl: './catalog-page.html',
  styleUrl: './catalog-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CatalogPage {
  private readonly api = inject(ChannelsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly channels = signal<Channel[]>([]);
  /** The number whose drawer (Business) or locked dialog (regular WhatsApp) is open. */
  protected readonly open = signal<Channel | null>(null);

  protected readonly rows = computed(() => this.channels().map((ch) => ({ ch, state: stateOf(ch) })));
  /** Every number is known to be regular WhatsApp: time to suggest the Business app. */
  protected readonly allPersonal = computed(() => this.rows().length > 0 && this.rows().every((r) => r.state === 'personal'));

  constructor() {
    this.load();
    inject(Store).watch(['channels', 'connection'], () => this.load(true));
  }

  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set('');
    this.api
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ channels }) => {
          this.channels.set(channels.filter((c) => c.status === 'active'));
          this.loading.set(false);
        },
        error: (err: Error) => {
          // A live refresh that fails keeps the list it has; with no list yet there is only the error to show.
          if (!quiet || !this.channels().length) this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected relink(ch: Channel): void {
    this.open.set(null);
    void this.router.navigate(['/whatsapp'], { queryParams: { relink: ch.id } });
  }
}

function stateOf(ch: Channel): CatalogState {
  const h = ch.health;
  if (!h?.connected) return 'offline';
  if (h.accountType === 'business') return 'business';
  if (h.accountType === 'personal') return 'personal';
  return 'unknown';
}
