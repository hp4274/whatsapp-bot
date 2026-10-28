import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

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
}

export interface TenantLimits {
  maxChannels: number;
  maxUsers: number;
  maxTemplates: number;
  maxContactsPerCampaign: number;
  maxMediaMb: number;
  allowWhatsappWeb: boolean;
  blockedWords: string;
  /** The business may change its own sending limits after accepting the risk. */
  allowCustomSafety: boolean;
}

export interface Campaign {
  id: number;
  name: string;
  status: CampaignStatus;
  templateId: number | null;
  body: string;
  segmentId: number | null;
  audience: unknown;
  audienceSize: number | null;
  mediaId: string | null;
}

export interface TenantControls {
  sendingEnabled: boolean;
  campaignsEnabled: boolean;
  automationsEnabled: boolean;
}

export interface TenantHealth {
  channels: number;
  connected: number;
  running: number;
  disabled: number;
  outsideWindow: number;
  sent: number;
  failed: number;
  queued: number;
}

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
}

export interface SchoolSettings {
  schoolName: string;
  gateCutoff: string; // 'HH:MM' - arrivals after this are late
  homeworkSendTime: string; // 'HH:MM' - default scheduled homework time
  absentAlertTime: string | null; // 'HH:MM' auto-send absent alerts daily, null = manual only
  monthlySummary: boolean; // auto-send attendance summary on the 1st
  commandsEnabled: boolean; // ATTENDANCE / TIMETABLE / ... WhatsApp keywords
  upiId: string;
  payeeName: string;
  currency: string;
}

export interface NumberDetails {
  readonly number: string;
  readonly savedNumbers: string[];
  readonly joinedGroups: string[];
  readonly numberList: string[];
  // Add other relevant fields as needed
}

@Injectable({
  providedIn: 'root',
})
export class TenancyApi {
  constructor(private http: HttpClient) {}

  safety(tenantId: number): Observable<{ safety: SafetyPolicy; custom: CustomSafetyState }> {
    return this.http.get<{ safety: SafetyPolicy; custom: CustomSafetyState }>(`/api/tenants/${tenantId}/safety`);
  }

  revokeCustomSafety(tenantId: number): Observable<{ custom: CustomSafetyState }> {
    return this.http.post<{ custom: CustomSafetyState }>(`/api/tenants/${tenantId}/revoke-custom-safety`, {});
  }

  revokeSessions(tenantId: number): Observable<{ count: number }> {
    return this.http.post<{ count: number }>(`/api/tenants/${tenantId}/revoke-sessions`, {});
  }

  revokeKeys(tenantId: number): Observable<{ count: number }> {
    return this.http.post<{ count: number }>(`/api/tenants/${tenantId}/revoke-keys`, {});
  }

  updateTenant(tenantId: number, controls: TenantControls): Observable<Tenant> {
    return this.http.put<Tenant>(`/api/tenants/${tenantId}`, { controls });
  }

  setLimits(tenantId: number, limits: TenantLimits): Observable<TenantLimits> {
    return this.http.put<TenantLimits>(`/api/tenants/${tenantId}/limits`, limits);
  }

  setSafety(tenantId: number, safety: SafetyPolicy): Observable<SafetyPolicy> {
    return this.http.put<SafetyPolicy>(`/api/tenants/${tenantId}/safety`, safety);
  }

  getNumberDetails(number: string): Observable<NumberDetails> {
    return this.http.get<NumberDetails>(`/api/numbers/${number}`);
  }
}
