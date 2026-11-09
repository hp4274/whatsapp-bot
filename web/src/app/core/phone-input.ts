import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  input,
  model,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

/**
 * Dial codes offered, India first (the platform's default); the rest by name. `digits`: the most digits a number
 * has there, without the country code or a leading 0 (the longest mobile number where lengths vary).
 */
export const COUNTRY_CODES: readonly { readonly code: string; readonly name: string; readonly digits: number }[] = [
  { code: '91', name: 'India', digits: 10 },
  { code: '971', name: 'United Arab Emirates', digits: 9 },
  { code: '1', name: 'United States / Canada', digits: 10 },
  { code: '44', name: 'United Kingdom', digits: 10 },
  { code: '61', name: 'Australia', digits: 9 },
  { code: '880', name: 'Bangladesh', digits: 10 },
  { code: '973', name: 'Bahrain', digits: 8 },
  { code: '55', name: 'Brazil', digits: 11 },
  { code: '86', name: 'China', digits: 11 },
  { code: '20', name: 'Egypt', digits: 10 },
  { code: '33', name: 'France', digits: 9 },
  { code: '49', name: 'Germany', digits: 11 },
  { code: '852', name: 'Hong Kong', digits: 8 },
  { code: '62', name: 'Indonesia', digits: 12 },
  { code: '353', name: 'Ireland', digits: 9 },
  { code: '39', name: 'Italy', digits: 10 },
  { code: '81', name: 'Japan', digits: 10 },
  { code: '254', name: 'Kenya', digits: 9 },
  { code: '965', name: 'Kuwait', digits: 8 },
  { code: '60', name: 'Malaysia', digits: 10 },
  { code: '960', name: 'Maldives', digits: 7 },
  { code: '230', name: 'Mauritius', digits: 8 },
  { code: '52', name: 'Mexico', digits: 10 },
  { code: '977', name: 'Nepal', digits: 10 },
  { code: '31', name: 'Netherlands', digits: 9 },
  { code: '64', name: 'New Zealand', digits: 10 },
  { code: '234', name: 'Nigeria', digits: 10 },
  { code: '968', name: 'Oman', digits: 8 },
  { code: '92', name: 'Pakistan', digits: 10 },
  { code: '63', name: 'Philippines', digits: 10 },
  { code: '974', name: 'Qatar', digits: 8 },
  { code: '7', name: 'Russia', digits: 10 },
  { code: '966', name: 'Saudi Arabia', digits: 9 },
  { code: '65', name: 'Singapore', digits: 8 },
  { code: '27', name: 'South Africa', digits: 9 },
  { code: '82', name: 'South Korea', digits: 10 },
  { code: '34', name: 'Spain', digits: 9 },
  { code: '94', name: 'Sri Lanka', digits: 9 },
  { code: '46', name: 'Sweden', digits: 9 },
  { code: '41', name: 'Switzerland', digits: 9 },
  { code: '255', name: 'Tanzania', digits: 9 },
  { code: '66', name: 'Thailand', digits: 9 },
  { code: '90', name: 'Turkey', digits: 10 },
  { code: '256', name: 'Uganda', digits: 9 },
  { code: '380', name: 'Ukraine', digits: 9 },
  { code: '84', name: 'Vietnam', digits: 10 },
];

const DEFAULT_CODE = '91';
/** Longest first, so +971 is not read as +97 or +9. */
const BY_LENGTH = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);

/** The most digits a number in that country takes (15, the world maximum, for a code not in the list). */
export function maxDigits(code: string): number {
  return COUNTRY_CODES.find((c) => c.code === code)?.digits ?? 15;
}

/**
 * Cut what was typed after `max` digits, keeping its spaces and dashes. A leading 0 (how many countries write a
 * number at home) does not count.
 */
export function limitDigits(text: string, max: number): string {
  const cap = max + (text.replace(/\D/g, '').startsWith('0') ? 1 : 0);
  let seen = 0;
  let out = '';
  for (const ch of text) {
    if (/\d/.test(ch)) {
      if (seen === cap) break;
      seen++;
    }
    out += ch;
  }
  return out;
}

/**
 * "+971 50 123 4567" → { code: '971', number: '50 123 4567' }. Without a "+", a number that is a known code plus
 * ten digits ("919876543210", as numbers are often stored) is split the same way; anything else is a number in
 * the default country.
 */
export function splitPhone(value: string): { code: string; number: string } {
  const text = String(value ?? '').trim();
  const digits = text.replace(/\D/g, '');
  if (text.startsWith('+')) {
    const hit = BY_LENGTH.find((c) => digits.startsWith(c.code));
    if (hit) return { code: hit.code, number: text.replace(/^\+\s*/, '').slice(hit.code.length).trim() || digits.slice(hit.code.length) };
  } else {
    const hit = BY_LENGTH.find((c) => digits.length === c.code.length + 10 && digits.startsWith(c.code));
    if (hit) return { code: hit.code, number: digits.slice(hit.code.length) };
  }
  return { code: DEFAULT_CODE, number: text };
}

