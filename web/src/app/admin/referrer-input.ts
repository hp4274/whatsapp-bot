import { ChangeDetectionStrategy, Component, computed, inject, input, model, signal } from '@angular/core';

import { AdminFeed } from './admin-feed';
import { Referrer, ReferralsApi, rateText } from './referrals-api';

let next = 0;

/** A row of the list: a marketer, or "add this name" when no marketer is called that yet. */
type Row = { readonly kind: 'pick'; readonly referrer: Referrer } | { readonly kind: 'new'; readonly name: string };

/**
 * "Referred by": type a marketer's name. Marketers typed before show in the list under the box (the quick-replies
 * list's look); a new name becomes a marketer when the form saves (server referrals.js
 * setForTenant, at the default 10%, changed later in Referrals). Empty = nobody.
 */
@Component({
  selector: 'app-referrer-input',
  template: `
    <div class="box">
      <input
        #box
        role="combobox"
        aria-autocomplete="list"
        [id]="inputId()"
        name="referrer"
        maxlength="120"
        autocomplete="off"
        placeholder="Marketer's name or code"
        [attr.aria-expanded]="open()"
        [attr.aria-controls]="listId"
        [attr.aria-activedescendant]="open() && rows().length ? listId + '-' + active() : null"
        [attr.aria-describedby]="hintId"
        [value]="value()"
        (input)="type($any($event.target).value)"
        (focus)="open.set(true)"
        (click)="open.set(true)"
        (blur)="open.set(false)"
        (keydown)="key($event)"
      />
      <i class="ti ti-selector" aria-hidden="true"></i>
      @if (open() && rows().length) {
        <ul class="list" role="listbox" [id]="listId" aria-label="Marketers">
          @for (row of rows(); track $index; let i = $index) {
            <li
              role="option"
              [id]="listId + '-' + i"
              [class.on]="i === active()"
              [class.add]="row.kind === 'new'"
              [attr.aria-selected]="i === active()"
              (mouseenter)="active.set(i)"
              (mousedown)="$event.preventDefault()"
              (click)="choose(row, box)"
            >
              @if (row.kind === 'pick') {
                <span class="avatar" aria-hidden="true">{{ row.referrer.name.charAt(0) }}</span>
                <span class="text">
                  <b>{{ row.referrer.name }}</b>
                  <small>{{ row.referrer.code }}, {{ rate(row.referrer) }}{{ row.referrer.status === 'paused' ? ', paused' : '' }}</small>
                </span>
                @if (row.referrer.name.toLowerCase() === value().trim().toLowerCase()) {
                  <i class="ti ti-check" aria-hidden="true"></i>
                }
              } @else {
                <span class="avatar" aria-hidden="true"><i class="ti ti-user-plus"></i></span>
                <span class="text">
                  <b>Add "{{ row.name }}"</b>
                  <small>New marketer at 10%, added when this saves</small>
                </span>
              }
            </li>
          }
        </ul>
      }
    </div>
    <small [id]="hintId" class="hint" [class.new]="hint().fresh">{{ hint().text }}</small>
  `,
  styles: `
    :host { display: grid; gap: 6px; min-width: 0; }
    .box { position: relative; }
    input { width: 100%; padding-right: 36px; }
    .box > .ti { position: absolute; right: 12px; top: 50%; translate: 0 -50%; font-size: 16px; color: var(--hint); pointer-events: none; }

    // Card surface, rounded rows, the active one sunken with a
    // primary bar.
    .list {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      z-index: 5;
      display: grid;
      gap: 2px;
      max-height: 264px;
      margin: 0;
      padding: 6px;
      overflow-y: auto;
      overscroll-behavior: contain;
      list-style: none;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      background: var(--surface-card);
      box-shadow: var(--shadow-lift);
      animation: list-in var(--fast) var(--ease) both;
    }
    li {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      padding: 6px 10px;
      border-radius: 10px;
      cursor: pointer;
      transition: background var(--fast) var(--ease);
      &.on { background: var(--surface-sunken); box-shadow: inset 3px 0 0 var(--primary); }
      &.add .avatar { background: var(--surface-sunken); }
      > .ti { margin-left: auto; font-size: 16px; color: var(--primary-text); }
    }
    .avatar {
      display: grid;
      place-items: center;
      flex: none;
      width: 30px;
      height: 30px;
      border-radius: 9px;
      background: var(--primary-tint);
      color: var(--primary-text);
      font-size: 13px;
      font-weight: 600;
      .ti { font-size: 16px; }
    }
    .text {
      display: grid;
      min-width: 0;
      b, small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      b { font-size: 13px; font-weight: 500; color: var(--text-strong); }
      small { font-size: 12px; color: var(--text-muted); }
    }
    .hint { font-size: 12px; line-height: 1.45; color: var(--text-muted); }
    .hint.new { color: var(--primary-text); }

    @keyframes list-in { from { opacity: 0; translate: 0 -4px; } }
    @media (prefers-reduced-motion: reduce) { .list { animation: none; } }
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
  protected readonly open = signal(false);
  protected readonly active = signal(0);

  /** The marketer the box names now, by name or code; null for a new name or none. */
  private readonly known = computed(() => {
    const typed = this.value().trim().toLowerCase();
    return typed ? this.referrers().find((r) => r.name.toLowerCase() === typed || r.code.toLowerCase() === typed) ?? null : null;
  });

  /** Marketers matching what is typed (all of them on an empty box), then "add" for a name nobody has yet. */
  protected readonly rows = computed<Row[]>(() => {
    const typed = this.value().trim();
    const q = typed.toLowerCase();
    const rows: Row[] = this.referrers()
      .filter((r) => !q || r.name.toLowerCase().includes(q) || r.code.toLowerCase().includes(q))
      .slice(0, 50)
      .map((referrer) => ({ kind: 'pick', referrer }));
    if (typed && !this.known()) rows.push({ kind: 'new', name: typed });
    return rows;
  });

  /** Who the typed name is, or that saving adds them. */
  protected readonly hint = computed(() => {
    const typed = this.value().trim();
    const known = this.known();
    if (!typed) return { fresh: false, text: 'Optional. Who brought this business; they earn on its payments.' };
    if (known) {
      return { fresh: false, text: `${known.code}: ${rateText(known.commissionType, known.commissionValue)}${known.status === 'paused' ? ' (paused)' : ''}.` };
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

  protected type(text: string): void {
    this.value.set(text);
    this.active.set(0);
    this.open.set(true);
  }

  /** A pick fires the box's change, as typing does: a form that saves on change (Edit details) saves it. */
  protected choose(row: Row, box: HTMLInputElement): void {
    this.open.set(false);
    if (row.kind !== 'pick' || box.value === row.referrer.name) return;
    box.value = row.referrer.name;
    this.value.set(row.referrer.name);
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Up and down move through the list, Enter picks, Escape shuts it (and only it, not the drawer around it). */
  protected key(event: KeyboardEvent): void {
    const rows = this.rows();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.open()) return this.open.set(true);
      if (rows.length) this.active.update((i) => (i + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === 'Enter' && this.open() && rows.length) {
      event.preventDefault();
      this.choose(rows[Math.min(this.active(), rows.length - 1)], event.target as HTMLInputElement);
    } else if (event.key === 'Escape' && this.open()) {
      event.stopPropagation();
      this.open.set(false);
    }
  }

  protected rate(r: Referrer): string {
    return rateText(r.commissionType, r.commissionValue);
  }
}
