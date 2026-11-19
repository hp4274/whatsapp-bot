import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

/** One product from the number's WhatsApp Business catalog (server channels catalog route). */
export interface CatalogProduct {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** In the currency's main unit (e.g. rupees, not paise). */
  readonly price: number;
  /** What the customer pays while the product is on sale; `price` is then the old price. */
  readonly salePrice: number | null;
  readonly currency: string;
  /** Same-origin `/api/...` path: load it with `[mediaSrc]`, a plain src gets 401. */
  readonly image: string | null;
  readonly images: readonly string[];
  readonly url: string;
  readonly retailerId: string;
  readonly hidden: boolean;
  /** WhatsApp's review: 'APPROVED' | 'PENDING' | 'REJECTED', or '' when it did not say. */
  readonly status: string;
  readonly canAppeal: boolean;
  /** WhatsApp's own words ('in stock', 'out of stock'), or '' when it did not say. */
  readonly availability: string;
  readonly collectionIds: readonly string[];
}

export interface CatalogCollection {
  readonly id: string;
  readonly name: string;
  readonly productIds: readonly string[];
  readonly status: string;
}

export interface CatalogHoursDay {
  /** 'sun' … 'sat'. */
  readonly day: string;
  /** 'open_24h' | 'specific_hours' | 'appointment_only'. */
  readonly mode: string;
  /** 'HH:MM', set only for specific_hours. */
  readonly open: string | null;
  readonly close: string | null;
}

/** The business profile customers see above the catalog in WhatsApp. */
export interface CatalogBusiness {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly address: string;
  readonly email: string;
  readonly websites: readonly string[];
  readonly hours: { readonly timezone: string; readonly days: readonly CatalogHoursDay[] } | null;
}

export interface Catalog {
  readonly business: CatalogBusiness | null;
  /** The public https://wa.me/c/<number> page of this catalog, or ''. */
  readonly link: string;
  readonly products: readonly CatalogProduct[];
  readonly collections: readonly CatalogCollection[];
  readonly total: number;
  /** WhatsApp has more products than the server read. */
  readonly truncated: boolean;
  readonly fetchedAt: string;
}

type Loose<T> = { readonly [K in keyof T]?: T[K] | null };

/** What the route may really send: any field can be missing. */
export type RawCatalog = Loose<Omit<Catalog, 'products' | 'collections' | 'business'>> & {
  readonly business?: Loose<CatalogBusiness> | null;
  readonly products?: readonly Loose<CatalogProduct>[] | null;
  readonly collections?: readonly Loose<CatalogCollection>[] | null;
};

/**
 * The answer with every field present. A server from before the business profile, sale prices and review details
 * leaves those out, and one missing array would take the whole drawer down in the template.
 */
export function toCatalog(raw: RawCatalog): Catalog {
  const collections = (raw.collections ?? []).map((c) => ({
    id: c.id ?? '',
    name: c.name ?? '',
    productIds: c.productIds ?? [],
    status: c.status ?? '',
  }));
  const products = (raw.products ?? []).map((p) => {
    const id = p.id ?? '';
    const images = p.images ?? (p.image ? [p.image] : []);
    return {
      id,
      name: p.name ?? '',
      description: p.description ?? '',
      price: p.price ?? 0,
      salePrice: p.salePrice ?? null,
      currency: p.currency ?? '',
      image: p.image ?? images[0] ?? null,
      images,
      url: p.url ?? '',
      retailerId: p.retailerId ?? '',
      hidden: p.hidden ?? false,
      status: p.status ?? '',
      canAppeal: p.canAppeal ?? false,
      availability: p.availability ?? '',
      collectionIds: p.collectionIds ?? collections.filter((c) => c.productIds.includes(id)).map((c) => c.id),
    };
  });
  const b = raw.business;
  return {
    business: b
      ? {
          name: b.name ?? '',
          description: b.description ?? '',
          category: b.category ?? '',
          address: b.address ?? '',
          email: b.email ?? '',
          websites: b.websites ?? [],
          hours: b.hours?.days?.length ? { timezone: b.hours.timezone ?? '', days: b.hours.days } : null,
        }
      : null,
    link: raw.link ?? '',
    products,
    collections,
    total: raw.total ?? products.length,
    truncated: raw.truncated ?? false,
    fetchedAt: raw.fetchedAt ?? '',
  };
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
      .get<RawCatalog>(`/api/channels/${channelId}/catalog`, { params: refresh ? { refresh: 1 } : {} })
      .pipe(map(toCatalog), catchError(toCatalogError));
  }

  import(channelId: number, ids: readonly string[]): Observable<{ created: number; skipped: number }> {
    return this.http
      .post<{ created: number; skipped: number }>(`/api/channels/${channelId}/catalog/import`, { ids })
      .pipe(catchError(toCatalogError));
  }
}
