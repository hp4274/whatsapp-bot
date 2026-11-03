import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError } from 'rxjs';

import { money, toMessage } from './plans-api';

export type CommissionType = 'percent' | 'fixed';

/** A marketer and their totals (server referrals.js). Amounts are whole rupees. */
export interface Referrer {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly code: string;
  readonly commissionType: CommissionType;
  readonly commissionValue: number;
  readonly status: 'active' | 'paused';
  readonly createdAt: string;
  /** Businesses they brought. */
  readonly clients: number;
  /** Earned, not yet paid out; below 0 when a payment removed after payout is still to be taken back. */
  readonly pending: number;
  readonly paid: number;
}

export interface ReferrerInput {
  name: string;
  email: string;
  phone: string;
  /** '' = made from the name. */
  code: string;
  commissionType: CommissionType;
  commissionValue: number;
  status: 'active' | 'paused';
}

export interface ReferralClient {
  readonly tenantId: number;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly since: string;
}

/** One payment earned on, at the rate copied onto it then; a minus amount takes back one already paid out. */
export interface Commission {
  readonly id: number;
  readonly tenantId: number;
  readonly tenantName: string | null;
  readonly triggerAmount: number;
  readonly currency: string;
  readonly commissionType: CommissionType;
  readonly commissionValue: number;
  readonly amount: number;
  readonly status: 'pending' | 'paid' | 'reversed';
  readonly note: string;
  readonly payoutRef: string;
  readonly paidAt: string | null;
  readonly createdAt: string;
}

export interface ReferrerDetail {
  readonly referrer: Referrer;
  readonly clients: ReferralClient[];
  readonly commissions: Commission[];
}

/** "10% of each payment" or "₹500 a payment". */
export function rateText(type: CommissionType, value: number): string {
  return type === 'percent' ? `${value}% of each payment` : `${money(value, 'INR')} a payment`;
}

/** The marketer's link: the site's front page with their code. */
export function referralLink(code: string): string {
  return `${location.origin}/?ref=${encodeURIComponent(code)}`;
}

/** Super admin: marketers, the businesses they brought, and paying their commission. */
@Injectable({ providedIn: 'root' })
export class ReferralsApi {
  private readonly http = inject(HttpClient);
  private readonly base = '/api/admin/referrals';

  list(): Observable<{ referrers: Referrer[] }> {
    return this.http.get<{ referrers: Referrer[] }>(this.base).pipe(catchError(toMessage));
  }

  get(id: number): Observable<ReferrerDetail> {
    return this.http.get<ReferrerDetail>(`${this.base}/${id}`).pipe(catchError(toMessage));
  }

  create(input: ReferrerInput): Observable<{ referrer: Referrer }> {
    return this.http.post<{ referrer: Referrer }>(this.base, input).pipe(catchError(toMessage));
  }

  update(id: number, input: Partial<ReferrerInput>): Observable<{ referrer: Referrer }> {
    return this.http.put<{ referrer: Referrer }>(`${this.base}/${id}`, input).pipe(catchError(toMessage));
  }

  addClient(id: number, tenantId: number): Observable<{ clients: ReferralClient[] }> {
    return this.http.post<{ clients: ReferralClient[] }>(`${this.base}/${id}/clients`, { tenantId }).pipe(catchError(toMessage));
  }

  removeClient(id: number, tenantId: number): Observable<{ clients: ReferralClient[] }> {
    return this.http.delete<{ clients: ReferralClient[] }>(`${this.base}/${id}/clients/${tenantId}`).pipe(catchError(toMessage));
  }

  /** The marketer who brought a business; null for none. */
  forTenant(tenantId: number): Observable<{ referrer: Referrer | null }> {
    return this.http.get<{ referrer: Referrer | null }>(`/api/admin/tenants/${tenantId}/referrer`).pipe(catchError(toMessage));
  }

  payout(id: number, reference: string): Observable<{ amount: number; referrer: Referrer }> {
    return this.http
      .post<{ amount: number; referrer: Referrer }>(`${this.base}/${id}/payout`, { reference })
      .pipe(catchError(toMessage));
  }
}
