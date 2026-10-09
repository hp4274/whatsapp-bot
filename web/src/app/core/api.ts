/** Typed client for the Express API. One place that knows the wire format. */

import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, throwError } from 'rxjs';

import { Role, Tenant, TenantControls, User } from './auth';
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

export interface PaymentReminder {
  rowNumber: number;
  name: string;
  phone: string;
  remaining: string;
  remainingValue: number;
  dueDate: string;
  message: string;
  finalMessage: string;
}

export interface PaymentReminderImportResult {
  reminders: PaymentReminder[];
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

export type AutoReplyMatchType = 'EXACT' | 'CONTAINS' | 'REGEX' | 'FALLBACK';

export interface AutoReplyRule {
  id: number;
  keyword: string;
  matchType: AutoReplyMatchType;
  replyBody: string;
  isActive: boolean;
  cooldownSec: number;
  createdAt: string;
  updatedAt: string;
}

export type AutoReplyRulePayload = Omit<AutoReplyRule, 'id' | 'createdAt' | 'updatedAt'> & {
  id?: number;
};

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

  importPaymentReminders(file: File): Observable<PaymentReminderImportResult> {
    const form = new FormData();
    form.append('file', file);
    return this.http
      .post<PaymentReminderImportResult>('/api/payment-reminders/import', form)
      .pipe(catchError(toMessage));
  }

