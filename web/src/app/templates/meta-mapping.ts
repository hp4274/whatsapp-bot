import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

/**
 * Meta approved-template send settings: language code and the ordered
 * {{1}}, {{2}} ... -> contact variable mapping. Wire shape is the server's
 * `paramMapping` (server/src/messaging/templateSend.js) - change both together.
 */
export interface MetaSlot {
  var?: string;
  fallback?: string;
}
export type MetaHeaderType = 'text' | 'image' | 'video' | 'document';
export interface MetaHeader {
  type: MetaHeaderType;
  var?: string;
  fallback?: string;
  link?: string;
}
export interface MetaButton {
  index: number;
  subType?: 'url' | 'quick_reply';
  var?: string;
  fallback?: string;
}
export interface MetaMapping {
  body?: MetaSlot[];
  header?: MetaHeader | null;
  buttons?: MetaButton[];
}

/** Common Meta locale codes offered as suggestions; any code can still be typed. */
const LANGUAGES = [
  'en',
  'en_US',
  'en_GB',
  'hi',
  'mr',
  'gu',
  'ta',
  'te',
  'kn',
  'ml',
  'bn',
  'pa',
  'ur',
  'ar',
  'es',
  'pt_BR',
  'fr',
  'de',
  'id',
];
/** Columns every contact has, always suggested even if the body uses none. */
const BASE_VARS = ['name', 'phone'];
const SLOT = /\{\{\s*(\d+)\s*\}\}/g;

/** Per-instance id counter for label/input pairs. */
let seq = 0;

