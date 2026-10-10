import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { CampaignStatus } from '../core/api';
import { STATUS_LABEL } from './campaign-format';

type Tone = 'ok' | 'info' | 'warn' | 'bad' | 'mute';

/**
 * Status words grouped by meaning, so a campaign state ("done") and a
 * per-recipient delivery state ("DELIVERED") read the same colour everywhere.
 * Anything unknown falls back to muted rather than guessing.
 */
const TONES: Readonly<Record<string, Tone>> = {
  done: 'ok',
  completed: 'ok',
  live: 'ok',
  sent: 'ok',
  delivered: 'ok',
  read: 'ok',
  running: 'info',
  sending: 'info',
  queued: 'info',
  scheduled: 'warn',
  paused: 'warn',
  sandbox: 'warn',
  warning: 'warn',
  failed: 'bad',
  cancelled: 'bad',
  error: 'bad',
  draft: 'mute',
  idle: 'mute',
};

/**
 * The one status pill for campaigns and their recipients: Kardlyz shape (fully
 * rounded, tone at 12%, small dot). Running swaps the dot for a breathing one
 * so an in-flight send is visible at a glance.
 */
@Component({
  selector: 'app-campaign-status',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="cpill" [class]="'cpill tone-' + tone()">
      <span class="dot" [class.live-dot]="key() === 'running'" aria-hidden="true"></span>
      {{ label() }}
    </span>
  `,
  styles: `
    :host {
      display: inline-flex;
    }
    .cpill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 11px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.3;
      white-space: nowrap;
      text-transform: capitalize;
      color: var(--tone);
      background: color-mix(in srgb, var(--tone) 12%, transparent);
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: currentColor;
    }
    .tone-ok {
      --tone: var(--success);
    }
    .tone-info {
      --tone: var(--info);
    }
    .tone-warn {
      --tone: var(--warning);
    }
    .tone-bad {
      --tone: var(--danger-text);
    }
    .tone-mute {
      --tone: var(--text-muted);
    }
  `,
})
export class CampaignStatusPill {
  /** Campaign status, or a raw recipient status such as `DELIVERED`. */
  readonly status = input.required<CampaignStatus | string>();

  protected readonly key = computed(() => this.status().toLowerCase());
  protected readonly tone = computed<Tone>(() => TONES[this.key()] ?? 'mute');
  protected readonly label = computed(
    () => STATUS_LABEL[this.status() as CampaignStatus] ?? this.key(),
  );
}
