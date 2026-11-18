import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

/** A `payment` business object the sheet created (server/src/paymentDues.js). */
export interface Due {
  readonly id: number;
  readonly reference: string;
  readonly status: 'pending' | 'paid' | 'overdue' | 'failed' | 'refunded' | 'cancelled';
  readonly createdAt: string;
  readonly data: {
    readonly amount: number;
    readonly currency?: string;
    readonly dueAt: string;
    readonly paidAt?: string;
    readonly invoiceId?: string;
  };
  readonly metadata: {
    readonly phone?: string;
    readonly name?: string;
    readonly amountText?: string;
    readonly dueText?: string;
    /** 'claimed' once the customer wrote PAID: automatic reminders wait for the business to check. */
    readonly payment?: 'claimed' | 'paid';
    readonly reminders?: number;
    readonly lastRemindedAt?: string;
  };
}

export interface DueSettings {
  readonly template: string;
  readonly upiId: string;
  readonly payeeName: string;
  readonly currency: string;
  readonly auto: boolean;
  readonly daysBefore: number;
  readonly onDueDay: boolean;
  readonly everyDays: number;
  readonly maxFollowUps: number;
}

/** What the platform allows this business (super admin's Rules for Payment reminders). */
export interface DueRules {
  readonly allowUpi: boolean;
  readonly allowAuto: boolean;
  readonly maxFollowUps: number;
  /** Null when there is no limit. */
  readonly maxPerMonth: number | null;
  readonly sentThisMonth: number;
}

export interface DuesState {
  readonly dues: Due[];
  readonly settings: DueSettings;
  readonly rules: DueRules;
  /** The business's today, YYYY-MM-DD, so "overdue" agrees with the server's clock. */
  readonly today: string;
}

@Injectable({ providedIn: 'root' })
export class PaymentReminderApi {
  private readonly http = inject(HttpClient);

  dues(): Observable<DuesState> {
    return this.http.get<DuesState>('/api/payment-reminders/dues').pipe(catchError(toMessage));
  }

  saveSettings(patch: Partial<DueSettings>): Observable<{ settings: DueSettings }> {
    return this.http
      .put<{ settings: DueSettings }>('/api/payment-reminders/settings', patch)
      .pipe(catchError(toMessage));
  }

  /** `pending` also clears a customer's PAID claim, so automatic reminders start again. */
  move(id: number, status: 'paid' | 'pending' | 'cancelled'): Observable<{ due: Due }> {
    return this.http
      .post<{ due: Due }>(`/api/payment-reminders/dues/${id}`, { status })
      .pipe(catchError(toMessage));
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
