import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError } from 'rxjs';

import type { ConnectionState, MessageStatus, UploadedMedia } from '../core/api';
import { toMessage } from './plans-api';

/** One event Wuzie writes to a client about (server platform/notify.js PLATFORM_EVENTS), with its saved text. */
export interface WapzoMessage {
  readonly kind: string;
  readonly label: string;
  /** When it goes out, in a sentence. */
  readonly when: string;
  readonly defaultText: string;
  readonly enabled: boolean;
  readonly text: string;
}

/** A message the Wuzie number sent; `kind` is the event, or 'test'. */
export interface WapzoLogEntry {
  readonly id: string;
  readonly to: string;
  readonly text: string;
  readonly status: MessageStatus;
  readonly error: string | null;
  readonly kind: string;
  readonly createdAt: string;
  readonly sentAt: string | null;
}

export interface WapzoOverview {
  readonly tenantId: number;
  /** Null until the hidden tenant has a number. */
  readonly channelId: number | null;
  /** 'sandbox' is offered only on a test server. */
  readonly transports: readonly string[];
  readonly messages: readonly WapzoMessage[];
  /** The last 50 messages, newest first. */
  readonly log: readonly WapzoLogEntry[];
}

/** The two config keys this page touches; the rest of the number's config is left as it is. */
export interface WapzoConfig {
  readonly transport: string;
  readonly defaultCountryCode: string;
}

/** A message to many: how many were queued, and who was skipped and why. */
export interface WapzoBroadcastResult {
  readonly queued: number;
  readonly skipped: readonly { readonly to: string; readonly reason: string }[];
}

/** A reusable email (server platform/email.js). */
export interface EmailTemplate {
  readonly id: number;
  readonly name: string;
  readonly subject: string;
  readonly body: string;
  readonly updatedAt: string;
}

/** One email from the dashboard's send queue. */
export interface EmailLogEntry {
  readonly id: number;
  readonly to: string;
  readonly label: string;
  readonly subject: string;
  readonly status: 'queued' | 'sent' | 'failed';
  readonly error: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
}

/** An email Wuzie sends by itself (server mail/emails.js AUTOMATIC_EMAILS). */
export interface AutomaticEmail {
  readonly kind: string;
  readonly label: string;
  /** What sets it off, in a sentence. */
  readonly when: string;
  readonly to: string;
}

export interface EmailOverview {
  readonly configured: boolean;
  /** The sender line; null until SMTP is set up. */
  readonly from: string | null;
  readonly templates: readonly EmailTemplate[];
  /** The last 50, newest first. */
  readonly log: readonly EmailLogEntry[];
  readonly automatic: readonly AutomaticEmail[];
}

export type WapzoTestResult = { readonly sent: true; readonly messageId: string; readonly recipient: string };

/** The number's own API (as a business's Connection page uses it), routed to Wuzie's hidden tenant. */
const NUMBER = '/api/admin/wapzo/api';

/** Super admin: Wuzie's own WhatsApp number, the messages it sends clients, and what it sent. */
@Injectable({ providedIn: 'root' })
export class WapzoApi {
  private readonly http = inject(HttpClient);

  overview(): Observable<WapzoOverview> {
    return this.http.get<WapzoOverview>('/api/admin/wapzo').pipe(catchError(toMessage));
  }

  /** An empty `text` puts the default back. */
  saveMessage(kind: string, body: { enabled?: boolean; text?: string }): Observable<{ message: WapzoMessage }> {
    return this.http
      .put<{ message: WapzoMessage }>(`/api/admin/wapzo/messages/${encodeURIComponent(kind)}`, body)
      .pipe(catchError(toMessage));
  }

  sendTest(to: string, text: string): Observable<WapzoTestResult> {
    return this.http.post<WapzoTestResult>('/api/admin/wapzo/test', { to, text }).pipe(catchError(toMessage));
  }

  /** `tenants`: 'all' (less archived and opted-out ones) or the ids picked; `leads`: open lead ids; `numbers` as typed. */
  broadcast(body: {
    text: string;
    tenants: 'all' | readonly number[];
    leads?: readonly number[];
    numbers: readonly string[];
    mediaId?: string | null;
  }): Observable<WapzoBroadcastResult> {
    return this.http.post<WapzoBroadcastResult>('/api/admin/wapzo/broadcast', body).pipe(catchError(toMessage));
  }

  emailOverview(): Observable<EmailOverview> {
    return this.http.get<EmailOverview>('/api/admin/wapzo/email').pipe(catchError(toMessage));
  }

  /** One automatic email, filled with sample details. */
  automaticEmail(kind: string): Observable<{ subject: string; html: string }> {
    return this.http.get<{ subject: string; html: string }>(`/api/admin/wapzo/email/automatic/${encodeURIComponent(kind)}`).pipe(catchError(toMessage));
  }

  emailPreview(body: { subject: string; body: string; business: string }): Observable<{ html: string }> {
    return this.http.post<{ html: string }>('/api/admin/wapzo/email/preview', body).pipe(catchError(toMessage));
  }

  sendEmail(body: {
    subject: string;
    body: string;
    tenants: 'all' | readonly number[];
    leads: readonly number[];
    emails: readonly string[];
  }): Observable<WapzoBroadcastResult> {
    return this.http.post<WapzoBroadcastResult>('/api/admin/wapzo/email/send', body).pipe(catchError(toMessage));
  }

  /** A null `id` adds a new one. */
  saveEmailTemplate(id: number | null, body: { name: string; subject: string; body: string }): Observable<{ template: EmailTemplate }> {
    const url = '/api/admin/wapzo/email/templates';
    return (id === null ? this.http.post<{ template: EmailTemplate }>(url, body) : this.http.put<{ template: EmailTemplate }>(`${url}/${id}`, body)).pipe(
      catchError(toMessage),
    );
  }

  deleteEmailTemplate(id: number): Observable<{ ok: true }> {
    return this.http.delete<{ ok: true }>(`/api/admin/wapzo/email/templates/${id}`).pipe(catchError(toMessage));
  }

  /** An image stored as the Wuzie number's own, for a message to many. */
  uploadImage(file: File): Observable<UploadedMedia> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<UploadedMedia>(`${NUMBER}/media/upload`, form).pipe(catchError(toMessage));
  }

  connection(): Observable<ConnectionState> {
    return this.http.get<ConnectionState>(`${NUMBER}/connection`).pipe(catchError(toMessage));
  }

  connect(): Observable<ConnectionState> {
    return this.http.post<ConnectionState>(`${NUMBER}/connection/connect`, {}).pipe(catchError(toMessage));
  }

  /** Unlinks the device and deletes the saved session, so the next link shows a fresh QR code. */
  logout(): Observable<ConnectionState> {
    return this.http.post<ConnectionState>(`${NUMBER}/connection/logout`, {}).pipe(catchError(toMessage));
  }

  config(): Observable<{ config: WapzoConfig }> {
    return this.http.get<{ config: WapzoConfig }>(`${NUMBER}/config`).pipe(catchError(toMessage));
  }

  saveConfig(update: Partial<WapzoConfig>): Observable<{ config: WapzoConfig }> {
    return this.http.put<{ config: WapzoConfig }>(`${NUMBER}/config`, update).pipe(catchError(toMessage));
  }

}
