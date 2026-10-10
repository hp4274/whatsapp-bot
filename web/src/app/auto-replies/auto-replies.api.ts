import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import { InteractiveDraft } from '../campaign/interactive/interactive.model';

/* Contract types --------------------------------------------------------- */

export interface Media {
  mediaId: string;
  filename?: string;
  mimetype?: string;
  url?: string;
}

export type Interactive = InteractiveDraft;

export interface MenuNode {
  replyBody: string;
  variants?: string[];
  media?: Media | null;
  interactive?: Interactive | null;
  menu?: Record<string, MenuNode>;
  actions?: { addTag?: string; escalate?: boolean };
}

export interface RuleStats {
  hits: number;
  lastTriggeredAt: string | null;
  today: number;
  week: number;
}

export type MatchType = 'EXACT' | 'CONTAINS' | 'STARTS_WITH' | 'REGEX' | 'ANY_OF' | 'FUZZY' | 'FALLBACK';
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface RuleSchedule {
  days: string[];
  start: string;
  end: string;
  outsideReply: string;
}

export interface RuleAudience {
  type: 'all' | 'new' | 'tag';
  tag?: string;
}

export interface RuleActions {
  addTag?: string;
  setField?: { key: string; value: string } | null;
  escalate?: boolean;
  stop: boolean;
}

export interface AutoReplyRule {
  id: number;
  name: string;
  priority: number;
  matchType: MatchType;
  keyword: string;
  keywords: string[];
  replyBody: string;
  variants: string[];
  media: Media | null;
  interactive: Interactive | null;
  menu: Record<string, MenuNode>;
  schedule: RuleSchedule | null;
  audience: RuleAudience;
  actions: RuleActions;
  isActive: boolean;
  stats: RuleStats;
  createdAt: string;
  updatedAt: string;
}

export type RulePayload = Omit<AutoReplyRule, 'id' | 'stats' | 'createdAt' | 'updatedAt' | 'priority'> & { priority?: number };

export interface DayHours {
  open: boolean;
  start: string;
  end: string;
}

export interface AutoReplySettings {
  businessName: string;
  timezone: string;
  welcome: { enabled: boolean; text: string; media: Media | null };
  away: {
    enabled: boolean;
    text: string;
    media: Media | null;
    hours: Record<Weekday, DayHours>;
    holidays: string[];
    throttleHours: number;
  };
  fallback: { enabled: boolean; text: string; media: Media | null; throttleHours: number };
  handoff: { enabled: boolean; keywords: string[]; text: string; media: Media | null };
}

export type SystemKey = 'welcome' | 'away' | 'fallback' | 'handoff';
export type SystemStats = Record<SystemKey, RuleStats>;

export interface Session {
  ruleId: number;
  path: string[];
  expiresAt: string;
}

export interface TestRequest {
  body: string;
  sender: string;
  senderName?: string;
  at?: string;
  replyId?: string;
  firstContact?: boolean | null;
  tags?: string[] | null;
  session?: Session | null;
}

export interface TestReply {
  source: 'welcome' | 'away' | 'handoff' | 'menu' | 'rule' | 'schedule' | 'fallback' | 'help' | 'faq';
  ruleId: number | null;
  ruleName: string;
  text: string;
  media: Media | null;
  interactive: Interactive | null;
  fallbackText: string;
}

export interface TestResult {
  replies: TestReply[];
  actions: { type: 'tag' | 'field' | 'escalate' | 'menu'; detail: string }[];
  trace: string[];
  matched: { ruleId: number; matchType: string; keyword: string; score: number } | null;
  context: { firstContact: boolean; newContact: boolean; withinHours: boolean; localTime: string; tags: string[] };
  session: Session | null;
}

export interface UploadedMedia extends Media {
  filename: string;
  mimetype: string;
  size: number;
  url: string;
}

/* Service ---------------------------------------------------------------- */

@Injectable({ providedIn: 'root' })
export class AutoRepliesApi {
  private readonly http = inject(HttpClient);

