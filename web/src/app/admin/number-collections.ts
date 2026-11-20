import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, throwError } from 'rxjs';

import { downloadCsv, toCsv, today } from '../analytics/analytics-util';
import { hue, initials, spacedPhone } from '../contacts/contact-util';
import { countryOf } from '../core/phone-input';
import { AdminFeed } from './admin-feed';

/** One business's saved number read (server: GET /api/admin/number-collections). */
interface NumberCollection {
  readonly tenantId: number;
  readonly tenantName: string;
  readonly account: string;
  readonly numbers: readonly string[];
  /** The address-book name, else the WhatsApp profile name or username; '' when WhatsApp gave none. */
  readonly contacts: readonly { readonly phone: string; readonly name: string }[];
  readonly count: number;
  readonly createdAt: string;
}

/** One saved number as a row of the table, with the country its calling code names. */
interface NumberRow {
  readonly phone: string;
  readonly name: string;
  readonly country: string;
  readonly tenantId: number;
  readonly business: string;
}

const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(
    () => new Error(Array.isArray(errors) && errors.length ? errors.join('\n') : error.message || 'Request failed'),
  );
};

/** "India", or "+880" for a calling code the country list does not have. */
const countryLabel = (phone: string) => countryOf(phone) || spacedPhone(phone).split(' ')[0];

/** The countries shown as quick filters beside the search; the rest are reached by searching. */
const COUNTRY_CHIPS = 5;

/**
 * The super admin's saved reads of each business's WhatsApp numbers, laid out like the business's own Contacts:
 * totals on top, the businesses down the left (as Contacts lists its segments), and every saved number in one
 * searchable table with the country its calling code names. A save is a snapshot: one per business, replaced
 * when saved again.
 */
