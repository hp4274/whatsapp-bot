import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, throwError } from 'rxjs';

/**
 * Super-admin template moderation endpoints (`/api/admin/template-*`): the
 * review queue for Baileys templates, the starter library every tenant can
 * copy from, and the per-tenant Meta status counts.
 */

export type StarterCategory = 'marketing' | 'utility' | 'authentication';

export interface SpamReason {
  readonly points: number;
  readonly reason: string;
}

export interface QueuedTemplate {
  readonly id: string | number;
  readonly tenantId: string | number;
  readonly tenantName: string;
  readonly name: string;
  readonly templateType: string;
  readonly body: string;
  readonly category: string;
  readonly interactive: object | null;
  readonly headerMediaId: string | null;
  readonly reviewStatus: '' | 'pending';
  /** `baileys`: only usable on Baileys numbers; `all`: every transport. */
  readonly mode: 'baileys' | 'all';
  readonly spam: { readonly score: number; readonly reasons: readonly SpamReason[] };
  readonly updatedAt: string;
}

export interface Starter {
  readonly id: string | number;
  readonly name: string;
  readonly category: StarterCategory;
  readonly description: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type StarterInput = Pick<Starter, 'name' | 'category' | 'description' | 'body'>;

export interface TenantMetaStatus {
  readonly tenantId: string | number;
  readonly tenantName: string;
  readonly total: number;
  readonly approved: number;
  readonly pending: number;
  readonly rejected: number;
  readonly draft: number;
  readonly lastSynced: string | null;
}

/** The server answers `{ errors: string[] }`; the first one is the actionable message. */
const toMessage = (error: HttpErrorResponse) => {
  const errors = error.error?.errors;
  return throwError(
    () =>
      new Error(
        Array.isArray(errors) && errors.length
          ? String(errors[0])
          : error.error?.message || error.message || 'Request failed',
      ),
  );
};

const seg = (v: string | number) => encodeURIComponent(String(v));

@Injectable({ providedIn: 'root' })
export class TemplateReviewApi {
  private readonly http = inject(HttpClient);

  queue(): Observable<readonly QueuedTemplate[]> {
    return this.http
      .get<{ templates: QueuedTemplate[] }>('/api/admin/template-review')
      .pipe(map((r) => r.templates), catchError(toMessage));
  }

  decide(t: QueuedTemplate, action: 'approve' | 'reject', note: string): Observable<unknown> {
    return this.http
      .post(`/api/admin/template-review/${seg(t.tenantId)}/${seg(t.id)}/${action}`, { note })
      .pipe(catchError(toMessage));
  }

  starters(): Observable<readonly Starter[]> {
    return this.http
      .get<{ starters: Starter[] }>('/api/admin/template-library')
      .pipe(map((r) => r.starters), catchError(toMessage));
  }

  /** Creates when `id` is null, otherwise replaces that starter. */
  saveStarter(id: string | number | null, body: StarterInput): Observable<Starter> {
    const req =
      id == null
        ? this.http.post<{ starter: Starter }>('/api/admin/template-library', body)
        : this.http.put<{ starter: Starter }>(`/api/admin/template-library/${seg(id)}`, body);
    return req.pipe(map((r) => r.starter), catchError(toMessage));
  }

  deleteStarter(id: string | number): Observable<unknown> {
    return this.http.delete(`/api/admin/template-library/${seg(id)}`).pipe(catchError(toMessage));
  }

  meta(): Observable<readonly TenantMetaStatus[]> {
    return this.http
      .get<{ tenants: TenantMetaStatus[] }>('/api/admin/template-meta')
      .pipe(map((r) => r.tenants), catchError(toMessage));
  }
}