/** Editor for a Meta-approved template's language and numbered-slot parameter mapping. */
@Component({
  selector: 'app-meta-mapping',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mm" [attr.aria-labelledby]="uid + '-h'">
      <h4 [id]="uid + '-h'">
        <i class="ti ti-discount-check" aria-hidden="true"></i> Meta send settings
      </h4>
      <p class="lead">
        Paste the body exactly as Meta approved it, with <code>{{ brace(1) }}</code
        >, <code>{{ brace(2) }}</code
        >… Each slot below says which contact column fills it; the fallback is used when that column
        is empty.
      </p>

      <div class="field lang">
        <label [for]="uid + '-lang'">Language code</label>
        <input
          [id]="uid + '-lang'"
          [attr.list]="uid + '-langs'"
          placeholder="en_US"
          [value]="language()"
          (input)="language.set(val($event))"
        />
        <datalist [id]="uid + '-langs'">
          @for (l of languages; track l) {
            <option [value]="l"></option>
          }
        </datalist>
        <span class="hint">Must match the approved translation exactly (en vs en_US).</span>
      </div>

      <datalist [id]="uid + '-vars'">
        @for (v of varChoices(); track v) {
          <option [value]="v"></option>
        }
      </datalist>

      @if (slots().length) {
        <div class="slots">
          @for (n of slots(); track n) {
            <div class="slot" [style.--i]="n">
              <span class="tag">{{ brace(n) }}</span>
              <div class="field">
                <label [for]="uid + '-v' + n">Column</label>
                <input
                  [id]="uid + '-v' + n"
                  [attr.list]="uid + '-vars'"
                  placeholder="name"
                  [value]="slot(n).var ?? ''"
                  (input)="setSlot(n, 'var', val($event))"
                />
              </div>
              <div class="field">
                <label [for]="uid + '-f' + n">Fallback</label>
                <input
                  [id]="uid + '-f' + n"
                  placeholder="e.g. there"
                  [value]="slot(n).fallback ?? ''"
                  (input)="setSlot(n, 'fallback', val($event))"
                />
              </div>
            </div>
          }
        </div>
        <p class="pv"><i class="ti ti-eye" aria-hidden="true"></i>{{ preview() }}</p>
      } @else {
        <p class="hint">
          No <code>{{ brace('n') }}</code> slots in the body: the template is sent without body
          parameters.
        </p>
      }

      <div class="row2">
        <div class="field">
          <label [for]="uid + '-ht'">Header parameter</label>
          <select
            [id]="uid + '-ht'"
            [value]="mapping().header?.type ?? ''"
            (change)="setHeaderType(val($event))"
          >
            <option value="">None / static header</option>
            <option value="text">Text {{ brace(1) }}</option>
            <option value="image">Image</option>
            <option value="video">Video</option>
            <option value="document">Document</option>
          </select>
        </div>
        @if (mapping().header?.type === 'text') {
          <div class="field">
            <label [for]="uid + '-hv'">Column</label>
            <input
              [id]="uid + '-hv'"
              [attr.list]="uid + '-vars'"
              [value]="mapping().header?.var ?? ''"
              (input)="setHeader('var', val($event))"
            />
          </div>
          <div class="field">
            <label [for]="uid + '-hf'">Fallback</label>
            <input
              [id]="uid + '-hf'"
              [value]="mapping().header?.fallback ?? ''"
              (input)="setHeader('fallback', val($event))"
            />
          </div>
        } @else if (mapping().header?.type) {
          <div class="field grow">
            <label [for]="uid + '-hl'">Public link <small>optional</small></label>
            <input
              [id]="uid + '-hl'"
              type="url"
              placeholder="https://… (empty = the campaign attachment)"
              [value]="mapping().header?.link ?? ''"
              (input)="setHeader('link', val($event))"
            />
          </div>
        }
      </div>

      <div class="btns">
        <span class="sub">Dynamic button parameters</span>
        @for (b of mapping().buttons ?? []; track $index; let i = $index) {
          <div class="slot">
            <div class="field narrow">
              <label [for]="uid + '-bi' + i">Button #</label>
              <input
                [id]="uid + '-bi' + i"
                type="number"
                min="0"
                max="9"
                [value]="b.index"
                (input)="setButton(i, 'index', +val($event))"
              />
            </div>
            <div class="field">
              <label [for]="uid + '-bs' + i">Kind</label>
              <select
                [id]="uid + '-bs' + i"
                [value]="b.subType ?? 'url'"
                (change)="setButton(i, 'subType', val($event))"
              >
                <option value="url">URL suffix</option>
                <option value="quick_reply">Quick-reply payload</option>
              </select>
            </div>
            <div class="field">
              <label [for]="uid + '-bv' + i">Column</label>
              <input
                [id]="uid + '-bv' + i"
                [attr.list]="uid + '-vars'"
                [value]="b.var ?? ''"
                (input)="setButton(i, 'var', val($event))"
              />
            </div>
            <div class="field">
              <label [for]="uid + '-bf' + i">Fallback</label>
              <input
                [id]="uid + '-bf' + i"
                [value]="b.fallback ?? ''"
                (input)="setButton(i, 'fallback', val($event))"
              />
            </div>
            <button
              class="btn sm danger-ghost x"
              type="button"
              (click)="removeButton(i)"
              aria-label="Remove button parameter"
            >
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
          </div>
        }
        <button class="btn sm" type="button" (click)="addButton()">
          <i class="ti ti-link-plus" aria-hidden="true"></i> Add button parameter
        </button>
      </div>
    </section>
  `,
  styles: `
    .mm {
      display: grid;
      gap: var(--space-md);
      padding: var(--space-lg);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg);
      background: var(--surface-card);
      perspective: 900px;
    }
    h4 {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 0;
      font-size: 14px;
      font-weight: 500;
      color: var(--text-strong);
    }
    h4 .ti {
      font-size: 17px;
      color: var(--warning);
    }
    .lead,
    .hint {
      margin: 0;
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--text-muted);
    }
    .field label {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-strong);
    }
    .field small {
      font-weight: 400;
      color: var(--hint);
    }
    .lang {
      max-width: 220px;
    }
    .slots,
    .btns {
      display: grid;
      gap: var(--space-sm);
    }
    .slot {
      display: grid;
      grid-template-columns: auto 1fr 1fr auto;
      align-items: end;
      gap: var(--space-sm);
      padding: 10px 12px;
      border-radius: var(--radius-md);
      background: var(--surface-sunken);
      transform-origin: left center;
      animation: mm-in 360ms var(--ease, ease-out) both;
      animation-delay: calc(var(--i, 0) * 40ms);
      transition:
        transform var(--fast) var(--ease),
        box-shadow var(--fast) var(--ease);
    }
    .slot:hover {
      transform: translateZ(8px) rotateX(2deg);
      box-shadow: var(--shadow-card);
    }
    .btns .slot {
      grid-template-columns: 80px 1fr 1fr 1fr auto;
    }
    .tag {
      align-self: center;
      padding: 4px 9px;
      border-radius: 999px;
      font: 500 12px var(--mono, monospace);
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent);
    }
    .row2 {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: var(--space-sm);
    }
    .grow {
      grid-column: span 2;
    }
    .sub {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-strong);
    }
    .pv {
      display: flex;
      gap: 8px;
      align-items: flex-start;
      margin: 0;
      padding: 10px 14px;
      border-radius: var(--radius-md);
      font-size: 13px;
      line-height: 1.5;
      white-space: pre-wrap;
      color: var(--text-color);
      background: var(--surface-sunken);
    }
    .pv .ti {
      font-size: 16px;
      color: var(--text-muted);
    }
    .btn.sm {
      min-height: 32px;
      padding: 0 11px;
      font-size: 12.5px;
      justify-self: start;
    }
    .btn.danger-ghost {
      width: 32px;
      padding: 0;
      background: transparent;
      color: var(--danger-text);
      border-color: rgba(220, 38, 38, 0.35);
    }
    .btn.danger-ghost:hover:not(:disabled) {
      background: rgba(239, 68, 68, 0.08);
    }
    .x {
      align-self: end;
    }
    @keyframes mm-in {
      from {
        opacity: 0;
        transform: rotateY(-8deg) translateX(-6px);
      }
    }
    @media (max-width: 640px) {
      .slot,
      .btns .slot {
        grid-template-columns: 1fr 1fr;
      }
      .grow {
        grid-column: auto;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .slot {
        animation: none;
        transition: none;
      }
    }
  `,
})
export class MetaMappingEditor {
  /** The approved body: its {{n}} slots decide how many rows there are. */
  readonly body = input('');
  /** Variables the page already knows about (suggested in the column pickers). */
  readonly vars = input<string[]>([]);
  readonly language = model('');
  readonly mapping = model<MetaMapping>({});

  protected readonly uid = `mm${++seq}`;
  protected readonly languages = LANGUAGES;
  protected readonly varChoices = computed(() => [
    ...new Set([...BASE_VARS, ...this.vars().filter((v) => !/^\d+$/.test(v))]),
  ]);
  protected readonly slots = computed(() => {
    let max = 0;
    for (const [, n] of this.body().matchAll(SLOT)) max = Math.max(max, Number(n));
    return Array.from({ length: max }, (_, i) => i + 1);
  });
  protected readonly preview = computed(() =>
    this.body().replace(SLOT, (match, n: string) => {
      const s = this.slot(Number(n));
      return s.var ? `[${s.var}${s.fallback ? ' | ' + s.fallback : ''}]` : s.fallback || match;
    }),
  );

  protected brace(n: number | string): string {
    return `{{${n}}}`;
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected slot(n: number): MetaSlot {
    return this.mapping().body?.[n - 1] ?? {};
  }

  protected setSlot(n: number, key: keyof MetaSlot, value: string): void {
    const body = Array.from(
      { length: Math.max(n, this.mapping().body?.length ?? 0) },
      (_, i) => this.mapping().body?.[i] ?? {},
    );
    body[n - 1] = { ...body[n - 1], [key]: value.trim() };
    this.mapping.update((m) => ({ ...m, body }));
  }

  protected setHeaderType(type: string): void {
    this.mapping.update((m) => ({ ...m, header: type ? { type: type as MetaHeaderType } : null }));
  }

  protected setHeader(key: 'var' | 'fallback' | 'link', value: string): void {
    this.mapping.update((m) =>
      m.header ? { ...m, header: { ...m.header, [key]: value.trim() } } : m,
    );
  }

  protected addButton(): void {
    this.mapping.update((m) => ({
      ...m,
      buttons: [...(m.buttons ?? []), { index: m.buttons?.length ?? 0, subType: 'url' }],
    }));
  }

  protected setButton(i: number, key: keyof MetaButton, value: string | number): void {
    this.mapping.update((m) => ({
      ...m,
      buttons: (m.buttons ?? []).map((b, j) =>
        j === i ? { ...b, [key]: typeof value === 'string' ? value.trim() : value } : b,
      ),
    }));
  }

  protected removeButton(i: number): void {
    this.mapping.update((m) => ({ ...m, buttons: (m.buttons ?? []).filter((_, j) => j !== i) }));
  }
}
