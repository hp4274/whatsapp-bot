import { ChangeDetectionStrategy, Component, computed, model } from '@angular/core';

import {
  InteractiveCta,
  InteractiveRow,
  LIMITS,
  slugId,
  validateInteractive,
} from '../campaign/interactive/interactive.model';
import { InteractiveDraft } from './templates-api';

/** What sits under the message; 'none' maps to a null value. */
type Choice = InteractiveDraft['type'] | 'none';

/** Segmented-control options for the kind of tappable block. */
const TYPES: readonly { value: Choice; label: string; icon: string }[] = [
  { value: 'none', label: 'None', icon: 'ban' },
  { value: 'buttons', label: 'Quick replies', icon: 'hand-click' },
  { value: 'cta', label: 'Call to action', icon: 'click' },
  { value: 'list', label: 'List menu', icon: 'list' },
];

/** Call-to-action kinds with an example value for each placeholder. */
const CTA_KINDS = [
  { value: 'url', label: 'Visit website', placeholder: 'https://shop.com/track/{order_id}' },
  { value: 'call', label: 'Call number', placeholder: '+919876543210' },
  { value: 'copy', label: 'Copy code', placeholder: 'SAVE20' },
] as const;

/** Move item i by d (-1 up, +1 down) in a copy of the list. */
function moved<T>(list: T[], i: number, d: number): T[] {
  const j = i + d;
  if (j < 0 || j >= list.length) return list;
  const copy = [...list];
  [copy[i], copy[j]] = [copy[j], copy[i]];
  return copy;
}

/** Keep a hand-set id; re-derive one that was still the slug of the old title. */
const retitle = <T extends { id: string; title: string }>(o: T, title: string, i: number): T => ({
  ...o,
  title,
  id: !o.id || o.id === slugId(o.title, i) ? slugId(title, i) : o.id,
});

/** Per-instance id counter. */
let seq = 0;

/** Editor for the interactive block of a template (server shape: messaging/interactive.js). */
@Component({
  selector: 'app-buttons-editor',
  templateUrl: './buttons-editor.html',
  styleUrl: './buttons-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ButtonsEditor {
  readonly value = model<InteractiveDraft | null>(null);

  protected readonly uid = `be${++seq}`;
  protected readonly types = TYPES;
  protected readonly kinds = CTA_KINDS;
  protected readonly limits = LIMITS;
  protected readonly type = computed<Choice>(() => this.value()?.type ?? 'none');
  protected readonly errors = computed(() => validateInteractive(this.value()));
  protected readonly rows = computed(
    () => this.value()?.list?.sections.flatMap((s) => s.rows) ?? [],
  );

  protected len(v: string | undefined): number {
    return String(v ?? '').trim().length;
  }

  protected setType(type: Choice): void {
    const cur = this.value();
    if (type === this.type()) return;
    if (type === 'none') {
      this.value.set(null);
      return;
    }
    const base = { type, header: cur?.header, footer: cur?.footer };
    if (type === 'buttons')
      this.value.set({
        ...base,
        buttons: [
          { id: 'YES', title: 'Yes' },
          { id: 'NO', title: 'No' },
        ],
      });
    else if (type === 'cta')
      this.value.set({ ...base, cta: [{ kind: 'url', title: 'Visit website', value: '' }] });
    else
      this.value.set({
        ...base,
        list: {
          button: 'View options',
          sections: [{ title: 'Options', rows: [{ id: 'OPTION_1', title: 'Option 1' }] }],
        },
      });
  }

  protected patch(change: Partial<InteractiveDraft>): void {
    const cur = this.value();
    if (cur) this.value.set({ ...cur, ...change });
  }

  // quick replies ---------------------------------------------------------
  protected setButton(i: number, title: string): void {
    this.patch({
      buttons: (this.value()?.buttons ?? []).map((b, j) => (j === i ? retitle(b, title, i) : b)),
    });
  }
  protected addButton(): void {
    const list = this.value()?.buttons ?? [];
    if (list.length < LIMITS.buttons) this.patch({ buttons: [...list, { id: '', title: '' }] });
  }
  protected removeButton(i: number): void {
    this.patch({ buttons: (this.value()?.buttons ?? []).filter((_, j) => j !== i) });
  }
  protected moveButton(i: number, d: number): void {
    this.patch({ buttons: moved(this.value()?.buttons ?? [], i, d) });
  }

  // call to action --------------------------------------------------------
  protected setCta(i: number, change: Partial<InteractiveCta>): void {
    this.patch({
      cta: (this.value()?.cta ?? []).map((c, j) => (j === i ? { ...c, ...change } : c)),
    });
  }
  protected addCta(): void {
    const list = this.value()?.cta ?? [];
    if (list.length < LIMITS.cta)
      this.patch({ cta: [...list, { kind: 'call', title: 'Call us', value: '' }] });
  }
  protected removeCta(i: number): void {
    this.patch({ cta: (this.value()?.cta ?? []).filter((_, j) => j !== i) });
  }
  protected moveCta(i: number, d: number): void {
    this.patch({ cta: moved(this.value()?.cta ?? [], i, d) });
  }

  // list menu: one section keeps the editor honest; the server accepts more. --
  private setRows(rows: InteractiveRow[]): void {
    const list = this.value()?.list;
    const title = list?.sections[0]?.title ?? 'Options';
    this.patch({ list: { button: list?.button ?? 'View options', sections: [{ title, rows }] } });
  }
  protected setListButton(button: string): void {
    const list = this.value()?.list;
    this.patch({ list: { button, sections: list?.sections ?? [] } });
  }
  protected setSectionTitle(title: string): void {
    const list = this.value()?.list;
    this.patch({ list: { button: list?.button ?? '', sections: [{ title, rows: this.rows() }] } });
  }
  protected setRow(i: number, change: { title?: string; description?: string }): void {
    this.setRows(
      this.rows().map((r, j) => {
        if (j !== i) return r;
        const next = change.title !== undefined ? retitle(r, change.title, i) : r;
        return {
          ...next,
          ...(change.description !== undefined ? { description: change.description } : {}),
        };
      }),
    );
  }
  protected addRow(): void {
    if (this.rows().length < LIMITS.rows) this.setRows([...this.rows(), { id: '', title: '' }]);
  }
  protected removeRow(i: number): void {
    this.setRows(this.rows().filter((_, j) => j !== i));
  }
  protected moveRow(i: number, d: number): void {
    this.setRows(moved(this.rows(), i, d));
  }

  protected val(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
}
