import { Component, computed, input, output, signal } from '@angular/core';

import { ArSwitch } from './ar-fields';
import { AutoReplyRule, ago } from './auto-replies.api';
import { MATCH_TYPES } from './rule-editor';

/** Priority-ordered rules: search, toggle, drag-and-drop or arrow-key reorder. */
@Component({
  selector: 'ar-rule-list',
  imports: [ArSwitch],
  templateUrl: './rule-list.html',
  styleUrl: './rule-list.scss',
})
export class RuleList {
  readonly rules = input<AutoReplyRule[]>([]);
  readonly selectedId = input<number | null>(null);
  readonly creating = input(false);
  readonly select = output<AutoReplyRule>();
  readonly create = output<void>();
  readonly toggle = output<{ rule: AutoReplyRule; active: boolean }>();
  readonly reorder = output<number[]>();

  protected readonly query = signal('');
  protected readonly dragId = signal<number | null>(null);
  protected readonly overId = signal<number | null>(null);
  protected readonly ago = ago;

  protected readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.rules();
    return this.rules().filter((r) =>
      r.name.toLowerCase().includes(q) || r.keywords.some((k) => k.toLowerCase().includes(q)) || r.variants.some((v) => v.toLowerCase().includes(q)));
  });

  protected label(r: AutoReplyRule): string {
    return MATCH_TYPES.find((m) => m.value === r.matchType)?.label ?? r.matchType;
  }

  protected icon(r: AutoReplyRule): string {
    return MATCH_TYPES.find((m) => m.value === r.matchType)?.icon ?? 'rule';
  }

  /** Move by `delta` places in the full (unfiltered) priority order. */
  protected move(r: AutoReplyRule, delta: number, focusAfter?: HTMLElement): void {
    const ids = this.rules().map((x) => x.id);
    const from = ids.indexOf(r.id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    this.reorder.emit(ids);
    if (focusAfter) queueMicrotask(() => focusAfter.focus());
  }

  protected key(e: KeyboardEvent, r: AutoReplyRule): void {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    this.move(r, e.key === 'ArrowUp' ? -1 : 1, e.currentTarget as HTMLElement);
  }

  // Native HTML5 drag and drop ------------------------------------------------
  protected dragStart(e: DragEvent, r: AutoReplyRule): void {
    this.dragId.set(r.id);
    e.dataTransfer?.setData('text/plain', String(r.id));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  protected dragOver(e: DragEvent, r: AutoReplyRule): void {
    if (this.dragId() === null) return;
    e.preventDefault();
    this.overId.set(r.id);
  }

  protected drop(e: DragEvent, target: AutoReplyRule): void {
    e.preventDefault();
    const id = this.dragId();
    this.dragEnd();
    if (id === null || id === target.id) return;
    const ids = this.rules().map((x) => x.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(target.id) + (this.rules().findIndex((x) => x.id === id) < this.rules().findIndex((x) => x.id === target.id) ? 1 : 0), 0, id);
    this.reorder.emit(ids);
  }

  protected dragEnd(): void {
    this.dragId.set(null);
    this.overId.set(null);
  }
}
