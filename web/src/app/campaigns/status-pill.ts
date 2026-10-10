import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { CampaignStatus } from '../core/api';
import { STATUS_LABEL } from './campaign-format';

/** Coloured campaign status pill; running gets a breathing live dot. */
@Component({
  selector: 'app-campaign-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="cpill" [class]="'cpill s-' + status()">
      @if (status() === 'running') { <span class="live-dot" aria-hidden="true"></span> }
      {{ label() }}
    </span>
  `,
  styles: `
    :host { display: inline-flex; }
    .cpill {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border-radius: 999px;
      font-size: 11px; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap;
      border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
    .live-dot { width: 7px; height: 7px; }
    .s-draft { color: var(--text-muted); }
    .s-scheduled { color: var(--accent); }
    .s-running { color: var(--primary); background: var(--primary-soft); }
    .s-paused { color: var(--warning); background: var(--warning-soft); }
    .s-done { color: var(--primary); }
    .s-cancelled { color: var(--danger); }
  `,
})
export class CampaignStatusPill {
  readonly status = input.required<CampaignStatus>();
  protected readonly label = computed(() => STATUS_LABEL[this.status()] ?? this.status());
}
