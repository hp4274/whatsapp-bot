import { Component, ElementRef, inject, input, model, signal, viewChild } from '@angular/core';

import { ArToasts, AutoRepliesApi, Media, VARIABLES } from './auto-replies.api';

let seq = 0;

/* Labelled switch -------------------------------------------------------- */

@Component({
  selector: 'ar-switch',
  template: `
    <label class="sw" [class.compact]="!label()">
      <input type="checkbox" role="switch" [checked]="checked()" [disabled]="disabled()"
             [attr.aria-label]="label() ? null : ariaLabel()" (change)="checked.set(!checked())" />
      <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      @if (label()) { <span>{{ label() }}</span> }
    </label>`,
  styles: `
    :host { display: inline-flex; }
    .sw { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; cursor: pointer; user-select: none; }
    input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .track { position: relative; width: 38px; height: 22px; border-radius: 999px; background: var(--border); transition: background var(--fast) var(--ease); box-shadow: inset 0 1px 2px rgba(0,0,0,.12); }
    .thumb { position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--surface); box-shadow: 0 1px 3px rgba(0,0,0,.3); transition: transform var(--base) var(--ease); }
    input:checked + .track { background: var(--primary); }
    input:checked + .track .thumb { transform: translateX(16px); }
    input:focus-visible + .track { outline: 2px solid var(--accent); outline-offset: 2px; }
    input:disabled + .track { opacity: .5; }
  `,
})
export class ArSwitch {
  readonly checked = model(false);
  readonly label = input('');
  readonly ariaLabel = input('Enabled');
  readonly disabled = input(false);
}

/* Chip input: Enter or comma adds, Backspace on empty removes the last ---- */

@Component({
  selector: 'ar-chips',
  template: `
    <div class="box" (click)="box.focus()">
      @for (c of value(); track c; let i = $index) {
        <span class="chip">{{ c }}
          <button type="button" [attr.aria-label]="'Remove ' + c" (click)="remove(i); $event.stopPropagation()">
            <span class="ms" aria-hidden="true">close</span>
          </button>
        </span>
      }
      <input #box [id]="inputId()" [type]="type()" [placeholder]="value().length ? '' : placeholder()"
             [attr.aria-label]="inputId() ? null : placeholder()"
             (keydown)="key($event, box)" (blur)="commit(box)" (change)="type() === 'date' && commit(box)" />
    </div>`,
  styles: `
    .box { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 42px; padding: 6px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-alt); cursor: text; transition: border-color var(--fast) var(--ease), box-shadow var(--fast) var(--ease); }
    .box:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
    input { flex: 1; min-width: 120px; border: 0; padding: 4px; background: transparent; box-shadow: none !important; }
    .chip { display: inline-flex; align-items: center; gap: 2px; padding: 3px 4px 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; color: var(--primary); background: var(--primary-soft); border: 1px solid color-mix(in srgb, var(--primary) 25%, transparent); animation: fade-in-up var(--fast) var(--ease) both; }
    .chip button { display: grid; place-items: center; width: 20px; height: 20px; border: 0; border-radius: 50%; background: transparent; color: inherit; }
    .chip button:hover { background: color-mix(in srgb, var(--primary) 18%, transparent); }
    .chip .ms { font-size: 14px; }
  `,
})
export class ArChips {
  readonly value = model<string[]>([]);
  readonly placeholder = input('Type and press Enter');
  readonly inputId = input<string | null>(null);
  readonly type = input<'text' | 'date'>('text');

  protected key(e: KeyboardEvent, box: HTMLInputElement): void {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      this.commit(box);
    } else if (e.key === 'Backspace' && !box.value && this.value().length) {
      this.remove(this.value().length - 1);
    }
  }

  protected commit(box: HTMLInputElement): void {
    const parts = box.value.split(',').map((s) => s.trim()).filter(Boolean);
    box.value = '';
    const next = [...this.value()];
    for (const p of parts) if (!next.some((v) => v.toLowerCase() === p.toLowerCase())) next.push(p);
    if (next.length !== this.value().length) this.value.set(next);
  }

  protected remove(i: number): void {
    this.value.set(this.value().filter((_, j) => j !== i));
  }
}

