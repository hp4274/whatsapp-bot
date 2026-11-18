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

export type MatchType =
  | 'EXACT'
  | 'CONTAINS'
  | 'STARTS_WITH'
  | 'REGEX'
  | 'ANY_OF'
  | 'ALL_OF'
  | 'FUZZY'
  | 'INTENT'
  | 'MESSAGE_TYPE'
  | 'FALLBACK';

/** A reply language the server can detect (server/src/autoreply/language.js). */
export interface Language {
  code: string;
  label: string;
  /** 'native' (its own letters), 'roman' (written in English letters) or 'latin'. */
  script?: string;
  /** False where replies can be written but messages cannot be told apart automatically. */
  detect?: boolean;
}

/** How replies pick a language (settings.language). */
export interface LanguageSettings {
  mode: 'auto' | 'fixed';
  fixed: string;
  /** The translation used when there is none for the customer's language; '' = the main reply. */
  fallback: string;
  /** Hinglish/Gujlish customers: 'mirror' answers in kind, 'dominant' in Hindi/Gujarati first. */
  mixed: 'mirror' | 'dominant';
  /** Tell a customer writing in a language no reply is in which languages we answer in. */
  askUnknown: boolean;
}

/** A built-in intent: words that mean one thing, in English, Hinglish, Hindi and Gujarati. */
export interface Intent {
  id: string;
  label: string;
  examples: string[];
  /** Every word of the intent, English, Hinglish, Hindi and Gujarati: the similar-words suggestions. */
  words?: string[];
}

/** Language code to reply text; the main reply covers every language not listed. */
export type Translations = Record<string, string>;

export type CollectType = 'text' | 'name' | 'phone' | 'email' | 'number' | 'language';

/** A question a rule asks after its reply; the answer is saved to the contact field `key`. */
export interface CollectQuestion {
  key: string;
  question: string;
  type: CollectType;
  /** A language question: the language codes offered, by number. */
  options?: string[];
}

export interface RuleCollect {
  questions: CollectQuestion[];
  doneReply: string;
  doneTranslations?: Translations;
}
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface RuleSchedule {
  days: string[];
  start: string;
  end: string;
  outsideReply: string;
  /** IANA zone the times were picked in; filled from the browser on save. */
  timezone?: string | null;
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
  /** ANY_OF / ALL_OF / FUZZY keywords also match their intent group ("price" finds "cost"). */
  synonyms: boolean;
  /** Forgive spelling mistakes on Exact, Contains, Any of and All of (default on). */
  typos: boolean;
  translations: Translations;
  collect: RuleCollect | null;
  isActive: boolean;
  stats: RuleStats;
  createdAt: string;
  updatedAt: string;
}

export type RulePayload = Omit<
  AutoReplyRule,
  'id' | 'stats' | 'createdAt' | 'updatedAt' | 'priority'
> & { priority?: number };

export interface DayHours {
  open: boolean;
  start: string;
  end: string;
}

export interface AutoReplySettings {
  businessName: string;
  timezone: string;
  /** The business's switch for all of its automatic replies (STOP is honoured either way). */
  enabled: boolean;
  /** Seconds before a reply, inside the plan's range. */
  delaySec: number;
  /** Replies one contact may get in an hour; 0 = the plan's limit. */
  maxPerContactHour: number;
  language: LanguageSettings;
  welcome: { enabled: boolean; text: string; media: Media | null; translations?: Translations };
  away: {
    enabled: boolean;
    text: string;
    media: Media | null;
    translations?: Translations;
    hours: Record<Weekday, DayHours>;
    holidays: string[];
    throttleHours: number;
  };
  fallback: {
    enabled: boolean;
    text: string;
    media: Media | null;
    throttleHours: number;
    translations?: Translations;
    /** The Nth message in an hour nothing understands goes to a person (0 = never). */
    handoffAfter: number;
  };
  handoff: {
    enabled: boolean;
    keywords: string[];
    text: string;
    media: Media | null;
    translations?: Translations;
    /** Hours the bot stays quiet after a handoff or a reply from the phone (0 = never pauses). */
    pauseHours: number;
  };
}

export type SystemKey = 'welcome' | 'away' | 'fallback' | 'handoff';
export type SystemStats = Record<SystemKey, RuleStats>;

export interface Session {
  ruleId: number;
  path: string[];
  /** A rule's questions in progress. */
  flow?: { step: number; tries: number; answers: Record<string, string> } | null;
  expiresAt: string;
}

export interface TestRequest {
  body: string;
  sender: string;
  senderName?: string;
  at?: string;
  replyId?: string;
  /** Simulate a photo, file, location... for message-type rules. */
  mediaType?: string;
  firstContact?: boolean | null;
  tags?: string[] | null;
  session?: Session | null;
}

export interface TestReply {
  source:
    | 'welcome'
    | 'away'
    | 'handoff'
    | 'menu'
    | 'flow'
    | 'language'
    | 'rule'
    | 'schedule'
    | 'fallback'
    | 'help'
    | 'faq';
  ruleId: number | null;
  ruleName: string;
  text: string;
  media: Media | null;
  interactive: Interactive | null;
  fallbackText: string;
}

export interface TestResult {
  replies: TestReply[];
  actions: { type: 'tag' | 'field' | 'name' | 'escalate' | 'menu'; detail: string }[];
  trace: string[];
  matched: { ruleId: number; matchType: string; keyword: string; score: number } | null;
  context: {
    firstContact: boolean;
    newContact: boolean;
    withinHours: boolean;
    localTime: string;
    tags: string[];
    /** The language the message was read as, e.g. "Hinglish (Hindi in English letters)". */
    language?: string;
  };
  session: Session | null;
}

