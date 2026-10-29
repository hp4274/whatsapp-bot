import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { catchError, throwError } from 'rxjs';

/** One business's saved number read (server: GET /api/admin/number-collections). */
interface NumberCollection {
  readonly tenantId: number;
  readonly tenantName: string;
  readonly account: string;
  readonly numbers: readonly string[];
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
    const url = URL.createObjectURL(
      new Blob([`phone\n${row.numbers.join('\n')}\n`], { type: 'text/csv;charset=utf-8' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `numbers-${row.tenantId}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
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
