import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';

import { AdminFeed } from './admin-feed';
import { Referrer, ReferralsApi, rateText } from './referrals-api';

let next = 0;

/**
 * "Referred by": type a marketer's name. One typed before shows in the box's list; a new one becomes a marketer when
 * the form saves (server referrals.js setForTenant, at the default 10%, changed later in Referrals). Empty = nobody.
 */
@Component({
  selector: 'app-referrer-input',
  template: `
    <input
      [id]="inputId()"
      name="referrer"
      maxlength="120"
      autocomplete="off"
      placeholder="Marketer's name or code"
      [attr.list]="listId"
      [attr.aria-describedby]="hintId"
      [value]="value()"
      (input)="value.set($any($event.target).value)"
    />
    <datalist [id]="listId">
      @for (r of referrers(); track r.id) {
        <option [value]="r.name">{{ r.code }}, {{ rate(r) }}</option>
      }
    </datalist>
    <small [id]="hintId" class="hint" [class.new]="hint().fresh">
      @if (hint().fresh) {
        <i class="ti ti-user-plus" aria-hidden="true"></i>
      }
      {{ hint().text }}
    </small>
  `,
  styles: `
    :host { display: grid; gap: 6px; min-width: 0; }
    .hint { font-size: 12px; line-height: 1.45; color: var(--text-muted); }
    .hint.new { color: var(--primary-text); }
    .hint .ti { margin-right: 4px; font-size: 14px; vertical-align: -2px; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReferrerInput {
  private readonly api = inject(ReferralsApi);

  /** The marketer's name (or code) as typed; '' for nobody. */
  readonly value = model('');
  readonly inputId = input<string | null>(null);

  protected readonly listId = `referrers-${++next}`;
  protected readonly hintId = `${this.listId}-hint`;
  protected readonly referrers = signal<readonly Referrer[]>([]);

  /** Who the typed name is, or that saving adds them. */
  protected readonly hint = computed(() => {
    const typed = this.value().trim();
    if (!typed) return { fresh: false, text: 'Optional. Who brought this business; they earn on its payments.' };
    const lower = typed.toLowerCase();
    const known = this.referrers().find((r) => r.name.toLowerCase() === lower || r.code.toLowerCase() === lower);
    if (known) {
      return { fresh: false, text: `${known.name}, ${known.code}: ${rateText(known.commissionType, known.commissionValue)}${known.status === 'paused' ? ' (paused)' : ''}.` };
    }
    return { fresh: true, text: `New marketer: ${typed} is added at 10% of each payment when this saves. Change it in Referrals.` };
  });

  constructor() {
    this.load();
    // A marketer added here (or anywhere) shows in the list at once.
    inject(AdminFeed).watch(['referrals'], () => this.load());
  }

  private load(): void {
    this.api.list().subscribe({ next: ({ referrers }) => this.referrers.set(referrers), error: () => undefined });
  }

  protected rate(r: Referrer): string {
    return rateText(r.commissionType, r.commissionValue);
  }
}