export interface UploadedMedia extends Media {
  filename: string;
  mimetype: string;
  size: number;
  url: string;
}

/** `GET /api/auto-replies/log`: what the automation did with one incoming message. */
export type LogOutcome = 'replied' | 'none' | 'skipped' | 'failed';
export interface LogLine {
  id: number;
  channelId: number | null;
  phone: string;
  /** What the customer wrote. */
  inbound: string;
  outcome: LogOutcome;
  /** The rule (or HELP, FAQ, welcome...) that answered; empty when none did. */
  rule: string;
  /** The reply sent, or why nothing went out. */
  detail: string;
  at: string;
}

/** `GET /api/auto-replies`: the rules, and what the editor offers. */
export interface RuleList {
  rules: AutoReplyRule[];
  platformOptOutWords?: string[];
  intents?: Intent[];
  languages?: Language[];
  messageTypes?: string[];
}

/* Service ---------------------------------------------------------------- */

@Injectable({ providedIn: 'root' })
export class AutoRepliesApi {
  private readonly http = inject(HttpClient);

  list(): Observable<RuleList> {
    return this.http.get<RuleList>('/api/auto-replies').pipe(catchError(toMessage));
  }

  /** The plan's platform rules (`GET /api/policy`); only the auto-reply keys are read. */
  policy(): Observable<{ values: Record<string, unknown> }> {
    return this.http
      .get<{ values: Record<string, unknown> }>('/api/policy')
      .pipe(catchError(toMessage));
  }

  create(rule: RulePayload): Observable<{ rule: AutoReplyRule }> {
    return this.http
      .post<{ rule: AutoReplyRule }>('/api/auto-replies', rule)
      .pipe(catchError(toMessage));
  }

  update(id: number, patch: Partial<RulePayload>): Observable<{ rule: AutoReplyRule }> {
    return this.http
      .put<{ rule: AutoReplyRule }>(`/api/auto-replies/${id}`, patch)
      .pipe(catchError(toMessage));
  }

  remove(id: number): Observable<{ deleted: number }> {
    return this.http
      .delete<{ deleted: number }>(`/api/auto-replies/${id}`)
      .pipe(catchError(toMessage));
  }

  reorder(ids: number[]): Observable<{ rules: AutoReplyRule[] }> {
    return this.http
      .post<{ rules: AutoReplyRule[] }>('/api/auto-replies/reorder', { ids })
      .pipe(catchError(toMessage));
  }

  settings(): Observable<{ settings: AutoReplySettings; stats: SystemStats }> {
    return this.http
      .get<{ settings: AutoReplySettings; stats: SystemStats }>('/api/auto-replies/settings')
      .pipe(catchError(toMessage));
  }

  saveSettings(patch: Partial<AutoReplySettings>): Observable<{ settings: AutoReplySettings }> {
    return this.http
      .put<{ settings: AutoReplySettings }>('/api/auto-replies/settings', patch)
      .pipe(catchError(toMessage));
  }

  /** The newest Activity log lines; `outcome` narrows them. */
  log(outcome: LogOutcome | null = null): Observable<{ log: LogLine[] }> {
    const query = outcome ? `?outcome=${outcome}` : '';
    return this.http.get<{ log: LogLine[] }>(`/api/auto-replies/log${query}`).pipe(catchError(toMessage));
  }

  test(req: TestRequest): Observable<TestResult> {
    return this.http.post<TestResult>('/api/auto-replies/test', req).pipe(catchError(toMessage));
  }

  /** The Reports tab over the last `days` (1..90). */
  report(days: number): Observable<Report> {
    return this.http.get<Report>(`/api/auto-replies/report?days=${days}`).pipe(catchError(toMessage));
  }

  upload(file: File): Observable<UploadedMedia> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<UploadedMedia>('/api/media/upload', form).pipe(catchError(toMessage));
  }
}

/* Reports ---------------------------------------------------------------- */

/** `GET /api/auto-replies/report`: what customers sent, what answered, what nothing did, where they left. */
export interface Report {
  readonly days: number;
  readonly totals: {
    readonly messages: number;
    readonly answered: number;
    readonly unanswered: number;
    /** 0..100 */
    readonly answerRate: number;
    readonly customers: number;
    readonly handoffs: number;
    readonly leftPartWay: number;
    readonly failed: number;
  };
  /** One entry per day in the range, in the number's time zone, oldest first. */
  readonly byDay: readonly { readonly date: string; readonly answered: number; readonly unanswered: number }[];
  /** Incoming messages per local hour, 0..23. */
  readonly hours: readonly number[];
  readonly hot: readonly {
    readonly key: string;
    readonly label: string;
    readonly kind: 'keyword' | 'system' | 'faq' | 'orders' | 'school';
    /** The rule's name, for a keyword. */
    readonly rule?: string | null;
    readonly uses: number;
    readonly customers: number;
  }[];
  readonly unanswered: readonly { readonly text: string; readonly count: number; readonly customers: number; readonly lastAt: string }[];
  readonly leftPartWay: readonly { readonly ruleId: number; readonly rule: string; readonly where: string; readonly count: number }[];
}

/** Surface the server's own words (same rule as core/api.ts). */
function toMessage(error: HttpErrorResponse) {
  const errors = error.error?.errors;
  const message =
    Array.isArray(errors) && errors.length
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
  return String(template ?? '').replace(
    /\{([a-z0-9_]+)(?:\|([^}]*))?\}/gi,
    (_, key: string, fallback?: string) => values[key.toLowerCase()] || fallback || '',
  );
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
