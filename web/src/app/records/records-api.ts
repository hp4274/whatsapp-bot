/**
 * Typed client for the generic business-object API (server/src/objects/routes.js).
 * The registry in server/src/objects/types.js is the source of truth for every
 * type's fields and statuses; this file only mirrors the wire shapes.
 */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

export type FieldKind = 'string' | 'number' | 'boolean' | 'datetime';
export type FieldValue = string | number | boolean;

export interface ObjectTypeSpec {
  label: string;
  fields: Record<string, FieldKind>;
  required: string[];
  statuses: string[];
  closed: string[];
  defaultStatus: string;
  occursAt?: string;
  events: Record<string, string>;
}

export interface ObjectTypesResponse {
  types: Record<string, ObjectTypeSpec>;
  eventTypes: string[];
}

export interface BusinessObject {
  id: number;
  tenantId: number;
  channelId: number | null;
  type: string;
  reference: string;
  contactId: number | null;
  status: string;
  data: Record<string, FieldValue>;
  metadata: Record<string, unknown>;
  occursAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObjectEvent {
  id: number;
  objectId: number;
  change: string;          // 'created' | 'updated' | ...
  field: string | null;
  from: string | null;     // encoded value (string) or null
  to: string | null;
  source: string;
  at: string;
}

export interface ObjectStats {
  total: number;
  byType: Record<string, { total: number; byStatus: Record<string, number> }>;
}

export interface ObjectInput {
  reference?: string;
  contactId?: number | null;
  status?: string;
  /** On update, `null` removes a field. */
  data?: Record<string, FieldValue | null>;
}

@Injectable({ providedIn: 'root' })
export class RecordsApi {
  private readonly http = inject(HttpClient);
  private types$?: Observable<ObjectTypesResponse>;

  /** The registry never changes at runtime, so one request serves the session. */
  types(): Observable<ObjectTypesResponse> {
    this.types$ ??= this.http.get<ObjectTypesResponse>('/api/object-types').pipe(
      catchError((e: HttpErrorResponse) => {
        this.types$ = undefined; // let the next call retry
        return toMessage(e);
      }),
      shareReplay(1),
    );
    return this.types$;
  }

  stats(): Observable<ObjectStats> {
    return this.http.get<ObjectStats>('/api/objects-stats').pipe(catchError(toMessage));
  }

  list(type: string, opts: { status?: string; limit?: number; offset?: number } = {}): Observable<{ objects: BusinessObject[]; total: number }> {
    let params = new HttpParams();
    if (opts.status) params = params.set('status', opts.status);
    if (opts.limit != null) params = params.set('limit', opts.limit);
    if (opts.offset != null) params = params.set('offset', opts.offset);
    return this.http
      .get<{ objects: BusinessObject[]; total: number }>(`/api/objects/${enc(type)}`, { params })
      .pipe(catchError(toMessage));
  }

  create(type: string, body: ObjectInput): Observable<BusinessObject> {
    return this.http.post<{ object: BusinessObject }>(`/api/objects/${enc(type)}`, body).pipe(
      map((r) => r.object),
      catchError(toMessage),
    );
  }

  update(type: string, id: number, patch: ObjectInput): Observable<BusinessObject> {
    return this.http.put<{ object: BusinessObject }>(`/api/objects/${enc(type)}/${id}`, patch).pipe(
      map((r) => r.object),
      catchError(toMessage),
    );
  }

  remove(type: string, id: number): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/objects/${enc(type)}/${id}`).pipe(catchError(toMessage));
  }

  events(type: string, id: number): Observable<ObjectEvent[]> {
    return this.http.get<{ events: ObjectEvent[] }>(`/api/objects/${enc(type)}/${id}/events`).pipe(
      map((r) => r.events),
      catchError(toMessage),
    );
  }
}

const enc = encodeURIComponent;

function toMessage(error: HttpErrorResponse) {
  const body = error.error as { errors?: string[] } | null;
  const fallback = error.status === 0 ? 'Cannot reach the server. Check your connection.' : error.message;
  return throwError(() => new Error(body?.errors?.join(' ') || fallback || 'Request failed'));
}
