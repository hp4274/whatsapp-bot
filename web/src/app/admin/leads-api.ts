import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError } from 'rxjs';

import type { Tenant, User } from '../core/auth';
import { Payment, toMessage } from './plans-api';

export type LeadStatus = 'new' | 'converted' | 'dismissed';

/** An account request from the landing page or the sign-in dialog (server leads.js). */
export interface Lead {
  readonly id: number;
  readonly name: string;
  readonly business: string;
  readonly email: string;
  readonly phone: string;
  readonly message: string;
  readonly source: 'landing' | 'login';
  readonly status: LeadStatus;
  /** Set once converted: the business it became. */
  readonly tenantId: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What converting a lead sends; owner name and email default to the lead's on the server. */
export interface LeadConversion {
  name: string;
  slug: string;
  planKey: string;
  trialDays: number;
  payment: Payment;
  owner: { name: string; email: string; password: string };
  /** Email the owner their sign-in details (server mail/emails.js welcomeEmail). */
  sendWelcome: boolean;
}

/** What converting returns; `email` says whether the welcome email went, and why not. */
export interface ConvertResult {
  readonly tenant: Tenant;
  readonly owner: User;
  readonly lead: Lead;
  readonly email: { readonly sent: boolean; readonly reason?: string };
}

/** Super admin: the account requests and turning one into a tenant. */
@Injectable({ providedIn: 'root' })
export class LeadsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<{ leads: Lead[]; counts: Record<LeadStatus, number> }> {
    return this.http
      .get<{ leads: Lead[]; counts: Record<LeadStatus, number> }>('/api/admin/leads')
      .pipe(catchError(toMessage));
  }

  setStatus(id: number, status: 'new' | 'dismissed'): Observable<{ lead: Lead }> {
    return this.http
      .patch<{ lead: Lead }>(`/api/admin/leads/${id}`, { status })
      .pipe(catchError(toMessage));
  }

  convert(id: number, body: LeadConversion): Observable<ConvertResult> {
    return this.http
      .post<ConvertResult>(`/api/admin/leads/${id}/convert`, body)
      .pipe(catchError(toMessage));
  }
}
