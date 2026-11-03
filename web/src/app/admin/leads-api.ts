import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError } from 'rxjs';

import type { Tenant, User } from '../core/auth';
import { toMessage } from './plans-api';

/** 'hold': read, waiting on the business to confirm; still open. */
export type LeadStatus = 'new' | 'hold' | 'converted' | 'dismissed';

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

/** Activating a pending business: whether the welcome email went, and why not. */
export interface ActivateResult {
  readonly tenant: Tenant;
  readonly owner: User;
  readonly email: { readonly sent: boolean; readonly reason?: string };
}

/** Super admin: the account requests, accepting one as a pending business, and switching that business on. */
@Injectable({ providedIn: 'root' })
export class LeadsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<{ leads: Lead[]; counts: Record<LeadStatus, number> }> {
    return this.http
      .get<{ leads: Lead[]; counts: Record<LeadStatus, number> }>('/api/admin/leads')
      .pipe(catchError(toMessage));
  }

  setStatus(id: number, status: 'new' | 'hold' | 'dismissed'): Observable<{ lead: Lead }> {
    return this.http
      .patch<{ lead: Lead }>(`/api/admin/leads/${id}`, { status })
      .pipe(catchError(toMessage));
  }

  /** Accept: the business and its owner become a pending tenant on the first active plan. */
  convert(id: number): Observable<{ tenant: Tenant; lead: Lead }> {
    return this.http
      .post<{ tenant: Tenant; lead: Lead }>(`/api/admin/leads/${id}/convert`, {})
      .pipe(catchError(toMessage));
  }

  /** The request a business was accepted from; null for one added by hand. */
  forTenant(tenantId: number): Observable<{ lead: Lead | null }> {
    return this.http
      .get<{ lead: Lead | null }>(`/api/admin/tenants/${tenantId}/lead`)
      .pipe(catchError(toMessage));
  }

  /** The business's sign-ins, for the owner's email in Tenant settings' left column. */
  users(tenantId: number): Observable<{ users: User[] }> {
    return this.http
      .get<{ users: User[] }>(`/api/admin/tenants/${tenantId}/users`)
      .pipe(catchError(toMessage));
  }

  /** Switch a pending business on: sets the owner's password and emails it unless `sendWelcome` is false. */
  activate(tenantId: number, body: { password: string; sendWelcome: boolean }): Observable<ActivateResult> {
    return this.http
      .post<ActivateResult>(`/api/admin/tenants/${tenantId}/activate`, body)
      .pipe(catchError(toMessage));
  }
}
