/**
 * The platform's campaign rules for this business (GET /api/policy), read so
 * the composer can grey out what the plan does not allow before the server
 * refuses it. The server enforces every rule regardless (policy/campaignOps.js),
 * so a failed load simply leaves everything enabled.
 */

import { HttpClient } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';


/** Slowest to fastest, as the server's PACING_PRESETS orders them. */

interface PolicyResponse {
  readonly values: Readonly<Record<string, unknown>>;
  /** Whether the server can rewrite links (it has a public base URL). */
  readonly linkTracking?: boolean;
}

@Injectable({ providedIn: 'root' })
export class CampaignPolicy {
  private readonly http = inject(HttpClient);
  private readonly values = signal<Readonly<Record<string, unknown>>>({});
  private readonly tracking = signal(false);
  private requested = false;

  /** False until the load says otherwise, so the checkbox is never offered on a guess. */
  readonly linkTracking = this.tracking.asReadonly();

  readonly allowScheduling = computed(() => this.values()['campaigns.allowScheduling'] !== false);
  readonly allowFollowUps = computed(() => this.values()['campaigns.allowFollowUps'] !== false);
  readonly allowInteractive = computed(() => this.values()['campaigns.allowInteractive'] !== false);
  /** One image per card (sending.carouselImages, off unless the admin turned it on), as the server sends it. */
  readonly carouselImages = computed(() => this.values()['sending.carouselImages'] === true);

  /** Loads once per session; the rules change rarely and the server is the real gate. */
  load(): void {
    if (this.requested) return;
    this.requested = true;
    this.http.get<PolicyResponse>('/api/policy').subscribe({
      next: ({ values, linkTracking }) => {
        this.values.set(values ?? {});
        this.tracking.set(linkTracking === true);
      },
      error: () => {
        this.requested = false;
      },
    });
  }
}