  sendPaymentReminders(
    reminders: PaymentReminder[],
  ): Observable<{ queued: number; skipped: number; campaignId: string; overQuota: number;
    safety: SafetyStatus }> {
    return this.http
      .post<{ queued: number; skipped: number; campaignId: string; overQuota: number;
        safety: SafetyStatus }>('/api/payment-reminders/send', { reminders })
      .pipe(catchError(toMessage));
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

  autoReplies(): Observable<{ rules: AutoReplyRule[] }> {
    return this.http.get<{ rules: AutoReplyRule[] }>('/api/auto-replies').pipe(catchError(toMessage));
  }

  createAutoReply(rule: AutoReplyRulePayload): Observable<{ rule: AutoReplyRule }> {
    return this.http.post<{ rule: AutoReplyRule }>('/api/auto-replies', rule).pipe(catchError(toMessage));
  }

  updateAutoReply(id: number, rule: Partial<AutoReplyRulePayload>): Observable<{ rule: AutoReplyRule }> {
    return this.http
      .put<{ rule: AutoReplyRule }>(`/api/auto-replies/${id}`, rule)
      .pipe(catchError(toMessage));
  }

  deleteAutoReply(id: number): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/auto-replies/${id}`).pipe(catchError(toMessage));
  }

  previewAutoReply(template: string, sender: string, senderName: string): Observable<{ preview: string }> {
    return this.http
      .post<{ preview: string }>('/api/auto-replies/preview', { template, sender, senderName })
      .pipe(catchError(toMessage));
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

/* Tenancy ------------------------------------------------------------- */

export interface AuditLog {
  id: number;
  tenantId: number | null;
  userId: number | null;
  action: string;
  target: string;
  detail: string;
  createdAt: string;
}

export interface SchoolCatalog {
  recipes: { key: string; name: string; description: string }[];
  templates: { name: string; body: string }[];
  studentColumns: string[];
}

export interface SchoolProvisionResult {
  templates: string[];
  workflows: { id: number; name: string }[];
  skipped: string[];
}

/** Anti-ban limits, owned by the platform admin. */
export interface SafetyPolicy {
  safetyEnabled: boolean;
  pacingMode: 'adaptive' | 'fixed';
  dailyLimit: number;
  minDelaySeconds: number;
  maxDelaySeconds: number;
  restEvery: number;
  restMinMinutes: number;
  restMaxMinutes: number;
  rateLimitPerSecond: number;
  rateLimitBurst: number;
  maxRetries: number;
  retryDelay: number;
  retryBackoff: number;
  retryMaxDelay: number;
  retryJitter: number;
}

export interface BillingPlan {
  key: string;
  name: string;
  tier: number;
  limits: Record<string, number | null>;
  features: Record<string, boolean>;
}

export interface BillingUsage {
  period: string;
  counters?: Record<string, number>;
  limits?: Record<string, number | null>;
  [key: string]: unknown;
}

export interface HealthStatus {
  ok?: boolean;
  status?: string;
  [key: string]: unknown;
}

@Injectable({ providedIn: 'root' })
export class TenancyApi {
  private readonly http = inject(HttpClient);

  tenants(): Observable<{ tenants: Tenant[]; services: string[] }> {
    return this.http.get<{ tenants: Tenant[]; services: string[] }>('/api/admin/tenants').pipe(catchError(toMessage));
  }

  createTenant(body: {
    name: string;
    slug?: string;
    services?: string[];
    controls?: TenantControls;
    owner: { email: string; name?: string; password: string };
  }): Observable<{ tenant: Tenant; owner: User }> {
    return this.http.post<{ tenant: Tenant; owner: User }>('/api/admin/tenants', body).pipe(catchError(toMessage));
  }

  updateTenant(
    id: number,
    patch: Partial<{ status: Tenant['status']; services: string[]; controls: Partial<TenantControls> }>,
  ): Observable<{ tenant: Tenant }> {
    return this.http.patch<{ tenant: Tenant }>(`/api/admin/tenants/${id}`, patch).pipe(catchError(toMessage));
  }

  setTenantStatus(id: number, status: Tenant['status']): Observable<{ tenant: Tenant }> {
    return this.updateTenant(id, { status });
  }

  safety(id: number): Observable<{ safety: SafetyPolicy }> {
    return this.http.get<{ safety: SafetyPolicy }>(`/api/admin/tenants/${id}/safety`).pipe(catchError(toMessage));
  }

  setSafety(id: number, patch: Partial<SafetyPolicy>): Observable<{ safety: SafetyPolicy }> {
    return this.http.put<{ safety: SafetyPolicy }>(`/api/admin/tenants/${id}/safety`, patch)
      .pipe(catchError(toMessage));
  }

  deleteTenant(id: number): Observable<{ tenant: Tenant; deleted: number }> {
    return this.http.delete<{ tenant: Tenant; deleted: number }>(`/api/admin/tenants/${id}`)
      .pipe(catchError(toMessage));
  }

  schoolCatalog(): Observable<SchoolCatalog> {
    return this.http.get<SchoolCatalog>('/api/admin/school/catalog').pipe(catchError(toMessage));
  }

  provisionSchool(id: number, body: { recipes?: string[]; templates?: boolean; status?: 'draft' | 'active' }):
    Observable<SchoolProvisionResult> {
    return this.http.post<SchoolProvisionResult>(`/api/admin/tenants/${id}/school/provision`, body)
      .pipe(catchError(toMessage));
  }

  auditLogs(tenantId?: number | null): Observable<{ logs: AuditLog[] }> {
    const params = tenantId ? new HttpParams().set('tenant', tenantId) : undefined;
    return this.http.get<{ logs: AuditLog[] }>('/api/admin/audit-logs', { params }).pipe(catchError(toMessage));
  }

  plans(): Observable<{ plans: BillingPlan[] }> {
    return this.http.get<{ plans: BillingPlan[] }>('/api/billing/plans').pipe(catchError(toMessage));
  }

  usage(period?: string): Observable<{ usage: BillingUsage }> {
    const params = period ? new HttpParams().set('period', period) : undefined;
    return this.http.get<{ usage: BillingUsage }>('/api/billing/usage', { params }).pipe(catchError(toMessage));
  }

  usageHistory(months = 6): Observable<{ history: BillingUsage[] }> {
    return this.http
      .get<{ history: BillingUsage[] }>('/api/billing/usage/history', {
        params: new HttpParams().set('months', months),
      })
      .pipe(catchError(toMessage));
  }

  health(): Observable<HealthStatus> {
    return this.http.get<HealthStatus>('/api/health').pipe(catchError(toMessage));
  }

  users(): Observable<{ users: User[]; roles: Role[] }> {
    return this.http.get<{ users: User[]; roles: Role[] }>('/api/users').pipe(catchError(toMessage));
  }

  createUser(body: { email: string; name?: string; password: string; role: Role }): Observable<{ user: User }> {
    return this.http.post<{ user: User }>('/api/users', body).pipe(catchError(toMessage));
  }

  setUserDisabled(id: number, disabled: boolean): Observable<{ user: User }> {
    return this.http.patch<{ user: User }>(`/api/users/${id}`, { disabled }).pipe(catchError(toMessage));
  }
}

/* Channels ------------------------------------------------------------ */

export interface BusinessHours {
  start: string;
  end: string;
  days?: string[];
}

export interface ChannelHealth {
  connected: boolean;
  connecting: boolean;
  running: boolean;
  account: string;
  detail: string;
  error: string | null;
  withinSendingWindow: boolean;
}

export interface Channel {
  id: number;
  tenantId: number;
  provider: AppConfig['transport'];
  phoneNumber: string;
  providerAccountId: string;
  providerPhoneNumberId: string;
  status: 'active' | 'disabled';
  displayName: string;
  settings: AppConfig;
  capabilities: string[];
  timezone: string;
  businessHours: BusinessHours | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  health?: ChannelHealth;
}

export type ChannelPatch = Partial<{
  displayName: string;
  phoneNumber: string;
  status: Channel['status'];
  capabilities: string[];
  timezone: string;
  businessHours: BusinessHours | null;
  settings: Partial<AppConfig>;
  isDefault: boolean;
}>;

@Injectable({ providedIn: 'root' })
export class ChannelsApi {
  private readonly http = inject(HttpClient);

  list(): Observable<{ channels: Channel[]; capabilities: string[]; transports: string[] }> {
    return this.http
      .get<{ channels: Channel[]; capabilities: string[]; transports: string[] }>('/api/channels')
      .pipe(catchError(toMessage));
  }

  create(body: ChannelPatch): Observable<{ channel: Channel }> {
    return this.http.post<{ channel: Channel }>('/api/channels', body).pipe(catchError(toMessage));
  }

  update(id: number, patch: ChannelPatch): Observable<{ channel: Channel }> {
    return this.http.patch<{ channel: Channel }>(`/api/channels/${id}`, patch).pipe(catchError(toMessage));
  }

  makeDefault(id: number): Observable<{ channel: Channel }> {
    return this.http.post<{ channel: Channel }>(`/api/channels/${id}/default`, {}).pipe(catchError(toMessage));
  }

  remove(id: number): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/channels/${id}`).pipe(catchError(toMessage));
  }
}

