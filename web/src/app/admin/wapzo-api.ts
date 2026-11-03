import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError } from 'rxjs';

import type { ConnectionState, MessageStatus, SafetyHealthView, UploadedMedia } from '../core/api';
import { toMessage } from './plans-api';

/** One event Wapzo writes to a client about (server platform/notify.js PLATFORM_EVENTS), with its saved text. */
export interface WapzoMessage {
  readonly kind: string;
  readonly label: string;
  /** When it goes out, in a sentence. */
  readonly when: string;
  readonly defaultText: string;
  readonly enabled: boolean;
  readonly text: string;
}

/** A message the Wapzo number sent; `kind` is the event, or 'test'. */
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

export type WapzoTestResult = { readonly sent: true; readonly messageId: string; readonly recipient: string };

/** The number's own API (as a business's Connection page uses it), routed to Wapzo's hidden tenant. */
const NUMBER = '/api/admin/wapzo/api';

/** Super admin: Wapzo's own WhatsApp number, the messages it sends clients, and what it sent. */
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

  /** `tenants`: 'all' (less archived and opted-out ones) or the ids picked; `numbers` as typed. */
  broadcast(body: {
    text: string;
    tenants: 'all' | readonly number[];
    numbers: readonly string[];
    mediaId?: string | null;
  }): Observable<WapzoBroadcastResult> {
    return this.http.post<WapzoBroadcastResult>('/api/admin/wapzo/broadcast', body).pipe(catchError(toMessage));
  }

  /** An image stored as the Wapzo number's own, for a message to many. */
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

  /** The sending level (and its rest after linking) lives on `safety.level` for a QR number. */
  health(): Observable<SafetyHealthView> {
    return this.http.get<SafetyHealthView>(`${NUMBER}/safety/health`).pipe(catchError(toMessage));
  }
}
