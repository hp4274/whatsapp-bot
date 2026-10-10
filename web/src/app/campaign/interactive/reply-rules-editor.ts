import { Component, computed, input, model } from '@angular/core';

import {
  InteractiveDraft,
  ReplyRule,
  ReplyRuleAction,
  ReplyRuleActionType,
  interactiveOptions,
} from './interactive.model';

let seq = 0;

const ACTIONS: { type: ReplyRuleActionType; label: string; icon: string }[] = [
  { type: 'send_message', label: 'Send follow-up message', icon: 'chat' },
  { type: 'add_tag', label: 'Add tag', icon: 'sell' },
  { type: 'remove_tag', label: 'Remove tag', icon: 'label_off' },
  { type: 'set_field', label: 'Set contact field', icon: 'edit_note' },
  { type: 'mute_days', label: 'Mute bulk campaigns', icon: 'notifications_off' },
  { type: 'opt_out', label: 'Opt-out contact', icon: 'block' },
  { type: 'escalate', label: 'Escalate to inbox', icon: 'support_agent' },
];

const DEFAULTS: Record<ReplyRuleActionType, ReplyRuleAction> = {
  send_message: { type: 'send_message', text: '' },
  add_tag: { type: 'add_tag', tags: [] },
  remove_tag: { type: 'remove_tag', tags: [] },
  set_field: { type: 'set_field', key: '', value: '' },
  mute_days: { type: 'mute_days', days: 30 },
  opt_out: { type: 'opt_out' },
  escalate: { type: 'escalate', ticket: false },
};

interface OptionCard {
  id: string;
  title: string;
  actions: ReplyRuleAction[];
}

@Component({
  selector: 'app-reply-rules-editor',
  templateUrl: './reply-rules-editor.html',
  styleUrl: './reply-rules-editor.scss',
})
export class ReplyRulesEditor {
  readonly interactive = input<InteractiveDraft | null>(null);
  readonly variables = input<string[]>([]);
  readonly rules = model<ReplyRule[]>([]);

  protected readonly uid = `rr${++seq}`;
  protected readonly actionTypes = ACTIONS;
  protected readonly chips = computed(() => [...new Set(['name', 'option', ...this.variables()])]);

  protected readonly cards = computed<OptionCard[]>(() => {
    const options = interactiveOptions(this.interactive());
    if (!options.length) return [];
    const rules = this.rules();
    const actionsFor = (id: string) => rules.find((r) => r.optionId === id)?.actions ?? [];
    return [
      ...options.map((o) => ({ id: o.id, title: o.title || o.id, actions: actionsFor(o.id) })),
      { id: 'any', title: 'Any reply to this message', actions: actionsFor('any') },
    ];
  });

  protected label(type: ReplyRuleActionType): string {
    return ACTIONS.find((a) => a.type === type)?.label ?? type;
  }

  protected icon(type: ReplyRuleActionType): string {
    return ACTIONS.find((a) => a.type === type)?.icon ?? 'bolt';
  }

  protected text(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected tags(event: Event): string[] {
    return this.text(event).split(',').map((t) => t.trim()).filter(Boolean);
  }

  /** Rebuild the rules from the visible cards; empty rules and options that no longer exist drop out. */
  private setActions(optionId: string, actions: ReplyRuleAction[]): void {
    this.rules.set(this.cards()
      .map((c) => ({ optionId: c.id, actions: c.id === optionId ? actions : c.actions }))
      .filter((r) => r.actions.length));
  }

  protected addAction(select: HTMLSelectElement, card: OptionCard): void {
    const type = select.value as ReplyRuleActionType;
    select.value = '';
    if (type) this.setActions(card.id, [...card.actions, { ...DEFAULTS[type] }]);
  }

  protected updateAction(card: OptionCard, i: number, change: Record<string, unknown>): void {
    this.setActions(card.id, card.actions.map((a, j) => (j === i ? { ...a, ...change } as ReplyRuleAction : a)));
  }

  protected removeAction(card: OptionCard, i: number): void {
    this.setActions(card.id, card.actions.filter((_, j) => j !== i));
  }

  protected insertVar(card: OptionCard, i: number, current: string, name: string): void {
    this.updateAction(card, i, { text: `${current}{${name}}` });
  }

  protected days(event: Event): number {
    const n = Math.round(Number(this.text(event)));
    return Math.min(365, Math.max(1, Number.isFinite(n) ? n : 1));
  }
}
