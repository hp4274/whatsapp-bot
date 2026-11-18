import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

import type { ApiKey, CreatedApiKey } from '../developer/developer-api';

/** WhatsApp OTP set-up for the signed-in business (server/src/otp/). The public send/verify calls are /api/v1/otp. */
export interface OtpSettings {
  /** Shown as {brand}; at most 40 characters. */
  readonly brand: string;
  /** At most 500 characters and must contain {code}. */
  readonly template: string;
  /** Digits in a code, 4..8. */
  readonly length: number;
  /** 1..30, and no more than the platform's `maxTtlMinutes`. */
  readonly ttlMinutes: number;
  /** Wrong tries before the code stops working, 1..10. */
  readonly maxAttempts: number;
  /** Least wait before the same number gets another code, 0..600. */
  readonly resendSeconds: number;
}

export type OtpStatus = 'pending' | 'verified' | 'expired' | 'failed' | 'blocked';

/** The answer of a verify (same as the public API's /v1/otp/verify). */
export interface VerifyResult {
  readonly valid: boolean;
  readonly id?: string;
  readonly reason?: 'wrong_code' | 'expired' | 'too_many_attempts' | 'not_found' | 'already_used';
  readonly attemptsLeft?: number;
}

export interface OtpRow {
  readonly id: string | number;
  /** The customer's full number, digits only with the country code (e.g. 919876543210). */
  readonly phone: string;
  readonly status: OtpStatus;
  readonly purpose: string | null;
  readonly attempts: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly verifiedAt: string | null;
  readonly source: 'api' | 'test';
  readonly error: string | null;
  /** Where an API send came from; null for a test send. */
  readonly client: OtpClient | null;
}

/** The caller of an API send: its key, IP address, app (from its User-Agent) and website (Origin/Referer). */
export interface OtpClient {
  readonly keyId: number | null;
  readonly ip: string | null;
  readonly app: string | null;
  readonly site: string | null;
}

/** One place the API is called from (last 30 days): a key + IP + app + site, newest first. */
export interface OtpConnection extends OtpClient {
  readonly sent: number;
  readonly verified: number;
  readonly firstAt: string;
  readonly lastAt: string;
}

/** What the super admin allows this business. Null = no limit. */
export interface OtpRules {
  readonly maxPerPhoneHour: number | null;
  readonly maxPerMonth: number | null;
  readonly allowCustomCode: boolean;
  readonly maxTtlMinutes: number;
}

export interface OtpState {
  readonly settings: OtpSettings;
  readonly stats: { readonly sentMonth: number; readonly verifiedMonth: number; readonly failedMonth: number; readonly pending: number };
  /** The latest 50, newest first. */
  readonly recent: OtpRow[];
  /** Where the API is called from, last 30 days. */
  readonly connections: OtpConnection[];
  readonly keys: ApiKey[];
  /** A WhatsApp number is linked and online. */
  readonly connected: boolean;
  readonly rules: OtpRules;
}

@Injectable({ providedIn: 'root' })
export class OtpApi {
  private readonly http = inject(HttpClient);

  get(): Observable<OtpState> {
    return this.http.get<OtpState>('/api/otp').pipe(catchError(toMessage));
  }

  saveSettings(patch: Partial<OtpSettings>): Observable<{ settings: OtpSettings }> {
    return this.http.put<{ settings: OtpSettings }>('/api/otp/settings', patch).pipe(catchError(toMessage));
  }

  /** The plaintext `key` is in this answer only. */
  createKey(name: string): Observable<{ key: CreatedApiKey }> {
    return this.http.post<{ key: CreatedApiKey }>('/api/otp/keys', { name }).pipe(catchError(toMessage));
  }

  revokeKey(id: number): Observable<{ key: ApiKey }> {
    return this.http.delete<{ key: ApiKey }>(`/api/otp/keys/${id}`).pipe(catchError(toMessage));
  }

  test(phone: string): Observable<{ otp: OtpRow }> {
    return this.http.post<{ otp: OtpRow }>('/api/otp/test', { phone }).pipe(catchError(toMessage));
  }

  /** Check the code a test send delivered; `otp` is the row afterwards (null if it no longer exists). */
  verifyTest(id: string | number, code: string): Observable<{ result: VerifyResult; otp: OtpRow | null }> {
    return this.http
      .post<{ result: VerifyResult; otp: OtpRow | null }>('/api/otp/test/verify', { id, code })
      .pipe(catchError(toMessage));
  }
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
