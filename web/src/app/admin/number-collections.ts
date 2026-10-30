import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, throwError } from 'rxjs';

import { downloadCsv, toCsv, today } from '../analytics/analytics-util';
import { spacedPhone } from '../contacts/contact-util';

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

const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(
    () => new Error(Array.isArray(errors) && errors.length ? errors.join('\n') : error.message || 'Request failed'),
  );
};

/**
 * The super admin's saved reads of each business's WhatsApp numbers. A save is a
 * snapshot, so the list is small: one row per business, replaced when saved again.
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

  protected readonly rows = signal<NumberCollection[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly notice = signal('');

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.http
      .get<{ collections: NumberCollection[] }>('/api/admin/number-collections')
      .pipe(catchError(toMessage), takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ collections }) => {
          this.rows.set(collections);
          this.loading.set(false);
        },
        error: (err: Error) => {
          this.error.set(err.message);
          this.loading.set(false);
        },
      });
  }

  protected async copy(row: NumberCollection): Promise<void> {
    this.notice.set('');
    try {
      await navigator.clipboard.writeText(row.numbers.join('\n'));
      this.notice.set(`${row.count} numbers from ${this.name(row)} copied.`);
    } catch {
      this.error.set('Could not copy. Use the download instead.');
    }
  }

  protected download(row: NumberCollection): void {
    downloadCsv(
      `${this.fileName(row)}.csv`,
      toCsv(['phone', 'name'], row.contacts.map((c) => [c.phone, c.name])),
    );
  }

  /**
   * Print a name-and-number table from a hidden frame; the browser's print dialog
   * offers "Save as PDF", so no PDF library is needed.
   */
  protected pdf(row: NumberCollection): void {
    const frame = Object.assign(document.createElement('iframe'), { title: 'Print preview' });
    frame.style.cssText = 'position: fixed; width: 0; height: 0; border: 0';
    document.body.append(frame);
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) return frame.remove();
    // Names come from WhatsApp users, so they go in as text, never as markup.
    const el = (tag: string, text = '') => Object.assign(doc.createElement(tag), { textContent: text });
    doc.title = this.fileName(row); // the suggested PDF file name
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
    const table = doc.createElement('table');
    const head = table.createTHead().insertRow();
    ['#', 'Name', 'Phone'].forEach((label) => head.append(el('th', label)));
    const body = table.createTBody();
    row.contacts.forEach((c, i) => {
      body.insertRow().append(
        Object.assign(el('td', String(i + 1)), { className: 'n' }),
        el('td', c.name || '—'),
        Object.assign(el('td', spacedPhone(c.phone)), { className: 'p' }),
      );
    });
    doc.body.append(
      el('h1', this.name(row)),
      el('p', `${row.count} numbers${row.account ? ` · account ${spacedPhone(row.account)}` : ''} · saved ${this.when(row.createdAt)}`),
      table,
    );
    win.addEventListener('afterprint', () => frame.remove());
    win.print();
  }

  private fileName(row: NumberCollection): string {
    return `numbers-${row.tenantId}-${today()}`;
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