/* Media attach: upload, then show a file chip ---------------------------- */

@Component({
  selector: 'ar-media',
  template: `
    @if (value(); as m) {
      <div class="file">
        @if (isImage(m) && m.url) { <img [src]="m.url" alt="" /> }
        @else { <span class="ms icon" aria-hidden="true">{{ icon(m) }}</span> }
        <span class="name">{{ m.filename || m.mediaId }}<small>{{ m.mimetype || 'file' }}</small></span>
        <button type="button" class="x" aria-label="Remove attachment" (click)="value.set(null)"><span class="ms" aria-hidden="true">delete</span></button>
      </div>
    } @else {
      <label class="pick" [class.busy]="busy()">
        <input type="file" (change)="pick($event)" [disabled]="busy()" accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt" />
        @if (busy()) { <span class="spinner" aria-hidden="true"></span> Uploading… }
        @else { <span class="ms" aria-hidden="true">attach_file</span> Attach media }
      </label>
    }`,
  styles: `
    :host { display: block; }
    .pick { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; border-radius: var(--radius-sm); border: 1px dashed var(--border); color: var(--text-muted); font-size: 12px; font-weight: 600; cursor: pointer; transition: border-color var(--fast) var(--ease), color var(--fast) var(--ease), background var(--fast) var(--ease); }
    .pick:hover, .pick:focus-within { border-color: var(--accent); color: var(--accent); background: var(--accent-soft); }
    .pick:focus-within { outline: 2px solid var(--accent); outline-offset: 2px; }
    .pick.busy { cursor: progress; }
    input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .file { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--surface-alt); max-width: 360px; animation: fade-in-up var(--base) var(--ease) both; }
    img, .icon { width: 40px; height: 40px; border-radius: 6px; object-fit: cover; flex: none; }
    .icon { display: grid; place-items: center; font-size: 22px; color: var(--accent); background: var(--accent-soft); }
    .name { flex: 1; min-width: 0; display: grid; font-size: 12px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    small { font-weight: 400; color: var(--text-muted); }
    .x { border: 0; background: transparent; color: var(--text-muted); border-radius: 6px; padding: 6px; }
    .x:hover { color: var(--danger); background: var(--danger-soft); }
  `,
})
export class ArMedia {
  private readonly api = inject(AutoRepliesApi);
  private readonly toasts = inject(ArToasts);
  readonly value = model<Media | null>(null);
  protected readonly busy = signal(false);

  protected isImage(m: Media): boolean {
    return (m.mimetype ?? '').startsWith('image/');
  }

  protected icon(m: Media): string {
    const t = m.mimetype ?? '';
    return t.startsWith('video/') ? 'movie' : t.startsWith('audio/') ? 'graphic_eq' : t.includes('pdf') ? 'picture_as_pdf' : 'description';
  }

  protected pick(e: Event): void {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.busy.set(true);
    this.api.upload(file).subscribe({
      next: (m) => { this.value.set({ mediaId: m.mediaId, filename: m.filename, mimetype: m.mimetype, url: m.url }); this.busy.set(false); },
      error: (err) => { this.toasts.error(err); this.busy.set(false); },
    });
  }
}

/* Message textarea with variable chips that insert at the caret ---------- */