/* Contacts, tags, custom fields and segments ---------------------------- */

export interface Contact2 {
  id: number;
  tenantId: number;
  phone: string;
  name: string;
  email: string;
  status: 'active' | 'archived';
  optInStatus: 'unknown' | 'opted_in' | 'opted_out';
  customFields: Record<string, string>;
  tags: string[];
  source: string;
  optedOut: boolean;
  messageable: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  at: string;
  direction: 'inbound' | 'outbound';
  kind: string;
  messageId: string;
  body: string;
  status: string | null;
}

export interface ContactFilter {
  tags?: string[];
  anyTags?: string[];
  notTags?: string[];
  status?: string;
  optInStatus?: string;
  optedOut?: boolean;
  source?: string;
  search?: string;
  custom?: Record<string, string>;
}

export interface Segment {
  id: number;
  name: string;
  filter: ContactFilter;
  count?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContactList {
  contacts: Contact2[];
  total: number;
  tags: { tag: string; count: number }[];
  fieldKeys: string[];
}

@Injectable({ providedIn: 'root' })
export class ContactsApi {
  private readonly http = inject(HttpClient);

  list(filter: ContactFilter = {}, limit = 200): Observable<ContactList> {
    let params = new HttpParams().set('limit', limit);
    if (Object.keys(filter).length) params = params.set('filter', JSON.stringify(filter));
    return this.http.get<ContactList>('/api/contacts', { params }).pipe(catchError(toMessage));
  }

  save(body: Partial<Contact2>): Observable<{ contact: Contact2 }> {
    return this.http.post<{ contact: Contact2 }>('/api/contacts', body).pipe(catchError(toMessage));
  }

  update(id: number, body: Partial<Contact2>): Observable<{ contact: Contact2 }> {
    return this.http.put<{ contact: Contact2 }>(`/api/contacts/${id}`, body).pipe(catchError(toMessage));
  }

  remove(id: number): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/contacts/${id}`).pipe(catchError(toMessage));
  }

  tag(id: number, add: string[] = [], remove: string[] = []): Observable<{ contact: Contact2 }> {
    return this.http.post<{ contact: Contact2 }>(`/api/contacts/${id}/tags`, { add, remove }).pipe(catchError(toMessage));
  }

  timeline(id: number): Observable<{ timeline: TimelineEntry[] }> {
    return this.http.get<{ timeline: TimelineEntry[] }>(`/api/contacts/${id}/timeline`).pipe(catchError(toMessage));
  }

  segments(): Observable<{ segments: Segment[] }> {
    return this.http.get<{ segments: Segment[] }>('/api/segments').pipe(catchError(toMessage));
  }

  saveSegment(body: { name: string; filter: ContactFilter }): Observable<{ segment: Segment; count: number }> {
    return this.http.post<{ segment: Segment; count: number }>('/api/segments', body).pipe(catchError(toMessage));
  }

  deleteSegment(id: number): Observable<{ deleted: number }> {
    return this.http.delete<{ deleted: number }>(`/api/segments/${id}`).pipe(catchError(toMessage));
  }

  importFile(file: File, tags: string[] = []): Observable<{ saved?: { created: number; updated: number; failed: unknown[] } }> {
    const form = new FormData();
    form.append('file', file);
    let params = new HttpParams().set('save', 'true');
    if (tags.length) params = params.set('tags', tags.join(','));
    return this.http.post<{ saved?: { created: number; updated: number; failed: unknown[] } }>(
      '/api/contacts/import', form, { params }).pipe(catchError(toMessage));
  }
}
