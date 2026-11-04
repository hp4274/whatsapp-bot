import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError } from 'rxjs';

import type { User } from '../core/auth';
import type { Permissions } from './admin-sections';
import { toMessage } from './plans-api';

/** A staff role and how many people hold it (server adminRoles.js). */
export interface AdminRole {
  readonly id: number;
  readonly name: string;
  readonly permissions: Permissions;
  readonly staff: number;
}

/** Settings > Roles & staff, whole: every change answers with it, so the page never patches lists by hand. */
export interface StaffPage {
  readonly roles: readonly AdminRole[];
  /** Every platform user: full super admins (no adminRoleId) first in age, staff among them. */
  readonly staff: readonly User[];
  /** Adding someone: whether their sign-in went out by email. */
  readonly mail?: { readonly sent: boolean; readonly reason?: string };
}

export interface StaffInput {
  name: string;
  email: string;
  /** '' keeps the current one when editing. */
  password: string;
  roleId: number;
}

@Injectable({ providedIn: 'root' })
export class StaffApi {
  private readonly http = inject(HttpClient);

  load(): Observable<StaffPage> {
    return this.http.get<StaffPage>('/api/admin/staff').pipe(catchError(toMessage));
  }

  saveRole(id: number | null, body: { name: string; permissions: Permissions }): Observable<StaffPage> {
    const req = id === null ? this.http.post<StaffPage>('/api/admin/roles', body) : this.http.put<StaffPage>(`/api/admin/roles/${id}`, body);
    return req.pipe(catchError(toMessage));
  }

  deleteRole(id: number): Observable<StaffPage> {
    return this.http.delete<StaffPage>(`/api/admin/roles/${id}`).pipe(catchError(toMessage));
  }

  saveStaff(id: number | null, body: StaffInput): Observable<StaffPage> {
    const req = id === null ? this.http.post<StaffPage>('/api/admin/staff', body) : this.http.put<StaffPage>(`/api/admin/staff/${id}`, body);
    return req.pipe(catchError(toMessage));
  }

  removeStaff(id: number): Observable<StaffPage> {
    return this.http.delete<StaffPage>(`/api/admin/staff/${id}`).pipe(catchError(toMessage));
  }
}