@Component({
  selector: 'app-number-collections',
  templateUrl: './number-collections.html',
  styleUrl: './number-collections.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NumberCollectionsView {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly collections = signal<NumberCollection[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly notice = signal('');
  /** The business shown; null = every business. */
  protected readonly tenantId = signal<number | null>(null);
  /** The country filter; '' = any. */
  protected readonly country = signal('');
  /** What is typed in the search box; `query` follows it once typing pauses. */
  protected readonly typed = signal('');
  private readonly query = signal('');
  /** The business whose delete is waiting on a second click. */
  protected readonly confirmDelete = signal<number | null>(null);
  protected readonly deleting = signal(false);

  protected readonly spacedPhone = spacedPhone;
  protected readonly hue = hue;
  protected readonly initials = initials;

  /** Every saved number, each with its business and country. */
  private readonly all = computed<NumberRow[]>(() =>
    this.collections().flatMap((c) =>
      c.contacts.map((n) => ({ ...n, country: countryLabel(n.phone), tenantId: c.tenantId, business: this.name(c) })),
    ),
  );
  /** The shown business's numbers (all of them when none is picked). */
  private readonly inScope = computed(() => {
    const id = this.tenantId();
    return id === null ? this.all() : this.all().filter((r) => r.tenantId === id);
  });
  protected readonly selected = computed(() => this.collections().find((c) => c.tenantId === this.tenantId()) ?? null);

  /** Countries in scope, most numbers first: the quick filters and the "Countries" total. */
  protected readonly countries = computed(() => {
    const counts = new Map<string, number>();
    for (const r of this.inScope()) counts.set(r.country, (counts.get(r.country) ?? 0) + 1);
    return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  });
  protected readonly countryChips = computed(() => {
    const top = this.countries().slice(0, COUNTRY_CHIPS);
    // A picked country outside the top few still shows as a chip, so it can be switched off.
    const picked = this.countries().find((c) => c.name === this.country());
    return picked && !top.includes(picked) ? [...top, picked] : top;
  });

  protected readonly matches = computed(() => {
    const q = this.query().trim().toLowerCase();
    const digits = q.replace(/\D/g, '');
    const country = this.country();
    return this.inScope().filter(
      (r) =>
        (!country || r.country === country) &&
        (!q || r.name.toLowerCase().includes(q) || r.country.toLowerCase().includes(q) ||
          r.business.toLowerCase().includes(q) || (digits !== '' && r.phone.includes(digits))),
    );
  });
  // shortcut: renders the first 500 matches only, add paging if admins need to scroll past that.
  protected readonly shown = computed(() => this.matches().slice(0, 500));
  protected readonly filtered = computed(() => Boolean(this.query().trim() || this.country()));

  protected readonly totals = computed(() => {
    const list = this.collections();
    const latest = list.reduce<string | null>((max, c) => (!max || c.createdAt > max ? c.createdAt : max), null);
    return { businesses: list.length, numbers: this.all().length, countries: new Set(this.all().map((r) => r.country)).size, latest };
  });

  constructor() {
    this.load();
    inject(AdminFeed).watch(['tenants', 'number-collections'], () => this.load(true));
    effect((onCleanup) => {
      const q = this.typed();
      const timer = setTimeout(() => this.query.set(q), 300);
      onCleanup(() => clearTimeout(timer));
    });
  }

  protected load(quiet = false): void {
    if (!quiet) this.loading.set(true);
    this.error.set('');
    this.http
      .get<{ collections: NumberCollection[] }>('/api/admin/number-collections')
      .pipe(catchError(toMessage), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ collections }) => {
          this.collections.set(collections);
          // The business shown was deleted elsewhere: back to every business.
          if (this.tenantId() !== null && !collections.some((c) => c.tenantId === this.tenantId())) this.tenantId.set(null);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected pick(tenantId: number | null): void {
    this.tenantId.set(tenantId);
    this.country.set('');
    this.confirmDelete.set(null);
  }

  protected setCountry(name: string): void {
    this.country.set(this.country() === name ? '' : name);
  }

  protected clearFilters(): void {
    this.typed.set('');
    this.query.set('');
    this.country.set('');
  }

  protected remove(row: NumberCollection): void {
    this.deleting.set(true);
    this.notice.set('');
    this.http
      .delete(`/api/admin/number-collections/${row.tenantId}`)
      .pipe(catchError(toMessage), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.deleting.set(false);
          this.confirmDelete.set(null);
          if (this.tenantId() === row.tenantId) this.tenantId.set(null);
          this.collections.update((rows) => rows.filter((r) => r.tenantId !== row.tenantId));
          this.notice.set(`${this.name(row)}'s collection deleted.`);
        },
        error: (err: Error) => {
          this.deleting.set(false);
          this.error.set(err.message);
        },
      });
  }

  /** What the table shows (search and country applied), for copy, CSV and PDF. */
  private exportTitle(): string {
    const who = this.selected() ? this.name(this.selected()!) : 'All businesses';
    return this.country() ? `${who} · ${this.country()}` : who;
  }

  protected async copy(): Promise<void> {
    this.notice.set('');
    try {
      await navigator.clipboard.writeText(this.matches().map((r) => r.phone).join('\n'));
      this.notice.set(`${this.matches().length} numbers copied (${this.exportTitle()}).`);
    } catch {
      this.error.set('Could not copy. Use the download instead.');
    }
  }

  protected download(): void {
    downloadCsv(
      `${this.fileName()}.csv`,
      toCsv(['phone', 'name', 'country', 'business'], this.matches().map((r) => [r.phone, r.name, r.country, r.business])),
    );
  }

  /**
   * Print a name-and-number table from a hidden frame; the browser's print dialog
   * offers "Save as PDF", so no PDF library is needed.
   */
  protected pdf(): void {
    const rows = this.matches();
    const frame = Object.assign(document.createElement('iframe'), { title: 'Print preview' });
    frame.style.cssText = 'position: fixed; width: 0; height: 0; border: 0';
    document.body.append(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) return frame.remove();
    // Names come from WhatsApp users, so they go in as text, never as markup.
    const el = (tag: string, text = '') => Object.assign(doc.createElement(tag), { textContent: text });
    doc.title = this.fileName(); // the suggested PDF file name
    doc.head.append(
      el(
        'style',
        `body { font: 12px system-ui, sans-serif; margin: 24px; }
        h1 { font-size: 18px; margin: 0 0 4px; } p { margin: 0 0 16px; opacity: .7; }
        table { width: 100%; border-collapse: collapse; }
        th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid; }
        th { font-weight: 600; } td.n { width: 1%; opacity: .6; } td.p { font-family: monospace; white-space: nowrap; }
        tr { break-inside: avoid; }`,
      ),
    );
    const many = this.tenantId() === null;
    const table = doc.createElement('table');
    const head = table.createTHead().insertRow();
    ['#', 'Name', 'Phone', 'Country', ...(many ? ['Business'] : [])].forEach((label) => head.append(el('th', label)));
    const body = table.createTBody();
    rows.forEach((r, i) => {
      body.insertRow().append(
        Object.assign(el('td', String(i + 1)), { className: 'n' }),
        el('td', r.name || '—'),
        Object.assign(el('td', spacedPhone(r.phone)), { className: 'p' }),
        el('td', r.country),
        ...(many ? [el('td', r.business)] : []),
      );
    });
    const sel = this.selected();
    doc.body.append(
      el('h1', this.exportTitle()),
      el('p', `${rows.length} numbers${sel?.account ? ` · account ${spacedPhone(sel.account)}` : ''}${sel ? ` · saved ${this.when(sel.createdAt)}` : ''}`),
      table,
    );
    win.addEventListener('afterprint', () => frame.remove());
    win.print();
  }

  private fileName(): string {
    return `numbers-${this.tenantId() ?? 'all'}-${today()}`;
  }

  protected name(row: NumberCollection): string {
    return row.tenantName || `Business #${row.tenantId}`;
  }

  protected when(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
}
