import { ChangeDetectionStrategy, Component, computed, input, model } from '@angular/core';

import type { MetaButton, MetaMapping, MetaSlot } from '../../templates/meta-mapping';
import type { Template } from '../../templates/templates-api';
import { slotCount } from '../wa-format';

/** Instance counter so label[for] ids stay unique when two mappers are on screen. */
let seq = 0;

/**
 * Per-campaign {{n}} -> contact variable mapping for one approved template
 * (wire shape: server/src/messaging/templateSend.js). The slot count comes from
 * the approved body; header/button rows from the template's stored mapping,
 * and the operator can add button rows the record does not describe.
 */
@Component({
  selector: 'app-meta-params',
  template: `
    @let m = mapping();
    <p class="body">
      <i class="ti ti-quote" aria-hidden="true"></i
      >{{ template().body || 'No body text stored for this template.' }}
    </p>

    @if (m.header?.type === 'text') {
      <div class="row">
        <span class="tag">Header</span>
        <label class="sr" [for]="uid + '-hv'">Variable for the header</label>
        <select [id]="uid + '-hv'" (change)="setHeader('var', val($event))">
          <option value="" [selected]="!m.header?.var">Fixed text (fallback)</option>
          @for (v of variables(); track v) {
            <option [value]="v" [selected]="v === m.header?.var">{{ '{' + v + '}' }}</option>
          }
        </select>
        <label class="sr" [for]="uid + '-hf'">Header fallback</label>
        <input
          [id]="uid + '-hf'"
          placeholder="Fallback"
          [value]="m.header?.fallback ?? ''"
          (input)="setHeader('fallback', val($event))"
        />
      </div>
    } @else if (m.header?.type) {
      <p class="note">
        <i class="ti ti-photo-video" aria-hidden="true"></i> This template has a
        {{ m.header?.type }} header - the campaign attachment below is sent as that header.
      </p>
    }

    @for (n of slots(); track n) {
      <div class="row" [style.--i]="n">
        <span class="tag">{{ brace(n) }}</span>
        <label class="sr" [for]="uid + '-v' + n">Variable for {{ brace(n) }}</label>
        <select [id]="uid + '-v' + n" (change)="setSlot(n, 'var', val($event))">
          <option value="" [selected]="!slot(n).var">Fixed text (fallback)</option>
          @for (v of variables(); track v) {
            <option [value]="v" [selected]="v === slot(n).var">{{ '{' + v + '}' }}</option>
          }
        </select>
        <label class="sr" [for]="uid + '-f' + n">Fallback for {{ brace(n) }}</label>
        <input
          [id]="uid + '-f' + n"
          placeholder="Fallback"
          [value]="slot(n).fallback ?? ''"
          (input)="setSlot(n, 'fallback', val($event))"
        />
      </div>
    } @empty {
      <p class="note">No {{ brace('n') }} slots - this template is sent as is.</p>
    }

    @for (b of m.buttons ?? []; track $index; let i = $index) {
      <div class="row btn-row">
        <span class="tag"
          >Button {{ b.index }} · {{ b.subType === 'quick_reply' ? 'payload' : 'URL' }}</span
        >
        <label class="sr" [for]="uid + '-bv' + i">Variable for button {{ b.index }}</label>
        <select [id]="uid + '-bv' + i" (change)="setButton(i, 'var', val($event))">
          <option value="" [selected]="!b.var">Fixed text (fallback)</option>
          @for (v of variables(); track v) {
            <option [value]="v" [selected]="v === b.var">{{ '{' + v + '}' }}</option>
          }
        </select>
        <label class="sr" [for]="uid + '-bf' + i">Fallback for button {{ b.index }}</label>
        <input
          [id]="uid + '-bf' + i"
          placeholder="Fallback"
          [value]="b.fallback ?? ''"
          (input)="setButton(i, 'fallback', val($event))"
        />
        <button
          type="button"
          class="x"
          (click)="removeButton(i)"
          [attr.aria-label]="'Remove button ' + b.index + ' parameter'"
        >
          <i class="ti ti-x" aria-hidden="true"></i>
        </button>
      </div>
    }
    <div class="add">
      <button type="button" class="btn small" (click)="addButton('url')">
        <i class="ti ti-link-plus" aria-hidden="true"></i> URL button parameter
      </button>
      <button type="button" class="btn small" (click)="addButton('quick_reply')">
        <i class="ti ti-arrow-back-up" aria-hidden="true"></i> Quick-reply payload
      </button>
    </div>
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-sm);
    }
    .body {
      display: flex;
      gap: 8px;
      margin: 0;
      padding: 12px 14px;
      border-radius: var(--radius-md);
      background: var(--surface-sunken);
      box-shadow: inset 3px 0 0 var(--accent);
      color: var(--text-color);
      font-size: 13px;
      line-height: 1.55;
      white-space: pre-wrap;
    }
    .body .ti {
      flex: none;
      color: var(--accent);
      font-size: 17px;
    }
    .note {
      display: flex;
      gap: 6px;
      align-items: center;
      margin: 0;
      font-size: 12.5px;
      color: var(--text-muted);
    }
    .row {
      display: grid;
      grid-template-columns: minmax(64px, auto) 1fr 1fr;
      align-items: center;
      gap: var(--space-sm);
      padding: 8px 10px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--surface-card);
      animation: mp-in 320ms var(--ease) both;
      animation-delay: calc(var(--i, 0) * 35ms);
      transition:
        border-color var(--fast) var(--ease),
        box-shadow var(--fast) var(--ease);
    }
    .row:hover {
      border-color: var(--border-hover);
    }
    .row:focus-within {
      border-color: var(--primary);
      box-shadow: 0 0 0 3px var(--input-focus);
    }
    .btn-row {
      grid-template-columns: minmax(64px, auto) 1fr 1fr auto;
    }
    .tag {
      justify-self: start;
      padding: 3px 9px;
      border-radius: 999px;
      white-space: nowrap;
      font: 500 12px var(--mono);
      background: var(--accent-soft);
      color: var(--accent);
    }
    select,
    input {
      padding: 8px 12px;
    }
    .x {
      display: grid;
      place-items: center;
      width: 30px;
      height: 30px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--text-muted);
      transition:
        background var(--fast) var(--ease),
        color var(--fast) var(--ease);
    }
    .x:hover {
      background: var(--danger-soft);
      color: var(--danger-text);
    }
    .add {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-sm);
    }
    .btn.small {
      min-height: 32px;
      padding: 0 11px;
      font-size: 12.5px;
    }
    .sr {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
    }
    @keyframes mp-in {
      from {
        opacity: 0;
        transform: perspective(600px) rotateY(-8deg) translateX(-6px);
      }
    }
    @media (max-width: 640px) {
      .row,
      .btn-row {
        grid-template-columns: 1fr 1fr;
      }
      .tag {
        grid-column: 1 / -1;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .row {
        animation: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MetaParams {
  readonly template = input.required<Template>();
  readonly variables = input<string[]>([]);
  readonly mapping = model<MetaMapping>({ body: [] });

  protected readonly uid = `mp${++seq}`;
  /** As many rows as the approved body has {{n}}; else whatever the stored mapping lists. */
  protected readonly slots = computed(() => {
    const count = slotCount(this.template().body) || (this.mapping().body?.length ?? 0);
    return Array.from({ length: count }, (_, i) => i + 1);
  });

  protected brace(n: number | string): string {
    return `{{${n}}}`;
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement | HTMLSelectElement).value;
  }

  protected slot(n: number): MetaSlot {
    return this.mapping().body?.[n - 1] ?? {};
  }

  protected setSlot(n: number, key: keyof MetaSlot, value: string): void {
    this.mapping.update((m) => {
      const body = Array.from(
        { length: Math.max(n, m.body?.length ?? 0) },
        (_, i) => m.body?.[i] ?? {},
      );
      body[n - 1] = { ...body[n - 1], [key]: value.trim() };
      return { ...m, body };
    });
  }

  protected setHeader(key: 'var' | 'fallback', value: string): void {
    this.mapping.update((m) =>
      m.header ? { ...m, header: { ...m.header, [key]: value.trim() } } : m,
    );
  }

  protected addButton(subType: 'url' | 'quick_reply'): void {
    this.mapping.update((m) => {
      const buttons = m.buttons ?? [];
      const index = buttons.length ? Math.max(...buttons.map((b) => b.index)) + 1 : 0;
      return { ...m, buttons: [...buttons, { index, subType, var: '', fallback: '' }] };
    });
  }

  protected setButton(i: number, key: keyof MetaButton, value: string): void {
    this.mapping.update((m) => ({
      ...m,
      buttons: (m.buttons ?? []).map((b, j) => (j === i ? { ...b, [key]: value.trim() } : b)),
    }));
  }

  protected removeButton(i: number): void {
    this.mapping.update((m) => ({ ...m, buttons: (m.buttons ?? []).filter((_, j) => j !== i) }));
  }
}
