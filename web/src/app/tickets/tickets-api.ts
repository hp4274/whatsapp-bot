/**
 * Typed client for /api/tickets. Wire contract with server/src/tickets/routes.js
 * and store.js - change both together.
 */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError, map } from 'rxjs/operators';

export const TICKET_STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
/** Mirrors SLA_HOURS in store.js. */
export const SLA_HOURS: Record<TicketPriority, number> = {
  low: 72,
  normal: 24,
  high: 8,
  urgent: 2,
};

export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketPriority = (typeof TICKET_PRIORITIES)[number];

export interface Ticket {
  id: number;
  contactId: number | null;
  conversationId: number | null;
  reference: string;
  category: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignedTo: number | null;
  source: 'manual' | 'workflow' | 'keyword' | 'api';
  subject: string;
  slaDueAt: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  satisfactionScore: number | null;
  satisfactionComment: string;
  createdAt: string;
  updatedAt: string;
}

export interface TicketEvent {
  id: number;
  userId: number | null;
  kind: 'created' | 'status' | 'assigned' | 'note' | 'priority' | 'message';
  from: string | null;
  to: string | null;
  body: string | null;
  createdAt: string;
}

export interface TicketStats {
  total: number;
  byStatus: Record<TicketStatus, number>;
  byPriority: Record<TicketPriority, number>;
  overdue: number;
  resolved: number;
  medianResolveSeconds: number | null;
}

export interface TicketFilter {
  status?: TicketStatus | '';
  priority?: TicketPriority | '';
  assignedTo?: string; // user id or 'unassigned'
  overdue?: boolean;
}

export interface TicketDraft {
  subject: string;
  category: string;
  priority: TicketPriority;
  assignedTo: number | null;
  contactId: number | null;
}

export type TicketPatch = Partial<
  Pick<Ticket, 'status' | 'priority' | 'assignedTo' | 'subject' | 'category'>
> & {
  notify?: boolean;
};

@Injectable({ providedIn: 'root' })
export class TicketsApi {
  private readonly http = inject(HttpClient);

  list(f: TicketFilter): Observable<Ticket[]> {
    let params = new HttpParams();
    if (f.status) params = params.set('status', f.status);
    if (f.priority) params = params.set('priority', f.priority);
    if (f.assignedTo) params = params.set('assignedTo', f.assignedTo);
    if (f.overdue) params = params.set('overdue', 'true');
    return this.http.get<{ tickets: Ticket[] }>('/api/tickets', { params }).pipe(
      map((r) => r.tickets),
      catchError(toMessage),
    );
  }

  stats(): Observable<TicketStats> {
    return this.http.get<{ stats: TicketStats }>('/api/tickets/stats').pipe(
      map((r) => r.stats),
      catchError(toMessage),
    );
  }

  create(draft: TicketDraft): Observable<Ticket> {
    return this.http.post<{ ticket: Ticket }>('/api/tickets', draft).pipe(
      map((r) => r.ticket),
      catchError(toMessage),
    );
  }

  update(id: number, patch: TicketPatch): Observable<{ ticket: Ticket; notified: boolean }> {
    return this.http
      .patch<{ ticket: Ticket; notified: boolean }>(`/api/tickets/${id}`, patch)
      .pipe(catchError(toMessage));
  }

  events(id: number): Observable<TicketEvent[]> {
    return this.http.get<{ events: TicketEvent[] }>(`/api/tickets/${id}/events`).pipe(
      map((r) => r.events),
      catchError(toMessage),
    );
  }

  addNote(id: number, body: string): Observable<TicketEvent> {
    return this.http.post<{ event: TicketEvent }>(`/api/tickets/${id}/notes`, { body }).pipe(
      map((r) => r.event),
      catchError(toMessage),
    );
  }

  satisfaction(id: number, score: number, comment = ''): Observable<Ticket> {
    return this.http
      .post<{ ticket: Ticket }>(`/api/tickets/${id}/satisfaction`, { score, comment })
      .pipe(
        map((r) => r.ticket),
        catchError(toMessage),
      );
  }
}

function toMessage(error: HttpErrorResponse) {
  const body = error.error as { errors?: string[] } | null;
  return throwError(() => new Error(body?.errors?.join(' ') || error.message || 'Request failed'));
}
