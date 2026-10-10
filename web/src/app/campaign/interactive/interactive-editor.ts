import { Component, computed, input, model } from '@angular/core';

import {
  InteractiveButton,
  InteractiveCta,
  InteractiveDraft,
  InteractiveRow,
  InteractiveSection,
  InteractiveType,
  LIMITS,
  slugId,
  validateInteractive,
} from './interactive.model';

type Choice = InteractiveType | 'none';

let seq = 0;

const TYPES: { value: Choice; label: string; icon: string }[] = [
  { value: 'none', label: 'None', icon: 'block' },
  { value: 'buttons', label: 'Reply buttons', icon: 'smart_button' },
  { value: 'cta', label: 'Call-to-action', icon: 'open_in_new' },
  { value: 'list', label: 'List menu', icon: 'list' },
];

const CTA_HINTS: Record<InteractiveCta['kind'], { label: string; placeholder: string }> = {
  url: { label: 'Link', placeholder: 'https://shop.com/track/{order_id}' },
  call: { label: 'Phone number', placeholder: '+919876543210' },
  copy: { label: 'Code', placeholder: 'SAVE20' },
};

/** Keep an id the user (or saved data) set; re-derive it from the title while it is still the auto one. */
function nextId(old: { id: string; title: string }, title: string, i: number, taken: string[]): string {
  const auto = slugId(old.title, i);
  const wasAuto = !old.id || old.id === auto || old.id.replace(/_\d+$/, '') === auto;
  if (!wasAuto) return old.id;
  const base = slugId(title, i);
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
}

