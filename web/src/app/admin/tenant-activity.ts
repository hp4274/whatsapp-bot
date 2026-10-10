import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AuditLog } from '../core/api';

/** Most recent platform changes under the tenant list, with a link to the full audit log. */
@Component({
  selector: 'app-tenant-activity',
  imports: [RouterLink],
  templateUrl: './tenant-activity.html',
  styleUrl: './tenant-activity.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TenantActivity {
  readonly logs = input.required<readonly AuditLog[]>();

  protected readonly recent = computed(() => this.logs().slice(0, 6));

  /** "5 min ago" for recent activity, a short date after a day. */
  protected ago(iso: string): string {
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return iso;
    const s = Math.max(0, (Date.now() - then) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }
}
