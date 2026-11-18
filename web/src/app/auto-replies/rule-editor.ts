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
import { ArChips, ArMedia, ArSwitch, ArTranslations, ArVariants } from './ar-fields';
import {
  CollectQuestion,
  CollectType,
  Intent,
  Language,
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
  { value: 'ALL_OF', label: 'All of', hint: 'Every keyword, in any order: “price” and “delivery”', icon: 'list-check' },
  { value: 'FUZZY', label: 'Fuzzy', hint: 'Typo tolerant: “prise” finds “price”', icon: 'wand' },
  {
    value: 'MESSAGE_TYPE',
    label: 'Message type',
    hint: 'A photo, file, voice note, location…',
    icon: 'paperclip',
  },
  {
    value: 'INTENT',
    label: 'Intent',
    hint: 'What they mean, any language: “rate kya hai” is Price',
    icon: 'bulb',
  },
  { value: 'REGEX', label: 'Regex', hint: 'JavaScript regular expression', icon: 'code' },
  { value: 'FALLBACK', label: 'Fallback', hint: 'When no other rule matched', icon: 'lifebuoy' },
];

/**
 * Spelling mistakes the matcher forgives anyway, to show the business what it already catches: a letter left
 * out, two letters swapped, a letter stretched. Never the first letter (the matcher keeps it too).
 */
export function typoExamples(keyword: string): string[] {
  const w = keyword.toLowerCase().trim();
  if (!w || w.includes(' ')) return [];
  if (w.length < 4) return [w + w.slice(-1).repeat(2)];
  const mid = Math.floor(w.length / 2);
  const out = new Set([
    w.slice(0, mid) + w.slice(mid + 1),
    w.slice(0, mid) + w[mid + 1] + w[mid] + w.slice(mid + 2),
    w + w.slice(-1),
  ]);
  out.delete(w);
  return [...out];
}


export const COLLECT_TYPES: readonly { value: CollectType; label: string }[] = [
  { value: 'text', label: 'Any text' },
  { value: 'name', label: 'Name' },
  { value: 'phone', label: 'Phone number' },
  { value: 'email', label: 'Email' },
  { value: 'number', label: 'Number' },
  { value: 'language', label: 'Language choice' },
];

/** Human names for the message types a rule can answer. */
export const MESSAGE_TYPE_LABEL: Record<string, string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Voice note / audio',
  document: 'Document / PDF',
  sticker: 'Sticker',
  location: 'Location',
  contact: 'Contact card',
};

/** Triggers whose "keywords" are picked from a fixed list, not typed. */
const PICKED: readonly MatchType[] = ['INTENT', 'MESSAGE_TYPE'];

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
    synonyms: true,
    typos: true,
    translations: {},
    collect: null,
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
    schedule: d.schedule && { ...d.schedule, timezone: d.schedule.timezone || browserZone() },
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
    synonyms: d.synonyms,
    typos: d.typos,
    translations: Object.fromEntries(
      Object.entries(d.translations).filter(([, text]) => text.trim()),
    ),
    collect: cleanCollect(d),
    isActive: d.isActive,
  };
}

/** Questions with a field and a question only; null when none are left. */
function cleanCollect(d: RuleDraft): RulePayload['collect'] {
  const questions = (d.collect?.questions ?? []).filter((q) => q.key.trim() && q.question.trim());
  return questions.length ? { questions, doneReply: d.collect?.doneReply ?? '' } : null;
}

/**
 * One keyword rule as five numbered steps (trigger, reply, buttons, when/who,
 * actions) beside a live WhatsApp preview.
 *
 * Problems are computed continuously but only shown after the first save
 * attempt, so a fresh rule is not covered in red before the user has typed.
 */
/** The zone the user is picking times in, so "9 to 6" means their 9 to 6, not the server's. */
function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

