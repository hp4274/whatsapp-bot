/** Typed client for the Express API. One place that knows the wire format. */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

export type MessageStatus =
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED'
  | 'SANDBOX';

export interface AppConfig {
  transport: 'cloud_api' | 'whatsapp_web' | 'sandbox';
  graphVersion: string;
  phoneNumberId: string;
  accessToken: string;
  useTemplate: boolean;
  templateName: string;
  templateLanguage: string;
  previewUrl: boolean;
  rateLimitPerSecond: number;
  rateLimitBurst: number;
  maxRetries: number;
  retryDelay: number;
  retryBackoff: number;
  retryMaxDelay: number;
  retryJitter: number;
  requestTimeout: number;
  webhookEnabled: boolean;
  webhookVerifyToken: string;
  chromePath: string;
  qrTimeout: number;
  defaultCountryCode: string;
  logLevel: string;
  safetyEnabled: boolean;
  dailyLimit: number;
  pacingMode: 'adaptive' | 'fixed';
  minDelaySeconds: number;
  maxDelaySeconds: number;
  restEvery: number;
  restMinMinutes: number;
  restMaxMinutes: number;
}

export interface ConnectionState {
  connected: boolean;
  connecting?: boolean;
  transport: string;
  name: string | null;
  account: string;
  detail: string;
  error?: string | null;
  code?: string | null;
  realDelivery: boolean;
  supportsReceipts: boolean;
  qr: string | null;
}

export interface Contact {
  name: string;
  phone: string;
  extra?: Record<string, string>;
}

export interface ImportResult {
  contacts: Contact[];
  errors: string[];
  duplicates: number;
}

export interface SafetyStatus {
  enabled: boolean;
  limit: number;
  used: number;
  remaining: number | null;
  resetsAt: string;
  pacingMode: string;
  minSeconds: number;
  maxSeconds: number;
  restEvery: number;
  restMinMinutes: number;
  restMaxMinutes: number;
  estimateSeconds: { min: number; max: number; typical: number };
  waitingSeconds: number;
  pausedByQuota: boolean;
}

export interface CampaignStats {
  total: number;
  successful: number;
  failed: number;
  processed: number;
  pending: number;
  duplicates: number;
  state: 'RUNNING' | 'PAUSED' | 'STOPPED';
  safety?: SafetyStatus;
}

export interface MessageRecord {
  messageId: string;
  recipient: string;
  message: string;
  status: MessageStatus;
  attempt: number;
  providerId: string | null;
  error: string | null;
  name: string;
  campaignId: string;
  createdAt: string;
  updatedAt: string;
}

export interface HistoryPage {
  records: MessageRecord[];
  counts: Record<string, number>;
  signature: string;
}

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  getConfig(): Observable<{ config: AppConfig; transports: string[]; warnings: Record<string, string> }> {
    return this.http
      .get<{ config: AppConfig; transports: string[]; warnings: Record<string, string> }>('/api/config')
      .pipe(catchError(toMessage));
  }

  saveConfig(update: Partial<AppConfig>): Observable<{ config: AppConfig }> {
    return this.http.put<{ config: AppConfig }>('/api/config', update).pipe(catchError(toMessage));
  }

  connection(): Observable<ConnectionState> {
    return this.http.get<ConnectionState>('/api/connection').pipe(catchError(toMessage));
  }

  connect(): Observable<ConnectionState> {
    return this.http
      .post<ConnectionState>('/api/connection/connect', {})
      .pipe(catchError(toMessage));
  }

  disconnect(): Observable<ConnectionState> {
    return this.http
      .post<ConnectionState>('/api/connection/disconnect', {})
      .pipe(catchError(toMessage));
  }

  logout(): Observable<ConnectionState> {
    return this.http.post<ConnectionState>('/api/connection/logout', {}).pipe(catchError(toMessage));
  }

  sendMessage(
    recipient: string,
    message: string,
    name = '',
  ): Observable<{ messageId: string; recipient: string; message: string }> {
    return this.http
      .post<{ messageId: string; recipient: string; message: string }>('/api/messages',
        { recipient, message, name })
      .pipe(catchError(toMessage));
  }

  importContacts(file: File): Observable<ImportResult> {
    const form = new FormData();
    form.append('file', file);
    return this.http.post<ImportResult>('/api/contacts/import', form).pipe(catchError(toMessage));
  }

  startCampaign(
    contacts: Contact[],
    template: string,
    onePerNumber: boolean,
  ): Observable<{ queued: number; skipped: number; campaignId: string; overQuota: number;
    safety: SafetyStatus }> {
    return this.http
      .post<{ queued: number; skipped: number; campaignId: string; overQuota: number;
        safety: SafetyStatus }>('/api/campaign/start', {
        contacts,
        template,
        onePerNumber,
      })
      .pipe(catchError(toMessage));
  }

  campaignAction(action: 'pause' | 'resume' | 'stop'): Observable<{ stats: CampaignStats }> {
    return this.http
      .post<{ stats: CampaignStats }>(`/api/campaign/${action}`, {})
      .pipe(catchError(toMessage));
  }

  safety(contacts = 0): Observable<{ safety: SafetyStatus }> {
    return this.http
      .get<{ safety: SafetyStatus }>('/api/safety', {
        params: new HttpParams().set('contacts', contacts),
      })
      .pipe(catchError(toMessage));
  }

  stats(): Observable<{ stats: CampaignStats }> {
    return this.http.get<{ stats: CampaignStats }>('/api/campaign/stats').pipe(catchError(toMessage));
  }

  /**
   * History, with the signature the browser already holds: the server answers
   * 204 when nothing changed, so unchanged rows never travel.
   */
  history(options: { status?: string; recipient?: string; signature?: string }) {
    let params = new HttpParams();
    if (options.status && options.status !== 'ALL') params = params.set('status', options.status);
    if (options.recipient) params = params.set('recipient', options.recipient);
    if (options.signature) params = params.set('signature', options.signature);
    return this.http
      .get<HistoryPage>('/api/history', { params, observe: 'response' })
      .pipe(catchError(toMessage));
  }
}

/** Surface the server's own words, not "Http failure response for ...". */
function toMessage(error: HttpErrorResponse) {
  const errors = error.error?.errors;
  const message = Array.isArray(errors) && errors.length
    ? errors.join('\n')
    : error.error?.message || error.message || 'Request failed';
  return throwError(() => new Error(message));
}
