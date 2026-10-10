/**
 * Interactive message types, mirroring server/src/messaging/interactive.js.
 * Keep renderFallbackText byte-for-byte in step with the server version.
 */

export type InteractiveType = 'buttons' | 'cta' | 'list';

export interface InteractiveButton {
  id: string;
  title: string;
  payload?: string;
}

export interface InteractiveCta {
  kind: 'url' | 'call' | 'copy';
  title: string;
  value: string;
}

export interface InteractiveRow {
  id: string;
  title: string;
  description?: string;
  payload?: string;
}

export interface InteractiveSection {
  title: string;
  rows: InteractiveRow[];
}

export interface InteractiveDraft {
  type: InteractiveType;
  header?: string;
  footer?: string;
  buttons?: InteractiveButton[];
  cta?: InteractiveCta[];
  list?: { button: string; sections: InteractiveSection[] };
}

export type ReplyRuleAction =
  | { type: 'send_message'; text: string }
  | { type: 'add_tag'; tags: string[] }
  | { type: 'remove_tag'; tags: string[] }
  | { type: 'set_field'; key: string; value: string }
  | { type: 'mute_days'; days: number }
  | { type: 'opt_out' }
  | { type: 'escalate'; assignTo?: string; ticket?: boolean };

export type ReplyRuleActionType = ReplyRuleAction['type'];

export interface ReplyRule {
  /** An option id, or 'any' for every reply to the message. */
  optionId: string;
  actions: ReplyRuleAction[];
}

export const LIMITS = {
  header: 60,
  footer: 60,
  buttonTitle: 20,
  buttons: 3,
  ctaTitle: 20,
  cta: 2,
  listButton: 20,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rows: 10,
} as const;

const NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

/** Same slug rule as the server: OPTION_<n> when the title has no usable characters. */
export function slugId(title: string, i: number): string {
  return (
    String(title ?? '')
      .trim()
      .slice(0, 40)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '') || `OPTION_${i + 1}`
  );
}

/** Every option a recipient can pick, in display order. */
export function interactiveOptions(
  draft: InteractiveDraft | null | undefined,
): (InteractiveButton | InteractiveRow)[] {
  if (!draft) return [];
  if (draft.type === 'buttons') return draft.buttons ?? [];
  if (draft.type === 'list') return (draft.list?.sections ?? []).flatMap((s) => s.rows);
  return [];
}

/** Plain-text rendering for transports without native buttons (port of the server function). */
export function renderFallbackText(
  text: string,
  draft: InteractiveDraft | null | undefined,
): string {
  const parts: string[] = [];
  if (draft?.header) parts.push(`*${draft.header}*`);
  parts.push(String(text ?? '').trim());
  const options = interactiveOptions(draft);
  if (options.length) {
    parts.push(
      [
        'Reply with:',
        ...options.map((o, i) => {
          const description = (o as InteractiveRow).description;
          return `${NUMBERS[i]}. ${o.title}${description ? ` - ${description}` : ''}`;
        }),
      ].join('\n'),
    );
  }
  if (draft?.type === 'cta') {
    parts.push((draft.cta ?? []).map((c) => `${c.title}: ${c.value}`).join('\n'));
  }
  if (draft?.footer) parts.push(`_${draft.footer}_`);
  return parts.filter(Boolean).join('\n\n');
}

/** Human-readable problems with a draft; empty when it would pass the server's checks. */
export function validateInteractive(draft: InteractiveDraft | null | undefined): string[] {
  if (!draft) return [];
  const errors: string[] = [];
  const len = (v: string | undefined) => String(v ?? '').trim().length;
  const tooLong = (label: string, v: string | undefined, max: number) => {
    if (len(v) > max) errors.push(`${label} is ${len(v)} characters; the limit is ${max}.`);
  };

  tooLong('Header', draft.header, LIMITS.header);
  tooLong('Footer', draft.footer, LIMITS.footer);

  if (draft.type === 'buttons') {
    const buttons = draft.buttons ?? [];
    if (!buttons.length) errors.push('Add at least one reply button.');
    if (buttons.length > LIMITS.buttons)
      errors.push(`Use at most ${LIMITS.buttons} reply buttons.`);
    buttons.forEach((b, i) => {
      if (!len(b.title)) errors.push(`Button ${i + 1} needs a title.`);
      tooLong(`Button ${i + 1} title`, b.title, LIMITS.buttonTitle);
    });
  } else if (draft.type === 'cta') {
    const cta = draft.cta ?? [];
    if (!cta.length) errors.push('Add at least one call-to-action button.');
    if (cta.length > LIMITS.cta) errors.push(`Use at most ${LIMITS.cta} call-to-action buttons.`);
    if (cta.length > 1 && cta.some((c) => c.kind === 'copy'))
      errors.push('A copy-code button must be the only call-to-action button.');
    cta.forEach((c, i) => {
      if (!len(c.title)) errors.push(`Call-to-action ${i + 1} needs a title.`);
      tooLong(`Call-to-action ${i + 1} title`, c.title, LIMITS.ctaTitle);
      if (!len(c.value))
        errors.push(
          `Call-to-action ${i + 1} needs ${c.kind === 'url' ? 'a link' : c.kind === 'call' ? 'a phone number' : 'a code'}.`,
        );
    });
  } else if (draft.type === 'list') {
    const sections = draft.list?.sections ?? [];
    const rows = sections.flatMap((s) => s.rows);
    tooLong('List button label', draft.list?.button, LIMITS.listButton);
    if (!rows.length) errors.push('Add at least one list option.');
    if (rows.length > LIMITS.rows)
      errors.push(
        `A list menu can have at most ${LIMITS.rows} options in total (now ${rows.length}).`,
      );
    sections.forEach((s, si) => {
      tooLong(`Section ${si + 1} title`, s.title, LIMITS.sectionTitle);
      s.rows.forEach((r, ri) => {
        const label = `Section ${si + 1}, option ${ri + 1}`;
        if (!len(r.title)) errors.push(`${label} needs a title.`);
        tooLong(`${label} title`, r.title, LIMITS.rowTitle);
        tooLong(`${label} description`, r.description, LIMITS.rowDescription);
      });
    });
  }
  return errors;
}