@Component({
  selector: 'ar-rule-editor',
  imports: [
    ArChips,
    ArMedia,
    ArSwitch,
    ArTranslations,
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
  readonly intents = input<readonly Intent[]>([]);
  readonly languages = input<readonly Language[]>([]);
  readonly messageTypes = input<readonly string[]>([]);
  /** The plan's auto-reply rules (GET /api/policy values). */
  readonly plan = input<Record<string, unknown>>({});

  /** What the plan includes, for hiding what it does not. */
  protected readonly allows = computed(() => {
    const p = this.plan();
    return {
      intents: p['autoReplies.allowIntents'] !== false,
      messageTypes: p['autoReplies.allowMessageTypes'] !== false,
      questions: p['autoReplies.allowQuestions'] !== false,
      translations: p['autoReplies.allowTranslations'] !== false,
      maxQuestions: Number(p['autoReplies.maxQuestions'] ?? 8) || 8,
    };
  });
  /** Match types on the plan (the current one stays listed so an old rule still reads right). */
  protected readonly shownTypes = computed(() => {
    const a = this.allows();
    const cur = this.value().matchType;
    // Fuzzy is how every keyword matches now, so it is not a choice (an old Fuzzy rule still shows it).
    return MATCH_TYPES.filter((m) => m.value === cur
      || m.value !== 'FUZZY' && (m.value !== 'INTENT' || a.intents) && (m.value !== 'MESSAGE_TYPE' || a.messageTypes));
  });

  /** A few of the spelling mistakes the keywords already catch. */
  protected readonly typoHints = computed(() => {
    const d = this.value();
    if (!['EXACT', 'CONTAINS', 'ANY_OF', 'ALL_OF', 'FUZZY'].includes(d.matchType) || d.typos === false) return [];
    return d.keywords.slice(0, 3).flatMap((k) => typoExamples(k).slice(0, 2)).slice(0, 6);
  });

  /** Words that mean the same as a keyword (the built-in intents), not yet keywords themselves. */
  protected readonly similarWords = computed(() => {
    const d = this.value();
    if (d.matchType === 'REGEX' || !this.allows().intents) return [];
    const have = new Set(d.keywords.map((k) => k.toLowerCase().trim()));
    const out = new Set<string>();
    for (const intent of this.intents()) {
      const words = intent.words ?? intent.examples;
      if (words.some((w) => have.has(w.toLowerCase()))) for (const w of words) if (!have.has(w.toLowerCase())) out.add(w);
    }
    return [...out].slice(0, 16);
  });

  protected addKeyword(word: string): void {
    this.patch({ keywords: [...this.value().keywords, word] });
  }
  readonly dirty = input(false);
  readonly save = output<void>();
  readonly remove = output<void>();
  readonly cancel = output<void>();

  protected readonly matchTypes = MATCH_TYPES;
  protected readonly collectTypes = COLLECT_TYPES;
  protected readonly typeLabel = MESSAGE_TYPE_LABEL;
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
    if (d.matchType === 'INTENT' && !d.keywords.length) out.push('Pick at least one intent.');
    else if (d.matchType === 'MESSAGE_TYPE' && !d.keywords.length) out.push('Pick at least one message type.');
    else if (d.matchType !== 'FALLBACK' && !d.keywords.length) out.push('Add at least one keyword.');
    const asks = (d.collect?.questions ?? []).filter((q) => q.question.trim());
    if (asks.some((q) => !q.key.trim())) out.push('Name the contact field each answer is saved to.');
    if (asks.length && (d.interactive || d.actions.escalate))
      out.push('A rule that asks questions cannot also show buttons or hand over to a person.');
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
        incoming:
          d.matchType === 'FALLBACK'
            ? 'something unexpected'
            : d.matchType === 'INTENT'
              ? (this.intents().find((i) => i.id === d.keywords[0])?.examples[0] ?? 'Hi')
              : d.matchType === 'MESSAGE_TYPE'
                ? `[${MESSAGE_TYPE_LABEL[d.keywords[0]] ?? 'Photo'}]`
                : (d.keywords[0] ?? 'Hi'),
        replies: [
          {
            // The first question rides in the same message, as the server sends it.
            text: [renderTemplate(d.variants[0] ?? '', sample), d.collect?.questions[0]?.question]
              .filter(Boolean)
              .join('\n\n'),
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

  protected setType(m: MatchType): void {
    const d = this.value();
    // Picked ids (intents, message types) and typed keywords do not carry over between kinds of trigger.
    const switching = m !== d.matchType && (PICKED.includes(m) || PICKED.includes(d.matchType));
    this.patch({ matchType: m, keywords: switching ? [] : d.keywords });
  }

  protected toggleOption(i: number, code: string): void {
    const cur = this.questions()[i].options ?? ['en', 'hi', 'gu'];
    this.setQuestion(i, { options: cur.includes(code) ? cur.filter((c) => c !== code) : [...cur, code] });
  }

  protected toggleIntent(id: string): void {
    const k = this.value().keywords;
    this.patch({ keywords: k.includes(id) ? k.filter((x) => x !== id) : [...k, id] });
  }

  protected questions(): CollectQuestion[] {
    return this.value().collect?.questions ?? [];
  }

  protected setQuestions(questions: CollectQuestion[]): void {
    const doneReply = this.value().collect?.doneReply ?? '';
    this.patch({ collect: questions.length ? { questions, doneReply } : null });
  }

  protected setQuestion(i: number, p: Partial<CollectQuestion>): void {
    this.setQuestions(this.questions().map((q, j) => (j === i ? { ...q, ...p } : q)));
  }

  protected addQuestion(): void {
    const first = !this.questions().length;
    this.setQuestions([
      ...this.questions(),
      first
        ? { key: 'name', question: 'May I have your name?', type: 'name' }
        : { key: '', question: '', type: 'text' },
    ]);
  }

  protected setDone(doneReply: string): void {
    const c = this.value().collect;
    if (c) this.patch({ collect: { ...c, doneReply } });
  }

  protected v(e: Event): string {
    return (e.target as HTMLInputElement).value;
  }

  protected trySave(): void {
    this.attempted.set(true);
    if (!this.problems().length) this.save.emit();
  }
}
