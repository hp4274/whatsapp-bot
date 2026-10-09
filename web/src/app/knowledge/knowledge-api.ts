/**
 * Typed client for the knowledge base. Wire contract with
 * server/src/knowledge/routes.js (+ store.js shapes) - change both together.
 *
 * GET /api/knowledge is the one dashboard read; item/category writes live
 * under /api/faq and need the admin role (agents get 403).
 */

import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export const MATCH_TYPES = ['CONTAINS', 'EXACT', 'SIMILARITY', 'REGEX', 'FALLBACK'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];
export type MatchLevel = 'exact' | 'contains' | 'regex' | 'similarity' | 'fallback' | 'ai';

export interface FaqCategory {
  id: number;
  name: string;
  slug: string;
  position: number;
  itemCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface FaqItem {
  id: number;
  categoryId: number | null;
  question: string;
  answer: string;
  keywords: string[];
  matchType: MatchType;
  locale: string;
  isActive: boolean;
  priority: number;
  hitCount: number;
  missCount: number;
  outOfHours: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FaqMiss { id: number; text: string; count: number; lastSeenAt: string }

export interface FaqStats {
  items: number;
  activeItems: number;
  categories: number;
  hits: number;
  misses: number;
  distinctMisses: number;
  coverage: number; // 0..1
  topItems: { id: number; question: string; hits: number; misses: number }[];
  topMisses: FaqMiss[];
}

export interface KnowledgeDashboard {
  categories: FaqCategory[];
  items: FaqItem[];
  stats: FaqStats;
  misses: FaqMiss[];
  similarityThreshold: number;
}

export interface FaqInput {
  question: string;
  answer: string;
  keywords: string[];
  categoryId: number | null;
  matchType: MatchType;
  locale: string;
  isActive: boolean;
  priority: number;
  outOfHours: boolean;
}

export interface MatchResult {
  match: { item: FaqItem; level: MatchLevel; score: number } | null;
  level: MatchLevel | null;
  score: number;
  escalate: boolean;
  threshold: number;
}

@Injectable({ providedIn: 'root' })
export class KnowledgeApi {
  private readonly http = inject(HttpClient);

  dashboard() { return this.wrap(this.http.get<KnowledgeDashboard>('/api/knowledge')); }

  createItem(body: FaqInput) { return this.wrap(this.http.post<{ item: FaqItem }>('/api/faq', body)); }
  updateItem(id: number, body: Partial<FaqInput>) { return this.wrap(this.http.put<{ item: FaqItem }>(`/api/faq/${id}`, body)); }
  deleteItem(id: number) { return this.wrap(this.http.delete<{ deleted: boolean }>(`/api/faq/${id}`)); }

  createCategory(name: string, position: number) {
    return this.wrap(this.http.post<{ category: FaqCategory }>('/api/faq/categories', { name, position }));
  }
  updateCategory(id: number, body: { name?: string; position?: number }) {
    return this.wrap(this.http.put<{ category: FaqCategory }>(`/api/faq/categories/${id}`, body));
  }
  deleteCategory(id: number) { return this.wrap(this.http.delete<{ deleted: boolean }>(`/api/faq/categories/${id}`)); }

  misses(limit = 100) { return this.wrap(this.http.get<{ misses: FaqMiss[] }>(`/api/faq/misses?limit=${limit}`)); }
  dismissMiss(id: number) { return this.wrap(this.http.delete<{ deleted: boolean }>(`/api/faq/misses/${id}`)); }

  /** Dry run: never records analytics, never sends. */
  match(text: string, ignoreBusinessHours: boolean) {
    return this.wrap(this.http.post<MatchResult>('/api/faq/match', { text, ignoreBusinessHours }));
  }

  private wrap<T>(source: Observable<T>): Observable<T> {
    return source.pipe(catchError((error: HttpErrorResponse) => {
      const body = error.error as { errors?: string[] } | null;
      const message = error.status === 403 && !body?.errors?.length
        ? 'You do not have permission to do that.'
        : body?.errors?.join(' ') || (error.status === 0 ? 'Server unreachable. Check your connection.' : error.message) || 'Request failed';
      return throwError(() => Object.assign(new Error(message), { status: error.status }));
    }));
  }
}

/* Client-side mirror of server/src/knowledge/matcher.js nearestFaq(), used only
 * to list the runner-up candidates the match endpoint does not return. */
export function normalizeText(text: string): string {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = (text: string) => new Set(normalizeText(text).split(' ').filter(Boolean));

function dice(a: Set<string>, b: Set<string>) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

export function similarity(text: string, item: FaqItem): number {
  const asked = tokens(text);
  const phrases = [...item.keywords, item.question].map(normalizeText).filter(Boolean);
  return Math.max(0, ...phrases.map((p) => dice(asked, tokens(p))));
}
