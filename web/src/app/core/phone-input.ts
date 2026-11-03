import { ChangeDetectionStrategy, Component, computed, effect, input, model, signal, untracked } from '@angular/core';

/** Dial codes offered, India first (the platform's default); the rest by name. */
export const COUNTRY_CODES: readonly { readonly code: string; readonly name: string }[] = [
  { code: '91', name: 'India' },
  { code: '971', name: 'United Arab Emirates' },
  { code: '1', name: 'United States / Canada' },
  { code: '44', name: 'United Kingdom' },
  { code: '61', name: 'Australia' },
  { code: '880', name: 'Bangladesh' },
  { code: '973', name: 'Bahrain' },
  { code: '55', name: 'Brazil' },
  { code: '86', name: 'China' },
  { code: '20', name: 'Egypt' },
  { code: '33', name: 'France' },
  { code: '49', name: 'Germany' },
  { code: '852', name: 'Hong Kong' },
  { code: '62', name: 'Indonesia' },
  { code: '353', name: 'Ireland' },
  { code: '39', name: 'Italy' },
  { code: '81', name: 'Japan' },
  { code: '254', name: 'Kenya' },
  { code: '965', name: 'Kuwait' },
  { code: '60', name: 'Malaysia' },
  { code: '960', name: 'Maldives' },
  { code: '230', name: 'Mauritius' },
  { code: '52', name: 'Mexico' },
  { code: '977', name: 'Nepal' },
  { code: '31', name: 'Netherlands' },
  { code: '64', name: 'New Zealand' },
  { code: '234', name: 'Nigeria' },
  { code: '968', name: 'Oman' },
  { code: '92', name: 'Pakistan' },
  { code: '63', name: 'Philippines' },
  { code: '974', name: 'Qatar' },
  { code: '7', name: 'Russia' },
  { code: '966', name: 'Saudi Arabia' },
  { code: '65', name: 'Singapore' },
  { code: '27', name: 'South Africa' },
  { code: '82', name: 'South Korea' },
  { code: '34', name: 'Spain' },
  { code: '94', name: 'Sri Lanka' },
  { code: '46', name: 'Sweden' },
  { code: '41', name: 'Switzerland' },
  { code: '255', name: 'Tanzania' },
  { code: '66', name: 'Thailand' },
  { code: '90', name: 'Turkey' },
  { code: '256', name: 'Uganda' },
  { code: '380', name: 'Ukraine' },
  { code: '84', name: 'Vietnam' },
];

const DEFAULT_CODE = '91';
/** Longest first, so +971 is not read as +97 or +9. */
const BY_LENGTH = [...COUNTRY_CODES].sort((a, b) => b.code.length - a.code.length);

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

/**
 * A phone or WhatsApp number with its country code chosen beside it. The value stays one string ("+91 98765
 * 43210"), as every form here already sends; a number pasted with its own "+code" sets the picker.
 */
@Component({
  selector: 'app-phone-input',
  template: `
    <span class="code" [class.disabled]="disabled()">
      <span aria-hidden="true">+{{ code() }}</span>
      <i class="ti ti-chevron-down" aria-hidden="true"></i>
      <select
        [attr.aria-label]="'Country code for ' + (label() || 'the number')"
        [disabled]="disabled()"
        [value]="code()"
        (change)="pick($any($event.target).value)"
      >
        @for (c of countries; track c.code) {
          <option [value]="c.code" [selected]="c.code === code()">{{ c.name }} (+{{ c.code }})</option>
        }
      </select>
    </span>
    <input
      type="tel"
      inputmode="tel"
      maxlength="20"
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
    .code {
      position: relative;
      display: inline-flex;
      flex: none;
      align-items: center;
      gap: 4px;
      padding: 0 10px 0 12px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--surface-sunken);
      color: var(--text-strong);
      font-size: 14px;
      font-variant-numeric: tabular-nums;
      transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
      .ti { font-size: 13px; color: var(--text-muted); }
      &:hover:not(.disabled) { border-color: var(--border-hover); }
      &:focus-within { border-color: var(--primary); box-shadow: 0 0 0 3px var(--input-focus); }
      &.disabled { opacity: 0.6; }
    }
    // The real select sits over the chip, invisible: the chip shows just "+91", the list says which country.
    .code select {
      position: absolute;
      inset: 0;
      width: 100%;
      padding: 0;
      border: 0;
      opacity: 0;
      cursor: pointer;
      &:focus-visible { outline: none; box-shadow: none; }
    }
    input { flex: 1; min-width: 0; }
    input.invalid { border-color: var(--danger); }
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

  protected readonly countries = COUNTRY_CODES;
  protected readonly code = signal(DEFAULT_CODE);
  protected readonly number = signal('');
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
  }

  protected pick(code: string): void {
    this.code.set(code);
    this.emit();
  }

  /** A "+code" pasted into the number moves to the picker; letters are dropped. */
  protected type(box: HTMLInputElement): void {
    let text = box.value;
    if (text.trim().startsWith('+')) {
      const { code, number } = splitPhone(text);
      this.code.set(code);
      text = number;
    }
    const clean = text.replace(/[^\d\s()-]/g, '');
    if (clean !== box.value) box.value = clean;
    this.number.set(clean);
    this.emit();
  }

  private emit(): void {
    this.value.set(this.joined());
  }
}
