import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

/**
 * Ordering and booking on WhatsApp: `order` is part of the Orders feature, `booking` of Appointments
 * (server/src/shop/). Each mode has its own settings, list and orders; every call names the mode.
 */
export type ShopMode = 'order' | 'booking';

export interface ShopSettings {
  readonly enabled: boolean;
  /** Fixed by the URL the settings were read from; ignored when sent back. */
  readonly mode?: ShopMode;
  readonly title: string;
  readonly currency: string;
  readonly upiId: string;
  readonly payeeName: string;
  readonly qrMediaId: string;
  readonly payNow: boolean;
  readonly askAddress: boolean;
  readonly deliveryFee: number;
  readonly note: string;
  readonly info: string;
  /** Bookings: remind the customer this many hours before (0 = off). */
  readonly reminderHours: number;
  /** Message the owner on each new order/booking and each PAID reply. */
  readonly alertOwner: boolean;
}

export interface ProductVariant {
  name: string;
  price: number;
}

export interface Product {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly price: number;
  readonly variants: ProductVariant[];
  /** Uploaded picture ids (served at /api/media/<id>), up to 5; the first is the cover. */
  readonly images: string[];
  readonly active: boolean;
}

export type ProductPayload = Omit<Product, 'id'>;

export type PaymentState = 'pending' | 'claimed' | 'paid' | 'none';

/** An order or appointment business object the chat created (objects/types.js). */
export interface ShopOrder {
  readonly id: number;
  readonly type: 'order' | 'appointment';
  readonly reference: string;
  readonly status: string;
  readonly createdAt: string;
  readonly data: {
    readonly amount?: number;
    readonly currency?: string;
    readonly items?: string;
    readonly notes?: string;
    readonly service?: string;
    readonly scheduledAt?: string;
  };
  readonly metadata: {
    readonly phone?: string;
    readonly payment?: PaymentState;
    readonly total?: number;
    readonly address?: string;
    /** What was ordered, with the product it came from (for its cover picture). */
    readonly lines?: readonly { readonly productId: number }[];
  };
}

export interface ShopState {
  readonly settings: ShopSettings;
  readonly products: Product[];
  readonly orders: ShopOrder[];
  /** The record type's statuses (order or appointment), in order. */
  readonly statuses: string[];
  /** What the platform allows this business (super admin's Rules for Orders / Appointments). */
  readonly rules: ShopRules;
}

export interface ShopRules {
  readonly allowWhatsapp: boolean;
  readonly allowUpi: boolean;
  /** Null when there is no limit. */
  readonly maxProducts: number | null;
  /** Bookings only: whether the business may send reminders. */
  readonly allowReminders: boolean;
}

@Injectable({ providedIn: 'root' })
export class ShopApi {
  private readonly http = inject(HttpClient);

  get(mode: ShopMode): Observable<ShopState> {
    return this.http.get<ShopState>(`/api/shop/${mode}`).pipe(catchError(toMessage));
  }

  saveSettings(mode: ShopMode, patch: Partial<ShopSettings>): Observable<{ settings: ShopSettings }> {
    return this.http
      .put<{ settings: ShopSettings }>(`/api/shop/${mode}/settings`, patch)
      .pipe(catchError(toMessage));
  }

  saveProduct(mode: ShopMode, p: ProductPayload, id: number | null): Observable<{ product: Product }> {
    const req =
      id === null
        ? this.http.post<{ product: Product }>(`/api/shop/${mode}/products`, p)
        : this.http.put<{ product: Product }>(`/api/shop/${mode}/products/${id}`, p);
    return req.pipe(catchError(toMessage));
  }

  removeProduct(mode: ShopMode, id: number): Observable<{ deleted: boolean }> {
    return this.http
      .delete<{ deleted: boolean }>(`/api/shop/${mode}/products/${id}`)
      .pipe(catchError(toMessage));
  }

  /** Marking paid or changing the status also messages the customer (unless `notify` is false). */
  moveOrder(
    mode: ShopMode,
    id: number,
    body: { status?: string; payment?: 'paid'; notify?: boolean },
  ): Observable<{ order: ShopOrder; notified: boolean }> {
    return this.http
      .post<{ order: ShopOrder; notified: boolean }>(`/api/shop/${mode}/orders/${id}`, body)
      .pipe(catchError(toMessage));
  }

  upload(file: File): Observable<{ mediaId: string }> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<{ mediaId: string }>('/api/media/upload', form).pipe(catchError(toMessage));
  }
}

/** Surface the server's own words (same rule as core/api.ts). */
function toMessage(error: HttpErrorResponse) {
  const errors = error.error?.errors;
  const message =
    Array.isArray(errors) && errors.length
      ? errors.join('\n')
      : error.error?.message || error.message || 'Request failed';
  return throwError(() => new Error(message));
}