function uniqueId(base: string, taken: string[]): string {
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`;
  return id;
}

@Component({
  selector: 'app-interactive-editor',
  templateUrl: './interactive-editor.html',
  styleUrl: './interactive-editor.scss',
})
export class InteractiveEditor {
  readonly value = model<InteractiveDraft | null>(null);
  readonly variables = input<string[]>([]);

  /** Prefix for element ids so label[for] stays unique across instances. */
  protected readonly uid = `ie${++seq}`;
  protected readonly types = TYPES;
  protected readonly limits = LIMITS;
  protected readonly ctaHints = CTA_HINTS;
  protected readonly type = computed<Choice>(() => this.value()?.type ?? 'none');
  protected readonly errors = computed(() => validateInteractive(this.value()));
  protected readonly rowCount = computed(() =>
    (this.value()?.list?.sections ?? []).reduce((n, s) => n + s.rows.length, 0));

  protected len(v: string | undefined): number {
    return String(v ?? '').trim().length;
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected setType(type: Choice): void {
    const current = this.value();
    if (type === this.type()) return;
    if (type === 'none') {
      this.value.set(null);
      return;
    }
    const base = { type, header: current?.header, footer: current?.footer };
    if (type === 'buttons') {
      this.value.set({ ...base, buttons: [{ id: 'YES', title: 'Yes' }, { id: 'NO', title: 'No' }] });
    } else if (type === 'cta') {
      this.value.set({ ...base, cta: [{ kind: 'url', title: 'Track order', value: '' }] });
    } else {
      this.value.set({
        ...base,
        list: { button: 'View options', sections: [{ title: 'Options', rows: [{ id: 'OPTION_1', title: 'Option 1' }] }] },
      });
    }
  }

  protected patch(partial: Partial<InteractiveDraft>): void {
    const current = this.value();
    if (current) this.value.set({ ...current, ...partial });
  }

  // Reply buttons ---------------------------------------------------------
  protected buttons(): InteractiveButton[] {
    return this.value()?.buttons ?? [];
  }

  protected updateButton(i: number, change: Partial<InteractiveButton>): void {
    const buttons = this.buttons().map((b, j) => {
      if (j !== i) return b;
      const next = { ...b, ...change };
      if (change.title !== undefined) {
        next.id = nextId(b, change.title, i, this.buttons().filter((_, k) => k !== i).map((o) => o.id));
      }
      return next;
    });
    this.patch({ buttons });
  }

  protected addButton(): void {
    const buttons = this.buttons();
    if (buttons.length >= LIMITS.buttons) return;
    const title = `Option ${buttons.length + 1}`;
    this.patch({ buttons: [...buttons, { id: uniqueId(slugId(title, buttons.length), buttons.map((b) => b.id)), title }] });
  }

  protected removeButton(i: number): void {
    this.patch({ buttons: this.buttons().filter((_, j) => j !== i) });
  }

  // Call-to-action --------------------------------------------------------
  protected ctas(): InteractiveCta[] {
    return this.value()?.cta ?? [];
  }

  protected updateCta(i: number, change: Partial<InteractiveCta>): void {
    this.patch({ cta: this.ctas().map((c, j) => (j === i ? { ...c, ...change } : c)) });
  }

  protected addCta(): void {
    const cta = this.ctas();
    if (cta.length >= LIMITS.cta) return;
    this.patch({ cta: [...cta, { kind: 'call', title: 'Call us', value: '' }] });
  }

  protected removeCta(i: number): void {
    this.patch({ cta: this.ctas().filter((_, j) => j !== i) });
  }

  // List menu -------------------------------------------------------------
  protected sections(): InteractiveSection[] {
    return this.value()?.list?.sections ?? [];
  }

  private setSections(sections: InteractiveSection[]): void {
    this.patch({ list: { button: this.value()?.list?.button ?? '', sections } });
  }

  private rowIds(except?: InteractiveRow): string[] {
    return this.sections().flatMap((s) => s.rows).filter((r) => r !== except).map((r) => r.id);
  }

  protected setListButton(button: string): void {
    this.patch({ list: { button, sections: this.sections() } });
  }

  protected updateSection(si: number, title: string): void {
    this.setSections(this.sections().map((s, j) => (j === si ? { ...s, title } : s)));
  }

  protected addSection(): void {
    if (this.rowCount() >= LIMITS.rows) return;
    const title = `Option ${this.rowCount() + 1}`;
    const row = { id: uniqueId(slugId(title, this.rowCount()), this.rowIds()), title };
    this.setSections([...this.sections(), { title: `Section ${this.sections().length + 1}`, rows: [row] }]);
  }

  protected removeSection(si: number): void {
    this.setSections(this.sections().filter((_, j) => j !== si));
  }

  protected updateRow(si: number, ri: number, change: Partial<InteractiveRow>): void {
    this.setSections(this.sections().map((s, j) => j !== si ? s : {
      ...s,
      rows: s.rows.map((r, k) => {
        if (k !== ri) return r;
        const next = { ...r, ...change };
        if (change.title !== undefined) next.id = nextId(r, change.title, k, this.rowIds(r));
        return next;
      }),
    }));
  }

  protected addRow(si: number): void {
    if (this.rowCount() >= LIMITS.rows) return;
    const title = `Option ${this.rowCount() + 1}`;
    const row = { id: uniqueId(slugId(title, this.rowCount()), this.rowIds()), title };
    this.setSections(this.sections().map((s, j) => (j === si ? { ...s, rows: [...s.rows, row] } : s)));
  }

  protected removeRow(si: number, ri: number): void {
    this.setSections(this.sections().map((s, j) => (j === si ? { ...s, rows: s.rows.filter((_, k) => k !== ri) } : s)));
  }

  // A native select is the "insert variable" menu: append {var}, then reset it.
  private pick(select: HTMLSelectElement): string {
    const name = select.value;
    select.value = '';
    return name ? `{${name}}` : '';
  }

  protected insertButtonVar(select: HTMLSelectElement, i: number): void {
    const token = this.pick(select);
    if (token) this.updateButton(i, { payload: (this.buttons()[i].payload ?? '') + token });
  }

  protected insertCtaVar(select: HTMLSelectElement, i: number): void {
    const token = this.pick(select);
    if (token) this.updateCta(i, { value: this.ctas()[i].value + token });
  }

  protected insertRowVar(select: HTMLSelectElement, si: number, ri: number): void {
    const token = this.pick(select);
    if (token) this.updateRow(si, ri, { payload: (this.sections()[si].rows[ri].payload ?? '') + token });
  }
}
