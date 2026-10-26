/**
 * Typed client for /api/templates. Wire contract with the templates routes in
 * server/src/app.js and server/src/templates/store.js - change both together.
 */

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import type { InteractiveDraft } from '../campaign/interactive/interactive.model';
import { linkify } from '../campaign/wa-format';

export type { InteractiveDraft };

export const TEMPLATE_TYPES = [
  'text',
  'media',
  'interactive',
  'notification',
] as const;
/** Template categories; the server defaults new templates to 'marketing'. */
export const TEMPLATE_CATEGORIES = ['marketing', 'utility', 'authentication'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export type TemplateType = (typeof TEMPLATE_TYPES)[number];

export interface Template {
  id: number;
  name: string;
  templateType: TemplateType;
  body: string;
  variables: string[];
  channelId: number | null;
  currentVersion: number;
  useCount: number;
  lastUsedAt: string | null;
  category: TemplateCategory;
  sampleValues: Record<string, string>;
  headerMediaId: string | null;
  interactive: InteractiveDraft | null;
  /** Platform review (server templates/policy.js). '' = never reviewed. */
  reviewStatus: ReviewStatus;
  reviewNote: string;
  spam: SpamScore;
  createdAt: string;
  updatedAt: string;
}

export type ReviewStatus = '' | 'pending' | 'approved' | 'rejected';

/** Server heuristic: a plain sum of named points, so the editor can say why. */
export interface SpamScore {
  readonly score: number;
  readonly reasons: readonly { readonly points: number; readonly reason: string }[];
}

/** A platform-wide starter a super admin curates; copying makes an ordinary tenant template. */
export interface Starter {
  readonly id: number;
  readonly name: string;
  readonly category: TemplateCategory;
  readonly description: string;
  readonly body: string;
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
  category: TemplateCategory;
  sampleValues: Record<string, string>;
  headerMediaId: string | null;
  interactive: InteractiveDraft | null;
}

export interface UploadedMedia {
  mediaId: string;
  filename: string;
  mimetype: string;
  size: number;
  url: string;
  /** Storage fields, present when the server keeps uploads (no UI here yet). */
  storageId?: number;
  duplicate?: boolean;
  firstUploadedAt?: string;
}

/** Error carrying the HTTP status, so the page can tell a 403 from a 400. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
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
      .get<{ template: Template; versions: TemplateVersion[]; compatibility: string[] }>(
        `/api/templates/${id}`,
      )
      .pipe(catchError(toError));
  }
  create(body: TemplateDraft) {
    return this.http
      .post<{ template: Template; warnings: string[] }>('/api/templates', body)
      .pipe(catchError(toError));
  }
  update(id: number, body: Partial<TemplateDraft>) {
    return this.http
      .put<{ template: Template }>(`/api/templates/${id}`, body)
      .pipe(catchError(toError));
  }
  remove(id: number) {
    return this.http.delete<{ deleted: number }>(`/api/templates/${id}`).pipe(catchError(toError));
  }
  revert(id: number, version: number) {
    return this.http
      .post<{ template: Template }>(`/api/templates/${id}/revert`, { version })
      .pipe(catchError(toError));
  }
  /** Live score for a draft, plus the platform limit it is judged against (100 = off). */
  spamScore(body: Pick<TemplateDraft, 'body' | 'interactive'>) {
    return this.http
      .post<SpamScore & { limit: number }>('/api/templates/spam-score', body)
      .pipe(catchError(toError));
  }
  library() {
    return this.http
      .get<{ starters: Starter[] }>('/api/templates/library')
      .pipe(catchError(toError));
  }
  copyStarter(id: number, name: string) {
    return this.http
      .post<{ template: Template }>(`/api/templates/library/${id}/copy`, { name })
      .pipe(catchError(toError));
  }
  upload(file: File) {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<UploadedMedia>('/api/media/upload', form).pipe(catchError(toError));
  }
  /** Media needs the bearer token, so an <img src> cannot fetch it directly. */
  mediaBlob(mediaId: string) {
    return this.http
      .get(`/api/media/${encodeURIComponent(mediaId)}`, { responseType: 'blob' })
      .pipe(catchError(toError));
  }
}

function toError(error: HttpErrorResponse): Observable<never> {
  const body = error.error as { errors?: string[] } | null;
  return throwError(
    () => new ApiError(body?.errors?.join(' ') || error.message || 'Request failed', error.status),
  );
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
    .replace(
      /\{(\w+)\|([^{}]*)\}/g,
      (_, key: string, fallback: string) => sample[key] || fallback || `[${key}]`,
    )
    .replace(/\{(\w+)\}/g, (_, key: string) => sample[key] || `[${key}]`)
    .trim();
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * WhatsApp formatting for a preview: *bold* _italic_ ~strike~ ```mono``` `code`.
 * HTML is escaped first, so the output only ever contains the tags added here -
 * safe to bind with [innerHTML]. Code spans are split out so * _ ~ stay literal in them.
 */
export function formatWhatsApp(text: string): string {
  return escapeHtml(String(text ?? ''))
    .split(/(```[\s\S]+?```|`[^`\n]+`)/g)
    .map((part, i) => {
      if (i % 2) {
        return part.startsWith('```')
          ? `<code class="mono">${part.slice(3, -3)}</code>`
          : `<code>${part.slice(1, -1)}</code>`;
      }
      return part
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?!\w)/g, '$1<b>$2</b>')
        .replace(/(^|[^\w_])_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1<i>$2</i>')
        .replace(/(^|[^\w~])~(?=\S)([^~\n]*?\S)~(?!\w)/g, '$1<s>$2</s>');
    })
    .join('');
}

const VAR_ON = '\u0001';
const VAR_OFF = '\u0002';
const MISS_ON = '\u0003';
const MISS_OFF = '\u0004';

/**
 * Preview HTML for a template body: `render()` plus WhatsApp formatting, with
 * substituted values wrapped in `<mark class="var">` (so you can see what is a
 * variable) and placeholders nothing fills in `<mark class="missing">`. Links
 * are styled. `missing` lists the keys with neither a sample nor a fallback.
 */
export function previewHtml(
  body: string,
  sample: Record<string, string>,
): { html: string; text: string; missing: string[] } {
  const missing: string[] = [];
  const value = (key: string, fallback = '') => {
    const v = sample[key] || fallback;
    if (v) return `${VAR_ON}${v}${VAR_OFF}`;
    if (!missing.includes(key)) missing.push(key);
    return `${MISS_ON}${key}${MISS_OFF}`;
  };
  const marked = String(body ?? '')
    .replace(/\{(\w+)\|([^{}]*)\}/g, (_, key: string, fallback: string) => value(key, fallback))
    .replace(/\{(\w+)\}/g, (_, key: string) => value(key))
    .trim();
  const html = linkify(formatWhatsApp(marked))
    .replace(/\u0001([^\u0002]*)\u0002/g, '<mark class="var">$1</mark>')
    .replace(/\u0003(\w+)\u0004/g, '<mark class="missing">{$1}</mark>');
  const text = marked.replace(/[\u0001\u0002]/g, '').replace(/\u0003(\w+)\u0004/g, '{$1}');
  return { html, text, missing };
}
