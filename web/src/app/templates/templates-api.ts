/**
 * Typed client for /api/templates. Wire contract with the templates routes in
 * server/src/app.js and server/src/templates/store.js - change both together.
 */

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export const TEMPLATE_TYPES = ['text', 'media', 'provider_template', 'interactive', 'notification'] as const;
export const APPROVAL_STATUSES = ['draft', 'pending', 'approved', 'rejected'] as const;
export type TemplateType = (typeof TEMPLATE_TYPES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export interface Template {
  id: number;
  name: string;
  templateType: TemplateType;
  body: string;
  variables: string[];
  channelId: number | null;
  providerTemplateName: string;
  approvalStatus: ApprovalStatus;
  currentVersion: number;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateVersion {
  id: number;
  templateId: number;
  version: number;
  body: string;
  variables: string[];
  createdAt: string;
}

export interface TemplateDraft {
  name: string;
  templateType: TemplateType;
  body: string;
  variables: string[];
  providerTemplateName: string;
  approvalStatus: ApprovalStatus;
}

/** Error carrying the HTTP status, so the page can tell a 403 from a 400. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

@Injectable({ providedIn: 'root' })
export class TemplatesApi {
  private readonly http = inject(HttpClient);

  list() {
    return this.http.get<{ templates: Template[] }>('/api/templates').pipe(catchError(toError));
  }
  get(id: number) {
    return this.http
      .get<{ template: Template; versions: TemplateVersion[]; compatibility: string[] }>(`/api/templates/${id}`)
      .pipe(catchError(toError));
  }
  create(body: TemplateDraft) {
    return this.http.post<{ template: Template; warnings: string[] }>('/api/templates', body).pipe(catchError(toError));
  }
  update(id: number, body: Partial<TemplateDraft>) {
    return this.http.put<{ template: Template }>(`/api/templates/${id}`, body).pipe(catchError(toError));
  }
  remove(id: number) {
    return this.http.delete<{ deleted: number }>(`/api/templates/${id}`).pipe(catchError(toError));
  }
  revert(id: number, version: number) {
    return this.http.post<{ template: Template }>(`/api/templates/${id}/revert`, { version }).pipe(catchError(toError));
  }
}

function toError(error: HttpErrorResponse): Observable<never> {
  const body = error.error as { errors?: string[] } | null;
  return throwError(() => new ApiError(body?.errors?.join(' ') || error.message || 'Request failed', error.status));
}

// ------------------------------------------------ mirrors of the server ---
// Same regexes as server/src/templates/store.js so the editor can warn and
// preview without a round trip (the preview endpoint only renders saved bodies).
const PLACEHOLDER = /\{(\w+)(?:\|[^{}]*)?\}/g;
const BRACED = /\{([^{}]*)\}/g;

/** The variables a body references, in first-use order. */
export function usedIn(body: string): string[] {
  return [...new Set([...body.matchAll(PLACEHOLDER)].map((m) => m[1]))];
}

/** Problems the server would reject a save for. */
export function validate(body: string): string[] {
  const problems: string[] = [];
  if ((body.match(/\{/g) ?? []).length !== (body.match(/\}/g) ?? []).length) {
    problems.push('Unbalanced braces: every { needs a matching }');
  }
  for (const [, inner] of body.matchAll(BRACED)) {
    if (!/^\w+(\|[^{}]*)?$/.test(inner)) problems.push(`Malformed placeholder: {${inner}}`);
  }
  return problems;
}

/** `personalize()` without spintax: blank samples use the fallback, else `[key]`. */
export function render(body: string, sample: Record<string, string>): string {
  return body
    .replace(/\{(\w+)\|([^{}]*)\}/g, (_, key: string, fallback: string) => sample[key] || fallback || `[${key}]`)
    .replace(/\{(\w+)\}/g, (_, key: string) => sample[key] || `[${key}]`)
    .trim();
}
