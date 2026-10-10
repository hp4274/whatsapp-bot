import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  output,
  signal,
} from '@angular/core';

import { InteractiveEditor } from '../campaign/interactive/interactive-editor';
import { interactiveOptions, validateInteractive } from '../campaign/interactive/interactive.model';
import { ArChips, ArMedia, ArSwitch, ArVariants } from './ar-fields';
import {
  MatchType,
  MenuNode,
  RulePayload,
  RuleStats,
  VARIABLES,
  ago,
  renderTemplate,
} from './auto-replies.api';
import { MenuEditor, nodeTexts } from './menu-editor';
import { ScheduleEditor } from './schedule-editor';
import { PreviewTurn, WaPreview } from './wa-preview';

/** Editor state: the payload plus the row id, `null` while the rule is unsaved. */
export type RuleDraft = RulePayload & { id: number | null };

/** Match types in the order the picker shows them; the list and editor share it for labels and icons. */
export const MATCH_TYPES: readonly {
  value: MatchType;
  label: string;
  hint: string;
  icon: string;
}[] = [
  { value: 'CONTAINS', label: 'Contains', hint: 'Keyword appears anywhere', icon: 'list-search' },
  {
    value: 'EXACT',
    label: 'Exact',
    hint: 'Whole message equals a keyword',
    icon: 'grip-horizontal',
  },
  {
    value: 'STARTS_WITH',
    label: 'Starts with',
    hint: 'Message begins with a keyword',
    icon: 'player-track-next',
  },
  { value: 'ANY_OF', label: 'Any of', hint: 'Any keyword as a whole word', icon: 'arrows-join' },
  { value: 'FUZZY', label: 'Fuzzy', hint: 'Typo tolerant: “prise” finds “price”', icon: 'wand' },
  { value: 'REGEX', label: 'Regex', hint: 'JavaScript regular expression', icon: 'code' },
  { value: 'FALLBACK', label: 'Fallback', hint: 'When no other rule matched', icon: 'lifebuoy' },
];

/** A new rule that already says something sensible, so the preview is never blank. */
export function emptyDraft(): RuleDraft {
  return {
    id: null,
    name: '',
    matchType: 'CONTAINS',
    keyword: '',
    keywords: [],
    replyBody: '{time_greeting} {first_name|there}, thanks for messaging {business_name}!',
    variants: ['{time_greeting} {first_name|there}, thanks for messaging {business_name}!'],
    media: null,
    interactive: null,
    menu: {},
    schedule: null,
    audience: { type: 'all' },
    actions: { addTag: '', setField: null, escalate: false, stop: true },
    isActive: true,
  };
}

/** Drop follow-ups whose option no longer exists, recursively. */
function prune(
  menu: Record<string, MenuNode>,
  ix: RulePayload['interactive'],
): Record<string, MenuNode> {
  const ids = new Set(interactiveOptions(ix).map((o) => o.id));
  const out: Record<string, MenuNode> = {};
  for (const [id, n] of Object.entries(menu ?? {})) {
    if (!ids.has(id)) continue;
    out[id] = { ...n, menu: n.interactive ? prune(n.menu ?? {}, n.interactive) : {} };
  }
  return out;
}

/** Normalise the editor state into the API payload (legacy keyword/replyBody kept in step). */
export function toPayload(d: RuleDraft): RulePayload {
  const variants = d.variants.map((v) => v.trim()).filter(Boolean);
  const keywords = d.matchType === 'FALLBACK' ? [] : d.keywords;
  const setField = d.actions.setField?.key?.trim() ? d.actions.setField : null;
  return {
    name:
      d.name.trim() || keywords[0] || (d.matchType === 'FALLBACK' ? 'Fallback' : 'Untitled rule'),
    matchType: d.matchType,
    keyword: keywords[0] ?? '',
    keywords,
    replyBody: variants[0] ?? '',
    variants,
    media: d.media,
    interactive: d.interactive,
    menu: prune(d.menu, d.interactive),
    schedule: d.schedule,
    audience:
      d.audience.type === 'tag'
        ? { type: 'tag', tag: (d.audience.tag ?? '').trim() }
        : { type: d.audience.type },
    actions: {
      addTag: d.actions.addTag?.trim() ?? '',
      setField,
      escalate: !!d.actions.escalate,
      stop: d.actions.stop,
    },
    isActive: d.isActive,
  };
}

