/**
 * The platform's campaign rules for this business (GET /api/policy), read so
 * the composer can grey out what the plan does not allow before the server
 * refuses it. The server enforces every rule regardless (policy/campaignOps.js),
 * so a failed load simply leaves everything enabled.
 */

import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';

import type { PacingPreset } from '../core/api';

/** Slowest to fastest, as the server's PACING_PRESETS orders them. */
const SPEEDS: readonly PacingPreset[] = ['safe', 'balanced', 'fast'];

interface PolicyResponse {
  readonly values: Readonly<Record<string, unknown>>;
}

@Injectable({ providedIn: 'root' })
export class CampaignPolicy {
  private readonly http = inject(HttpClient);
  private readonly values = signal<Readonly<Record<string, unknown>>>({});
  private requested = false;

  /** The fastest preset the plan allows. */
  readonly maxSpeed = computed<PacingPreset>(() => {
    const v = this.values()['bulk.maxSpeed'];
    return SPEEDS.includes(v as PacingPreset) ? (v as PacingPreset) : 'fast';
  });
  readonly allowScheduling = computed(() => this.values()['campaigns.allowScheduling'] !== false);
  readonly allowFollowUps = computed(() => this.values()['campaigns.allowFollowUps'] !== false);
  readonly allowInteractive = computed(() => this.values()['campaigns.allowInteractive'] !== false);

  /** Loads once per session; the rules change rarely and the server is the real gate. */
  load(): void {
    if (this.requested) return;
    this.requested = true;
    this.http.get<PolicyResponse>('/api/policy').subscribe({
      next: ({ values }) => this.values.set(values ?? {}),
      error: () => {
        this.requested = false;
      },
    });
  }

  /** True when `preset` is faster than the plan's ceiling. */
  tooFast(preset: PacingPreset): boolean {
    return SPEEDS.indexOf(preset) > SPEEDS.indexOf(this.maxSpeed());
  }
}