/** The value a form gets: "+91 98765 43210", or '' while no number is typed. */
export function joinPhone(code: string, number: string): string {
  const n = number.trim();
  return n ? `+${code} ${n}` : '';
}

let next = 0;

/**
 * A phone or WhatsApp number with its country code chosen beside it. The value stays one string ("+91 98765
 * 43210"), as every form here already sends; a number pasted with its own "+code" sets the country. The country
 * list searches by name or code, and the number stops at that country's length.
 */
@Component({
  selector: 'app-phone-input',
  template: `
    <div class="pick" (focusout)="leave($event)" (keydown.escape)="escape($event)">
      <button
        #trigger
        type="button"
        class="code"
        aria-haspopup="listbox"
        [attr.aria-expanded]="open()"
        [attr.aria-label]="'Country code for ' + (label() || 'the number') + ': ' + country().name + ', +' + code()"
        [disabled]="disabled()"
        (click)="toggle()"
        (keydown.arrowdown)="$event.preventDefault(); show()"
      >
        +{{ code() }}<i class="ti ti-chevron-down" aria-hidden="true"></i>
      </button>
      @if (open()) {
        <div class="menu">
          <label class="find">
            <i class="ti ti-search" aria-hidden="true"></i>
            <input
              #search
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-label="Search country or code"
              placeholder="Search country or code"
              autocomplete="off"
              [attr.aria-controls]="listId"
              aria-expanded="true"
              [attr.aria-activedescendant]="shown().length ? listId + '-' + active() : null"
              [value]="query()"
              (input)="query.set($any($event.target).value); active.set(0)"
              (keydown)="key($event)"
            />
          </label>
          <!-- data-lenis-prevent: the landing page's smooth scrolling (Lenis) takes the wheel and touch for the whole page; this list scrolls on its own. -->
          <ul #list class="list" role="listbox" [id]="listId" aria-label="Countries" data-lenis-prevent>
            @for (c of shown(); track c.code; let i = $index) {
              <li
                role="option"
                [id]="listId + '-' + i"
                [class.on]="i === active()"
                [attr.aria-selected]="c.code === code()"
                (mouseenter)="active.set(i)"
                (mousedown)="$event.preventDefault()"
                (click)="pick(c.code)"
              >
                <span class="name">{{ c.name }}</span>
                <span class="dial">+{{ c.code }}</span>
                @if (c.code === code()) {
                  <i class="ti ti-check" aria-hidden="true"></i>
                }
              </li>
            } @empty {
              <li class="none">No country matches</li>
            }
          </ul>
        </div>
      }
    </div>
    <input
      #box
      type="tel"
      inputmode="tel"
      maxlength="24"
      [id]="inputId()"
      [attr.name]="name()"
      [attr.autocomplete]="autocomplete()"
      [attr.aria-label]="inputId() ? null : label() || null"
      [attr.aria-invalid]="invalid() || null"
      [attr.aria-describedby]="describedBy()"
      [class.invalid]="invalid()"
      [required]="required()"
      [disabled]="disabled()"
      [placeholder]="placeholder()"
      [value]="number()"
      (input)="type($any($event.target))"
    />
  `,
  styles: `
    :host { display: flex; gap: 6px; min-width: 0; }
    .pick { position: relative; flex: none; display: flex; }
    .code {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0 10px 0 12px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--surface-sunken);
      color: var(--text-strong);
      font: inherit;
      font-size: 14px;
      font-variant-numeric: tabular-nums;
      cursor: pointer;
      transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
      .ti { font-size: 13px; color: var(--text-muted); transition: rotate var(--fast) var(--ease); }
      &:hover:not(:disabled) { border-color: var(--border-hover); }
      &:focus-visible, &[aria-expanded='true'] { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--input-focus); }
      &[aria-expanded='true'] .ti { rotate: 180deg; }
      &:disabled { opacity: 0.6; cursor: default; }
    }

    // The app's own dropdown (as referrer-input): card, search on top, a list that scrolls.
    .menu {
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      z-index: 20;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      width: min(300px, calc(100vw - 32px));
      max-height: min(340px, 60vh);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      background: var(--surface-card);
      box-shadow: var(--shadow-lift);
      overflow: hidden;
      animation: menu-in var(--fast) var(--ease) both;
    }
    .find {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 6px 6px 0;
      padding: 0 10px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      color: var(--hint);
      &:focus-within { border-color: var(--primary); }
      .ti { font-size: 16px; }
      input { flex: 1; min-width: 0; padding: 8px 0; border: 0; background: transparent; box-shadow: none; font-size: 13.5px; }
    }
    .list {
      display: grid;
      align-content: start;
      gap: 2px;
      min-height: 0;
      margin: 0;
      padding: 6px;
      overflow-y: auto;
      overscroll-behavior: contain;
      -webkit-overflow-scrolling: touch;
      list-style: none;
    }
    li {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 40px;
      padding: 6px 10px;
      border-radius: 10px;
      font-size: 13.5px;
      color: var(--text-strong);
      cursor: pointer;
      transition: background var(--fast) var(--ease);
      &.on { background: var(--surface-sunken); box-shadow: inset 3px 0 0 var(--primary); }
      &[aria-selected='true'] .name { font-weight: 500; }
      .ti { font-size: 15px; color: var(--primary-text); }
      &.none { color: var(--text-muted); cursor: default; }
    }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dial { color: var(--text-muted); font-variant-numeric: tabular-nums; }
    input[type='tel'] { flex: 1; min-width: 0; }
    input.invalid { border-color: var(--danger); }

    @keyframes menu-in { from { opacity: 0; translate: 0 -4px; } }
    @media (prefers-reduced-motion: reduce) { .menu { animation: none; } }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhoneInput {
  /** "+91 98765 43210", or ''. */
  readonly value = model('');
  readonly inputId = input<string | null>(null);
  readonly name = input<string | null>(null);
  readonly placeholder = input('98765 43210');
  readonly autocomplete = input('tel-national');
  /** Read out with the country picker, and on the number when no `<label for>` names it. */
  readonly label = input('');
  readonly required = input(false);
  readonly disabled = input(false);
  readonly invalid = input(false);
  readonly describedBy = input<string | null>(null);

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  private readonly box = viewChild.required<ElementRef<HTMLInputElement>>('box');
  private readonly search = viewChild<ElementRef<HTMLInputElement>>('search');
  private readonly list = viewChild<ElementRef<HTMLUListElement>>('list');

  protected readonly listId = `countries-${++next}`;
  protected readonly code = signal(DEFAULT_CODE);
  protected readonly number = signal('');
  protected readonly open = signal(false);
  protected readonly query = signal('');
  protected readonly active = signal(0);
  protected readonly country = computed(() => COUNTRY_CODES.find((c) => c.code === this.code()) ?? { code: this.code(), name: 'Country', digits: 15 });
  /** By name or code: "ind", "91" and "+91" all find India. */
  protected readonly shown = computed(() => {
    const q = this.query().trim().toLowerCase().replace(/^\+/, '');
    return q ? COUNTRY_CODES.filter((c) => c.name.toLowerCase().includes(q) || c.code.startsWith(q)) : COUNTRY_CODES;
  });
  private readonly joined = computed(() => joinPhone(this.code(), this.number()));

  constructor() {
    // A value set from outside (a form loaded or reset) is split again; one this field just wrote is left alone.
    effect(() => {
      const value = this.value();
      untracked(() => {
        if (value === this.joined()) return;
        const { code, number } = splitPhone(value);
        this.code.set(code);
        this.number.set(number);
      });
    });
    // Opened: search takes focus, the country chosen now is in view.
    effect(() => {
      const search = this.search();
      if (!search) return;
      search.nativeElement.focus({ preventScroll: true });
      untracked(() => this.list()?.nativeElement.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }));
    });
  }

  protected toggle(): void {
    if (this.open()) this.close(false);
    else this.show();
  }

  protected show(): void {
    this.query.set('');
    this.active.set(Math.max(0, COUNTRY_CODES.findIndex((c) => c.code === this.code())));
    this.open.set(true);
  }

  protected pick(code: string): void {
    this.code.set(code);
    // A number longer than the new country takes is cut to fit.
    this.number.update((n) => limitDigits(n, maxDigits(code)));
    this.emit();
    this.close(false);
    this.box().nativeElement.focus();
  }

  /** Up and down move through the list (keeping the row in view), Enter picks. */
  protected key(event: KeyboardEvent): void {
    const rows = this.shown();
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!rows.length) return;
      this.active.update((i) => (i + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
      this.list()?.nativeElement.querySelector(`#${this.listId}-${this.active()}`)?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const row = rows[Math.min(this.active(), rows.length - 1)];
      if (row) this.pick(row.code);
    }
  }

  /** Escape shuts the list, and only the list: it stops here, so a drawer or an edit around the field stays open. */
  protected escape(event: Event): void {
    if (!this.open()) return;
    event.stopPropagation();
    this.close(true);
  }

  /** Focus left the picker (a click elsewhere, Tab): the list shuts. */
  protected leave(event: FocusEvent): void {
    const to = event.relatedTarget as Node | null;
    if (!to || !(event.currentTarget as HTMLElement).contains(to)) this.close(false);
  }

  private close(refocus: boolean): void {
    this.open.set(false);
    if (refocus) this.trigger().nativeElement.focus();
  }

  /** A "+code" pasted into the number moves to the picker; letters are dropped; digits stop at the country's length. */
  protected type(box: HTMLInputElement): void {
    let text = box.value;
    if (text.trim().startsWith('+')) {
      const { code, number } = splitPhone(text);
      this.code.set(code);
      text = number;
    }
    const clean = limitDigits(text.replace(/[^\d\s()-]/g, ''), maxDigits(this.code()));
    if (clean !== box.value) box.value = clean;
    this.number.set(clean);
    this.emit();
  }

  private emit(): void {
    this.value.set(this.joined());
  }
}