/**
 * One keyword rule as five numbered steps (trigger, reply, buttons, when/who,
 * actions) beside a live WhatsApp preview.
 *
 * Problems are computed continuously but only shown after the first save
 * attempt, so a fresh rule is not covered in red before the user has typed.
 */
@Component({
  selector: 'ar-rule-editor',
  imports: [
    ArChips,
    ArMedia,
    ArSwitch,
    ArVariants,
    InteractiveEditor,
    MenuEditor,
    ScheduleEditor,
    WaPreview,
  ],
  templateUrl: './rule-editor.html',
  styleUrl: './rule-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RuleEditor {
  readonly value = model.required<RuleDraft>();
  readonly stats = input<RuleStats | null>(null);
  readonly businessName = input('Your business');
  readonly saving = input(false);
  readonly dirty = input(false);
  readonly save = output<void>();
  readonly remove = output<void>();
  readonly cancel = output<void>();

  protected readonly matchTypes = MATCH_TYPES;
  protected readonly variables = VARIABLES;
  protected readonly ago = ago;
  protected readonly confirmDelete = signal(false);
  protected readonly fallbackView = signal(false);
  /** Option id whose follow-up the preview shows; empty for the main reply. */
  protected readonly previewPath = signal('');
  /** Set on the first save attempt; gates the problems list. */
  protected readonly attempted = signal(false);

  protected readonly options = computed(() => interactiveOptions(this.value().interactive));
  protected readonly hint = computed(
    () => MATCH_TYPES.find((m) => m.value === this.value().matchType)?.hint ?? '',
  );

  protected readonly problems = computed(() => {
    const d = this.value();
    const out: string[] = [];
    if (d.matchType !== 'FALLBACK' && !d.keywords.length) out.push('Add at least one keyword.');
    if (!d.variants.some((v) => v.trim()) && !d.media && !d.interactive)
      out.push('Write a reply, attach media or add buttons.');
    if (d.audience.type === 'tag' && !d.audience.tag?.trim())
      out.push('Pick the tag this rule is for.');
    if (d.matchType === 'REGEX') {
      for (const k of d.keywords) {
        try {
          new RegExp(k, 'i');
        } catch {
          out.push(`“${k}” is not a valid regular expression.`);
        }
      }
    }
    return [...out, ...validateInteractive(d.interactive)];
  });

  protected readonly preview = computed<PreviewTurn[]>(() => {
    const d = this.value();
    const sample = {
      name: 'Aarav Sharma',
      phone: '+91 98765 43210',
      businessName: this.businessName(),
    };
    const path = this.previewPath();
    const node = path ? d.menu[path] : undefined;
    if (path && node) {
      const opt = this.options().find((o) => o.id === path);
      return [
        {
          incoming: opt?.title ?? path,
          replies: [
            {
              text: renderTemplate(nodeTexts(node)[0], sample),
              media: node.media ?? null,
              interactive: node.interactive ?? null,
            },
          ],
        },
      ];
    }
    return [
      {
        incoming: d.matchType === 'FALLBACK' ? 'something unexpected' : (d.keywords[0] ?? 'Hi'),
        replies: [
          {
            text: renderTemplate(d.variants[0] ?? '', sample),
            media: d.media,
            interactive: d.interactive,
          },
        ],
      },
    ];
  });

  protected patch(p: Partial<RuleDraft>): void {
    this.value.set({ ...this.value(), ...p });
  }

  protected patchActions(p: Partial<RuleDraft['actions']>): void {
    this.patch({ actions: { ...this.value().actions, ...p } });
  }

  protected setField(key: 'key' | 'value', v: string): void {
    const cur = this.value().actions.setField ?? { key: '', value: '' };
    this.patchActions({ setField: { ...cur, [key]: v } });
  }

  protected v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected trySave(): void {
    this.attempted.set(true);
    if (!this.problems().length) this.save.emit();
  }
}