  list(): Observable<{ rules: AutoReplyRule[] }> {
    return this.http.get<{ rules: AutoReplyRule[] }>('/api/auto-replies').pipe(catchError(toMessage));
  }

  create(rule: RulePayload): Observable<{ rule: AutoReplyRule }> {
    return this.http.post<{ rule: AutoReplyRule }>('/api/auto-replies', rule).pipe(catchError(toMessage));
  }

  update(id: number, patch: Partial<RulePayload>): Observable<{ rule: AutoReplyRule }> {
    return this.http.put<{ rule: AutoReplyRule }>(`/api/auto-replies/${id}`, patch).pipe(catchError(toMessage));
  }

  remove(id: number): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/auto-replies/${id}`).pipe(catchError(toMessage));
  }

  reorder(ids: number[]): Observable<{ rules: AutoReplyRule[] }> {
    return this.http.post<{ rules: AutoReplyRule[] }>('/api/auto-replies/reorder', { ids }).pipe(catchError(toMessage));
  }

  settings(): Observable<{ settings: AutoReplySettings; stats: SystemStats }> {
    return this.http
      .get<{ settings: AutoReplySettings; stats: SystemStats }>('/api/auto-replies/settings')
      .pipe(catchError(toMessage));
  }

  saveSettings(patch: Partial<AutoReplySettings>): Observable<{ settings: AutoReplySettings }> {
    return this.http.put<{ settings: AutoReplySettings }>('/api/auto-replies/settings', patch).pipe(catchError(toMessage));
  }

  test(req: TestRequest): Observable<TestResult> {
    return this.http.post<TestResult>('/api/auto-replies/test', req).pipe(catchError(toMessage));
  }

  upload(file: File): Observable<UploadedMedia> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<UploadedMedia>('/api/media/upload', form).pipe(catchError(toMessage));
  }
}

/** Surface the server's own words (same rule as core/api.ts). */
function toMessage(error: HttpErrorResponse) {
  const errors = error.error?.errors;
  const message = Array.isArray(errors) && errors.length
    ? errors.join('\n')
    : error.error?.message || error.message || 'Request failed';
  return throwError(() => new Error(message));
}

/* Page-wide toast -------------------------------------------------------- */

export interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'error';
}

@Injectable({ providedIn: 'root' })
export class ArToasts {
  readonly items = signal<Toast[]>([]);
  private seq = 0;

  ok(text: string): void {
    this.push(text, 'ok');
  }

  error(err: unknown): void {
    this.push(err instanceof Error ? err.message : String(err), 'error');
  }

  dismiss(id: number): void {
    this.items.update((list) => list.filter((t) => t.id !== id));
  }

  private push(text: string, tone: Toast['tone']): void {
    const id = ++this.seq;
    this.items.update((list) => [...list.slice(-3), { id, text, tone }]);
    setTimeout(() => this.dismiss(id), tone === 'ok' ? 3200 : 7000);
  }
}

/* Template variables ----------------------------------------------------- */

export const VARIABLES = ['name', 'first_name', 'phone', 'time_greeting', 'date', 'business_name'];

export interface SampleContact {
  name: string;
  phone: string;
  businessName: string;
  fields?: Record<string, string>;
}

/** Client-side mirror of the server's variable rendering, for the live preview only. */
export function renderTemplate(template: string, c: SampleContact, at = new Date()): string {
  const h = at.getHours();
  const values: Record<string, string> = {
    name: c.name,
    first_name: c.name.split(/\s+/)[0] ?? '',
    phone: c.phone,
    time_greeting: h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening',
    date: at.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }),
    business_name: c.businessName,
    ...(c.fields ?? {}),
  };
  return String(template ?? '').replace(/\{([a-z0-9_]+)(?:\|([^}]*))?\}/gi, (_, key: string, fallback?: string) =>
    values[key.toLowerCase()] || fallback || '');
}

export const DAYS: { key: Weekday; label: string }[] = [
  { key: 'mon', label: 'Mon' },
  { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' },
  { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' },
  { key: 'sat', label: 'Sat' },
  { key: 'sun', label: 'Sun' },
];

/** "3 min ago" style, for hit stats. */
export function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
