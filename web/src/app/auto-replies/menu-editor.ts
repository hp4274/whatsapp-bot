import { Component, computed, input, model } from '@angular/core';

import { InteractiveEditor } from '../campaign/interactive/interactive-editor';
import { interactiveOptions } from '../campaign/interactive/interactive.model';
import { ArMedia, ArSwitch, ArVariants } from './ar-fields';
import { Interactive, MenuNode } from './auto-replies.api';

/** Follow-up nesting allowed below the rule's own menu (rule menu = depth 1). */
export const MAX_MENU_DEPTH = 2;

export function nodeTexts(n: MenuNode | undefined): string[] {
  if (n?.variants?.length) return n.variants;
  return [n?.replyBody ?? ''];
}

/** Follow-up replies keyed by interactive option id; recursive one level deep. */
@Component({
  selector: 'ar-menu-editor',
  imports: [ArVariants, ArMedia, ArSwitch, InteractiveEditor],
  templateUrl: './menu-editor.html',
  styleUrl: './menu-editor.scss',
})
export class MenuEditor {
  readonly interactive = input<Interactive | null>(null);
  readonly depth = input(1);
  readonly variables = input<string[]>([]);
  readonly value = model<Record<string, MenuNode>>({});

  protected readonly options = computed(() => interactiveOptions(this.interactive()));
  protected readonly canNest = computed(() => this.depth() < MAX_MENU_DEPTH);
  protected readonly texts = nodeTexts;

  protected node(id: string): MenuNode | undefined {
    return this.value()[id];
  }

  protected patch(id: string, p: Partial<MenuNode>): void {
    const current = this.value()[id] ?? { replyBody: '' };
    this.value.set({ ...this.value(), [id]: { ...current, ...p } });
  }

  protected setTexts(id: string, list: string[]): void {
    this.patch(id, { replyBody: list[0] ?? '', variants: list });
  }

  protected setAction(id: string, p: { addTag?: string; escalate?: boolean }): void {
    this.patch(id, { actions: { ...(this.node(id)?.actions ?? {}), ...p } });
  }

  protected clear(id: string): void {
    const next = { ...this.value() };
    delete next[id];
    this.value.set(next);
  }

  protected tagOf(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }
}
