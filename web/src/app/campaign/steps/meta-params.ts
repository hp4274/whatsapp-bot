import { Component, computed, input, model } from '@angular/core';

import type { MetaButton, MetaMapping, MetaSlot } from '../../templates/meta-mapping';
import type { Template } from '../../templates/templates-api';
import { slotCount } from '../wa-format';

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
    <p class="body"><span class="ms" aria-hidden="true">format_quote</span>{{ template().body || 'No body text stored for this template.' }}</p>

    @if (m.header?.type === 'text') {
      <div class="row">
        <span class="tag">Header</span>
        <label class="sr" [for]="uid + '-hv'">Variable for the header</label>
        <select [id]="uid + '-hv'" (change)="setHeader('var', val($event))">
          <option value="" [selected]="!m.header?.var">Fixed text (fallback)</option>
          @for (v of variables(); track v) { <option [value]="v" [selected]="v === m.header?.var">{{ '{' + v + '}' }}</option> }
        </select>
        <label class="sr" [for]="uid + '-hf'">Header fallback</label>
        <input [id]="uid + '-hf'" placeholder="Fallback" [value]="m.header?.fallback ?? ''" (input)="setHeader('fallback', val($event))" />
      </div>
    } @else if (m.header?.type) {
      <p class="note"><span class="ms" aria-hidden="true">perm_media</span>
        This template has a {{ m.header?.type }} header - the campaign attachment below is sent as that header.</p>
    }

    @for (n of slots(); track n) {
      <div class="row" [style.--i]="n">
        <span class="tag">{{ brace(n) }}</span>
        <label class="sr" [for]="uid + '-v' + n">Variable for {{ brace(n) }}</label>
        <select [id]="uid + '-v' + n" (change)="setSlot(n, 'var', val($event))">
          <option value="" [selected]="!slot(n).var">Fixed text (fallback)</option>
          @for (v of variables(); track v) { <option [value]="v" [selected]="v === slot(n).var">{{ '{' + v + '}' }}</option> }
        </select>
        <label class="sr" [for]="uid + '-f' + n">Fallback for {{ brace(n) }}</label>
        <input [id]="uid + '-f' + n" placeholder="Fallback" [value]="slot(n).fallback ?? ''" (input)="setSlot(n, 'fallback', val($event))" />
      </div>
    } @empty {
      <p class="note">No {{ brace('n') }} slots - this template is sent as is.</p>
    }

    @for (b of m.buttons ?? []; track $index; let i = $index) {
      <div class="row btn-row">
        <span class="tag">Button {{ b.index }} · {{ b.subType === 'quick_reply' ? 'payload' : 'URL' }}</span>
        <label class="sr" [for]="uid + '-bv' + i">Variable for button {{ b.index }}</label>
        <select [id]="uid + '-bv' + i" (change)="setButton(i, 'var', val($event))">
          <option value="" [selected]="!b.var">Fixed text (fallback)</option>
          @for (v of variables(); track v) { <option [value]="v" [selected]="v === b.var">{{ '{' + v + '}' }}</option> }
        </select>
        <label class="sr" [for]="uid + '-bf' + i">Fallback for button {{ b.index }}</label>
        <input [id]="uid + '-bf' + i" placeholder="Fallback" [value]="b.fallback ?? ''" (input)="setButton(i, 'fallback', val($event))" />
        <button type="button" class="x" (click)="removeButton(i)" [attr.aria-label]="'Remove button ' + b.index + ' parameter'">
          <span class="ms" aria-hidden="true">close</span>
        </button>
      </div>
    }
    <div class="add">
      <button type="button" class="btn small" (click)="addButton('url')"><span class="ms" aria-hidden="true">add_link</span> URL button parameter</button>
      <button type="button" class="btn small" (click)="addButton('quick_reply')"><span class="ms" aria-hidden="true">reply</span> Quick-reply payload</button>
    </div>
  `,
  styles: `
    :host { display: grid; gap: var(--space-sm); perspective: 900px; }
    .body {
      display: flex; gap: 6px; margin: 0; padding: var(--space-sm) var(--space-md);
      border-left: 3px solid var(--accent); border-radius: var(--radius-sm); background: var(--surface-alt);
      font-size: 13px; line-height: 1.5; white-space: pre-wrap;
    }
    .body .ms { color: var(--accent); font-size: 18px; }
    .note { display: flex; gap: 6px; align-items: center; margin: 0; font-size: 12px; color: var(--text-muted); }
    .row {
      display: grid; grid-template-columns: minmax(64px, auto) 1fr 1fr; align-items: center; gap: var(--space-sm);
      padding: 6px var(--space-sm); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface);
      animation: mp-in 320ms var(--ease) both; animation-delay: calc(var(--i, 0) * 35ms);
      transition: transform var(--fast) var(--ease), box-shadow var(--fast) var(--ease);
    }
    .row:hover { transform: translateZ(6px) rotateX(2deg); box-shadow: var(--shadow); }
    .btn-row { grid-template-columns: minmax(64px, auto) 1fr 1fr auto; }
    .tag {
      justify-self: start; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
      font: 600 12px var(--mono); background: var(--accent-soft); color: var(--accent);
    }
    select, input { padding: 7px 10px; }
    .x { display: inline-flex; padding: 4px; border: 0; border-radius: 50%; background: transparent; color: var(--text-muted); }
    .x:hover { background: var(--danger-soft); color: var(--danger); }
    .x:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .add { display: flex; flex-wrap: wrap; gap: var(--space-sm); }
    .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    @keyframes mp-in { from { opacity: 0; transform: rotateY(-8deg) translateX(-6px); } }
    @media (max-width: 640px) { .row, .btn-row { grid-template-columns: 1fr 1fr; } .tag { grid-column: 1 / -1; } }
    @media (prefers-reduced-motion: reduce) { .row { animation: none; transition: none; } }
  `,
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
      const body = Array.from({ length: Math.max(n, m.body?.length ?? 0) }, (_, i) => m.body?.[i] ?? {});
      body[n - 1] = { ...body[n - 1], [key]: value.trim() };
      return { ...m, body };
    });
  }

  protected setHeader(key: 'var' | 'fallback', value: string): void {
    this.mapping.update((m) => (m.header ? { ...m, header: { ...m.header, [key]: value.trim() } } : m));
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
