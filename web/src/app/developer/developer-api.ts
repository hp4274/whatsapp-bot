/**
 * Typed client for the tenant key/webhook management routes in
 * server/src/publicapi/routes.js. Secrets (`key`, `secret`) exist only in the
 * create responses; list responses carry a prefix / secretHint instead.
 */

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export interface ApiKey {
  id: number;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}
export interface CreatedApiKey extends ApiKey { key: string }

export interface WebhookEndpoint {
  id: number;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
  secretHint?: string;
}
export interface CreatedEndpoint extends WebhookEndpoint { secret: string }

export interface WebhookDelivery {
  id: number;
  endpointId: number;
  eventType: string;
  status: 'pending' | 'delivered' | 'failed' | string;
  attempt: number;
  responseCode: number | null;
  error: string | null;
  createdAt: string;
}

@Injectable({ providedIn: 'root' })
export class DeveloperApi {
  private readonly http = inject(HttpClient);

  private req<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Observable<T> {
    return this.http.request<T>(method, path, { body }).pipe(catchError(toMessage));
  }

  keys() { return this.req<{ keys: ApiKey[]; scopes: string[] }>('GET', '/api/api-keys'); }
  createKey(body: { name: string; scopes: string[] }) { return this.req<{ key: CreatedApiKey }>('POST', '/api/api-keys', body); }
  revokeKey(id: number) { return this.req<{ key: ApiKey }>('DELETE', `/api/api-keys/${id}`); }

  endpoints() { return this.req<{ endpoints: WebhookEndpoint[]; events: string[] }>('GET', '/api/webhook-endpoints'); }
  createEndpoint(body: { url: string; events: string[] }) { return this.req<{ endpoint: CreatedEndpoint }>('POST', '/api/webhook-endpoints', body); }
  updateEndpoint(id: number, body: Partial<Pick<WebhookEndpoint, 'url' | 'events' | 'isActive'>>) {
    return this.req<{ endpoint: WebhookEndpoint }>('PUT', `/api/webhook-endpoints/${id}`, body);
  }
  deleteEndpoint(id: number) { return this.req<{ deleted: number }>('DELETE', `/api/webhook-endpoints/${id}`); }
  deliveries(id: number) { return this.req<{ deliveries: WebhookDelivery[] }>('GET', `/api/webhook-endpoints/${id}/deliveries`); }
}

function toMessage(error: HttpErrorResponse) {
  const body = error.error as { errors?: string[] } | null;
  return throwError(() => new Error(body?.errors?.join(' ') || error.message || 'Request failed'));
}
