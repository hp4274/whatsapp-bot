import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';

import { AdminFeed } from './admin-feed';
import { money } from './plans-api';
import { ReferralDrawer } from './referral-drawer';
import { Referrer, ReferralsApi, rateText, referralLink } from './referrals-api';

/**
 * Marketers who bring businesses to Wapzo, and the commission they earn on what those businesses pay. The table is
 * who is owed what; a row opens the marketer's drawer (details, link, businesses, commissions, pay).
 */
@Component({
  selector: 'app-admin-referrals',
  imports: [ReferralDrawer],
  templateUrl: './referrals.html',
  styleUrl: './referrals.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReferralsView {
  private readonly api = inject(ReferralsApi);

  protected readonly rows = signal<Referrer[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly query = signal('');
  /** The drawer: a marketer's id, 'new', or closed. */
  protected readonly open = signal<number | 'new' | null>(null);
  /** The code whose link was just copied, for the button's "Copied". */
  protected readonly copied = signal('');

  /** Most owed first: the number this page exists for. */
  protected readonly visible = computed(() => {
    const q = this.query().trim().toLowerCase();
    return this.rows()
      .filter((r) => !q || `${r.name} ${r.code} ${r.email} ${r.phone}`.toLowerCase().includes(q))
      .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name));
  });
  protected readonly totals = computed(() =>
    this.rows().reduce(
      (t, r) => ({
        pending: t.pending + Math.max(0, r.pending),
        owed: t.owed + (r.pending > 0 ? 1 : 0),
        paid: t.paid + r.paid,
        clients: t.clients + r.clients,
        active: t.active + (r.status === 'active' ? 1 : 0),
      }),
      { pending: 0, owed: 0, paid: 0, clients: 0, active: 0 },
    ),
  );

  constructor() {
    this.load();
    // A payment recorded on a referred business earns here at once.
    inject(AdminFeed).watch(['referrals'], () => this.load(true));
  }

  protected load(quiet = false): void {
    this.api.list().subscribe({
      next: ({ referrers }) => {
        this.rows.set(referrers);
        this.loading.set(false);
        if (quiet) this.error.set('');
      },
      error: (err: Error) => {
        this.loading.set(false);
        if (!quiet) this.error.set(err.message);
      },
    });
  }

  protected copy(code: string): void {
    void navigator.clipboard?.writeText(referralLink(code)).then(() => {
      this.copied.set(code);
      setTimeout(() => this.copied.update((c) => (c === code ? '' : c)), 1800);
    });
  }

  protected money(amount: number): string {
    return money(amount, 'INR');
  }

  protected rate(r: Referrer): string {
    return rateText(r.commissionType, r.commissionValue);
  }
}
