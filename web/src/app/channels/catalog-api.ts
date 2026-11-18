import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, throwError } from 'rxjs';

/** One product from the number's WhatsApp Business catalog (server channels catalog route). */
export interface CatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** In the currency's main unit (e.g. rupees, not paise). */
  readonly price: number;
  readonly currency: string;
  /** Same-origin `/api/...` path: load it with `[mediaSrc]`, a plain src gets 401. */
  readonly image: string | null;
  readonly images: readonly string[];
  readonly url: string;
  readonly retailerId: string;
  readonly hidden: boolean;
  readonly status: string;
}

export interface CatalogCollection {
  readonly id: string;
  readonly name: string;
  readonly productIds: readonly string[];
}

export interface Catalog {
  readonly products: readonly CatalogProduct[];
  readonly collections: readonly CatalogCollection[];
  readonly fetchedAt: string;
}

/** The codes the catalog routes answer with; anything else (a network failure) is ''. */
export type CatalogErrorCode =
  | 'not_connected'
  | 'not_business'
  | 'catalog_disabled'
  | 'catalog_failed'
  | 'orders_off'
  | 'not_found'
  | '';

/** The server's sentence plus its `code`, so the drawer can pick the state to show and not parse words. */
export class CatalogError extends Error {
  constructor(
    message: string,
    readonly code: CatalogErrorCode,
  ) {
    super(message);
  }
}

function toCatalogError(error: HttpErrorResponse): Observable<never> {
  const body = error.error as { errors?: unknown; code?: unknown } | null;
  const errors = Array.isArray(body?.errors) ? body.errors.join('\n') : '';
  const message =
    errors ||
    (error.status === 0
      ? "Couldn't reach Wuzie. Check your internet connection and try again."
      : 'Something went wrong on our side. Try again in a moment.');
  const code = typeof body?.code === 'string' ? (body.code as CatalogErrorCode) : '';
  return throwError(() => new CatalogError(message, code));
}

/** The WhatsApp Business catalog of one number, and copying its products into the Orders list. */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);

  /** `refresh` asks WhatsApp again instead of the server's recent copy. */
  get(channelId: number, refresh = false): Observable<Catalog> {
    return this.http
      .get<Catalog>(`/api/channels/${channelId}/catalog`, { params: refresh ? { refresh: 1 } : {} })
      .pipe(catchError(toCatalogError));
  }

  import(channelId: number, ids: readonly string[]): Observable<{ created: number; skipped: number }> {
    return this.http
      .post<{ created: number; skipped: number }>(`/api/channels/${channelId}/catalog/import`, { ids })
      .pipe(catchError(toCatalogError));
  }
}
