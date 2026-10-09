/**
 * Typed client for the conversation inbox. Wire contract with
 * server/src/inbox/routes.js (conversation state) plus the older
 * `/inbox/conversations` summary in server/src/app.js, which is only used for
 * sender names and the last inbound preview - change both sides together.
 */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export type ConversationStatus = 'open' | 'pending' | 'closed';

export interface Conversation {
  id: number;
  tenantId: number;
  channelId: number;
  contactId: number | null;
  phone: string;
  status: ConversationStatus;
  assignedTo: number | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastInboundAt: string | null;
  botPaused: boolean;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ThreadItem {
  at: string;
  direction: 'inbound' | 'outbound';
  /** outbound: message_type (transactional = human, auto_reply/workflow/... = bot); inbound: 'message'. */
  kind: string;
  messageId: string;
  body: string;
  status: string | null;
  from: string;
}

export interface ConversationNote {
  id: number;
  conversationId: number;
  userId: number | null;
  body: string;
  createdAt: string;
}

export interface InboxStats {
  byStatus: Record<ConversationStatus, number>;
  total: number;
  unassigned: number;
  unread: number;
  oldestUnansweredAt: string | null;
  oldestUnansweredSeconds: number | null;
}

/** Legacy per-sender summary: the only place a preview and display name live. */
export interface SenderSummary {
  sender: string;
  senderName: string;
  messageCount: number;
  unreadCount: number;
  lastReceivedAt: string;
  lastBody: string;
}

export interface ConversationFilter {
  status?: ConversationStatus | null;
  search?: string;
  unread?: boolean;
  assignedTo?: number | 'none' | null;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class InboxApi {
  private readonly http = inject(HttpClient);

  list(filter: ConversationFilter = {}): Observable<{ conversations: Conversation[] }> {
    let params = new HttpParams();
    if (filter.status) params = params.set('status', filter.status);
    if (filter.search) params = params.set('search', filter.search);
    if (filter.unread) params = params.set('unread', 'true');
    if (filter.assignedTo != null) params = params.set('assignedTo', String(filter.assignedTo));
    if (filter.limit) params = params.set('limit', String(filter.limit));
    return this.http.get<{ conversations: Conversation[] }>('/api/conversations', { params }).pipe(catchError(toMessage));
  }

  stats(): Observable<{ stats: InboxStats }> {
    return this.http.get<{ stats: InboxStats }>('/api/inbox/stats').pipe(catchError(toMessage));
  }

  senders(): Observable<{ conversations: SenderSummary[] }> {
    return this.http.get<{ conversations: SenderSummary[] }>('/api/inbox/conversations').pipe(catchError(toMessage));
  }

  get(id: number): Observable<{ conversation: Conversation; notes: ConversationNote[] }> {
    return this.http.get<{ conversation: Conversation; notes: ConversationNote[] }>(`/api/conversations/${id}`)
      .pipe(catchError(toMessage));
  }

  thread(id: number, limit = 200): Observable<{ conversation: Conversation; thread: ThreadItem[] }> {
    return this.http.get<{ conversation: Conversation; thread: ThreadItem[] }>(`/api/conversations/${id}/thread`, {
      params: new HttpParams().set('limit', String(limit)),
    }).pipe(catchError(toMessage));
  }

  reply(id: number, text: string): Observable<{ conversation: Conversation; messageId: string }> {
    return this.post(id, 'reply', { text });
  }

  /** userId null unassigns. */
  assign(id: number, userId: number | null): Observable<{ conversation: Conversation }> {
    return this.post(id, 'assign', { userId });
  }

  setStatus(id: number, status: ConversationStatus): Observable<{ conversation: Conversation }> {
    return this.post(id, 'status', { status });
  }

  markRead(id: number): Observable<{ conversation: Conversation }> {
    return this.post(id, 'read', {});
  }

  tags(id: number, add: string[] = [], remove: string[] = []): Observable<{ conversation: Conversation }> {
    return this.post(id, 'tags', { add, remove });
  }

  notes(id: number): Observable<{ notes: ConversationNote[] }> {
    return this.http.get<{ notes: ConversationNote[] }>(`/api/conversations/${id}/notes`).pipe(catchError(toMessage));
  }

  addNote(id: number, body: string): Observable<{ note: Record<string, unknown> }> {
    return this.post(id, 'notes', { body });
  }

  /** Pause the bot for this conversation (and assign it to the caller). */
  takeover(id: number): Observable<{ conversation: Conversation }> {
    return this.post(id, 'takeover', {});
  }

  /** Resume the bot. */
  handback(id: number): Observable<{ conversation: Conversation }> {
    return this.post(id, 'handback', {});
  }

  private post<T>(id: number, action: string, body: object): Observable<T> {
    return this.http.post<T>(`/api/conversations/${id}/${action}`, body).pipe(catchError(toMessage));
  }
}

/** Send refusals come back as machine reasons; say what they mean. */
const REASONS: Record<string, string> = {
  opted_out: 'This customer opted out of messages, so the reply was not sent.',
  duplicate: 'That reply was already sent.',
  bot_paused: 'The bot is paused for this conversation.',
  channel_disabled: 'This WhatsApp number is disabled. Re-enable it under Connection to reply.',
  capability_disabled: 'This number is not enabled for transactional messages, so replies cannot be sent.',
};

function toMessage(error: HttpErrorResponse) {
  const body = error.error as { errors?: string[]; reason?: string } | null;
  const reason = body?.reason ? REASONS[body.reason] : undefined;
  const text = reason ?? (body?.errors?.map((e) => REASONS[e] ?? e).join(' ') || error.message || 'Request failed');
  return throwError(() => new Error(error.status === 0 ? 'Server not reachable. Check your connection.' : text));
}
