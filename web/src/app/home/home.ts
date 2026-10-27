import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';

import { relativeTime } from '../campaigns/campaign-format';
import { CampaignStatusPill } from '../campaigns/status-pill';
import { type Campaign, CampaignsApi } from '../core/api';
import { Auth } from '../core/auth';
import { Store } from '../core/store';

/** How many campaigns the home list shows before "View all" takes over. */
const RECENT_LIMIT = 5;

/** Messages that left: an explicit `sent`, else every status past the queue. */
function sentOf(c: Campaign): number {
  const s = c.stats ?? {};
  if (typeof s.sent === 'number') return s.sent;
  const by = s.byStatus ?? {};
  return (by['SENT'] ?? 0) + (by['DELIVERED'] ?? 0) + (by['READ'] ?? 0) + (by['SANDBOX'] ?? 0);
}

function failedOf(c: Campaign): number {
  return c.stats?.failed ?? c.stats?.byStatus?.['FAILED'] ?? 0;
}

/**
 * The tenant's landing page: is the number live, what to do next, and how
 * the latest sends went.
 *
 * Deliberately small. Everything here comes from the live connection signal
 * and one campaigns call, so it costs no more than opening the campaign list;
 * the deeper numbers stay on Analytics. Parts for services the tenant does not
 * have are left out rather than shown empty.
 */
@Component({
  selector: 'app-home',
  imports: [RouterLink, CampaignStatusPill],
  templateUrl: './home.html',
  styleUrl: './home.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Home {
  private readonly api = inject(CampaignsApi);
  private readonly auth = inject(Auth);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly store = inject(Store);

  protected readonly loading = signal(true);
  /** Set after the first answer, so live reloads refresh in place instead of flashing the skeleton. */
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  private readonly campaigns = signal<readonly Campaign[]>([]);

  /**
   * Whether the workspace has a service. A super admin inside a tenant is not
   * told that tenant's services here, so they see every part, as the API does.
   */
  private has(service: string): boolean {
    const owned = this.auth.isSuperAdmin() ? undefined : this.auth.tenant()?.services;
    return !owned || owned.includes(service);
  }

  protected readonly showConnection = computed(() => this.has('whatsapp_channels'));
  protected readonly showCampaigns = computed(() => this.has('bulk_messages'));

  protected readonly greeting = computed(() => {
    const name = this.auth.user()?.name?.trim().split(/\s+/)[0];
    return name ? `Welcome back, ${name}` : 'Welcome back';
  });

  /** Live number state, or null until the stream has said anything. */
  protected readonly connection = computed(() =>
    this.store.streamOnline() ? this.store.connection() : null,
  );

  protected readonly totals = computed(() => {
    const list = this.campaigns();
    return {
      campaigns: list.length,
      running: list.filter((c) => c.status === 'running').length,
      sent: list.reduce((sum, c) => sum + sentOf(c), 0),
      failed: list.reduce((sum, c) => sum + failedOf(c), 0),
    };
  });

  protected readonly recent = computed(() =>
    [...this.campaigns()]
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, RECENT_LIMIT)
      .map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        sent: sentOf(c),
        total: c.stats?.total ?? c.audienceSize ?? 0,
        when: c.startedAt ?? c.scheduledAt ?? c.createdAt,
      })),
  );

  constructor() {
    this.load();
    this.store.watch(['campaigns', 'campaign', 'history'], () => this.load());
  }

  protected load(): void {
    if (!this.showCampaigns()) {
      this.loading.set(false);
      return;
    }
    this.loading.set(true);
    this.api
      .list()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ campaigns }) => {
          this.campaigns.set(campaigns);
          this.error.set(null);
          this.loading.set(false);
          this.loaded.set(true);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected relative(iso: string | null): string {
    return relativeTime(iso, this.store.now());
  }

  protected format(n: number): string {
    return n.toLocaleString();
  }
}