@Component({
  selector: 'ar-text',
  template: `
    <textarea #area [id]="id" [rows]="rows()" [value]="value()" [placeholder]="placeholder()"
              [attr.aria-label]="ariaLabel()" (input)="value.set(area.value)"></textarea>
    <div class="vars" role="group" aria-label="Insert variable">
      @for (v of vars; track v) {
        <button type="button" (click)="insert('{' + v + '}')">{{ '{' + v + '}' }}</button>
      }
      <button type="button" class="custom" title="Custom contact field, e.g. {city}" (click)="insert('{field}', 'field')">+ {{ '{field}' }}</button>
      <span class="hint">Use <code>{{ '{var|fallback}' }}</code> when a value may be empty</span>
    </div>`,
  styles: `
    :host { display: grid; gap: 6px; }
    textarea { resize: vertical; min-height: 64px; line-height: 1.45; }
    .vars { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
    button { border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); border-radius: 999px; padding: 2px 9px; font: 600 11px var(--mono); transition: color var(--fast) var(--ease), border-color var(--fast) var(--ease), transform var(--fast) var(--ease); }
    button:hover { color: var(--accent); border-color: var(--accent); transform: translateY(-1px); }
    .custom { border-style: dashed; }
    .hint { font-size: 11px; color: var(--text-muted); margin-left: 4px; }
    code { font-family: var(--mono); color: var(--text); }
  `,
})
export class ArText {
  readonly value = model('');
  readonly rows = input(3);
  readonly placeholder = input('');
  readonly ariaLabel = input<string | null>(null);
  readonly inputId = input<string | null>(null);
  protected readonly vars = VARIABLES;
  protected readonly area = viewChild.required<ElementRef<HTMLTextAreaElement>>('area');
  private readonly ownId = `art${++seq}`;

  get id(): string {
    return this.inputId() ?? this.ownId;
  }

  /** Insert at the caret; when `select` is given, highlight that word so the user can type over it. */
  protected insert(token: string, select?: string): void {
    const el = this.area().nativeElement;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    const next = el.value.slice(0, start) + token + el.value.slice(end);
    this.value.set(next);
    el.value = next;
    el.focus();
    const from = select ? start + token.indexOf(select) : start + token.length;
    el.setSelectionRange(from, select ? from + select.length : from);
  }
}

/* Reply variants: one is picked at random -------------------------------- */

@Component({
  selector: 'ar-variants',
  imports: [ArText],
  template: `
    @for (t of value(); track $index; let i = $index) {
      <div class="row enter">
        <span class="n" aria-hidden="true">{{ i + 1 }}</span>
        <ar-text [rows]="i ? 2 : 3" [value]="t" (valueChange)="set(i, $event)"
                 [ariaLabel]="'Reply variant ' + (i + 1)" [placeholder]="i ? 'Another way to say it' : placeholder()" />
        @if (value().length > 1) {
          <button type="button" class="rm" [attr.aria-label]="'Remove variant ' + (i + 1)" (click)="remove(i)"><span class="ms" aria-hidden="true">close</span></button>
        }
      </div>
    }
    <div class="foot">
      <button type="button" class="add" (click)="value.set([...value(), ''])"><span class="ms" aria-hidden="true">add</span> Add variant</button>
      @if (value().length > 1) { <span class="hint"><span class="ms" aria-hidden="true">shuffle</span> One is picked at random each time</span> }
    </div>`,
  styles: `
    :host { display: grid; gap: var(--space-sm); }
    .row { display: grid; grid-template-columns: 22px 1fr auto; gap: 8px; align-items: start; }
    .n { display: grid; place-items: center; width: 22px; height: 22px; margin-top: 9px; border-radius: 50%; font-size: 11px; font-weight: 700; color: var(--accent); background: var(--accent-soft); }
    .rm { margin-top: 6px; border: 0; background: transparent; color: var(--text-muted); border-radius: 6px; padding: 4px; }
    .rm:hover { color: var(--danger); background: var(--danger-soft); }
    .foot { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding-left: 30px; }
    .add { display: inline-flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--accent); font-weight: 600; font-size: 12px; padding: 4px 6px; border-radius: 6px; }
    .add:hover { background: var(--accent-soft); }
    .hint { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-muted); }
    .hint .ms { font-size: 14px; }
  `,
})
export class ArVariants {
  readonly value = model<string[]>(['']);
  readonly placeholder = input('Reply text');

  protected set(i: number, text: string): void {
    this.value.set(this.value().map((t, j) => (j === i ? text : t)));
  }

  protected remove(i: number): void {
    this.value.set(this.value().filter((_, j) => j !== i));
  }
}
