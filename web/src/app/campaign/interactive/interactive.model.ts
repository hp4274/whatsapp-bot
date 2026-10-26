/**
 * Interactive message types, mirroring server/src/messaging/interactive.js.
 * Keep renderFallbackText and carouselCaptions byte-for-byte in step with the server version.
 */

export type InteractiveType = 'buttons' | 'cta' | 'list' | 'carousel';

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

/** One slide of a carousel; `mediaUrl` is the uploaded image's URL (thumbnail and preview). */
export interface InteractiveCard {
  /** Editor-only identity so an upload finds its card after others move; the server keeps only the fields it knows. */
  uid?: string;
  mediaId: string;
  mediaUrl: string;
  text: string;
  buttons?: InteractiveButton[];
  cta?: InteractiveCta[];
}

export interface InteractiveDraft {
  type: InteractiveType;
  header?: string;
  footer?: string;
  buttons?: InteractiveButton[];
  cta?: InteractiveCta[];
  list?: { button: string; sections: InteractiveSection[] };
  /** Every card uses the carousel's `kind`: one link each, or 1-2 quick replies each. */
  carousel?: { kind: 'url' | 'reply'; cards: InteractiveCard[] };
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
  cards: { min: 2, max: 5 },
  cardText: 160,
  cardButtons: 2,
} as const;

const NUMBERS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const CTA_ICON: Record<InteractiveCta['kind'], string> = { url: '🔗', call: '📞', copy: '📋' };

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
  if (draft.type === 'carousel')
    return (draft.carousel?.cards ?? []).flatMap((c) => c.buttons ?? []);
  return [];
}

/**
 * Plain-text rendering for transports without native buttons (port of the server function):
 * what a QR number sends. A carousel is its text then every card caption, with no header or footer.
 */
export function renderFallbackText(
  text: string,
  draft: InteractiveDraft | null | undefined,
): string {
  if (draft?.type === 'carousel')
    return [String(text ?? '').trim(), ...carouselCaptions(draft)].filter(Boolean).join('\n\n');
  const parts: string[] = [];
  if (draft?.header) parts.push(`*${draft.header}*`);
  parts.push(String(text ?? '').trim());
  if (draft?.type === 'buttons') {
    const buttons = draft.buttons ?? [];
    const nums = buttons.map((_, i) => NUMBERS[i]);
    const ask = nums.length > 1 ? `${nums.slice(0, -1).join(', ')} or ${nums.at(-1)}` : nums[0];
    if (buttons.length)
      parts.push([`Reply ${ask}:`, ...buttons.map((o, i) => `${nums[i]}. ${o.title}`)].join('\n'));
  } else if (draft?.type === 'cta') {
    parts.push(
      (draft.cta ?? [])
        .map((c) => `${CTA_ICON[c.kind] ?? CTA_ICON.url} ${c.title}: ${c.value}`)
        .join('\n'),
    );
  } else if (draft?.type === 'list' && draft.list) {
    let n = 0;
    const sections = draft.list.sections.map((s) =>
      [
        ...(s.title ? [`_${s.title}_`] : []),
        ...s.rows.map(
          (r) => `${NUMBERS[n++]}. ${r.title}${r.description ? ` - ${r.description}` : ''}`,
        ),
      ].join('\n'),
    );
    parts.push([`*${draft.list.button}*`, ...sections].join('\n\n'));
  }
  if (draft?.footer) parts.push(`_${draft.footer}_`);
  return parts.filter(Boolean).join('\n\n');
}

/**
 * One caption per carousel card (port of the server function): its text, then "Reply 3 or 4:"
 * with its buttons or a "🔗 Title: url" line. Reply numbers run across all cards, so a typed "3"
 * is the third button overall. The server keeps only the fields of the carousel's kind; so does this.
 */
export function carouselCaptions(draft: InteractiveDraft | null | undefined): string[] {
  if (draft?.type !== 'carousel' || !draft.carousel) return [];
  const { kind, cards } = draft.carousel;
  let n = 0;
  return cards.map((card) => {
    let lines = '';
    if (kind === 'reply' && card.buttons?.length) {
      const nums = card.buttons.map(() => String(++n));
      const ask = nums.length > 1 ? `${nums.slice(0, -1).join(', ')} or ${nums.at(-1)}` : nums[0];
      lines = [`Reply ${ask}:`, ...card.buttons.map((b, i) => `${nums[i]}. ${b.title}`)].join('\n');
    } else if (kind === 'url' && card.cta?.length) {
      lines = card.cta.map((c) => `${CTA_ICON.url} ${c.title}: ${c.value}`).join('\n');
    }
    return [String(card.text ?? '').trim(), lines].filter(Boolean).join('\n\n');
  });
}

/** Human-readable problems with a draft; empty when it would pass the server's checks. */
export function validateInteractive(draft: InteractiveDraft | null | undefined): string[] {
  if (!draft) return [];
  const errors: string[] = [];
  const len = (v: string | undefined) => String(v ?? '').trim().length;
  const tooLong = (label: string, v: string | undefined, max: number) => {
    if (len(v) > max) errors.push(`${label} is ${len(v)} characters; the limit is ${max}.`);
  };

  if (draft.type !== 'carousel') {
    tooLong('Header', draft.header, LIMITS.header);
    tooLong('Footer', draft.footer, LIMITS.footer);
  }

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
  } else if (draft.type === 'carousel') {
    const kind = draft.carousel?.kind ?? 'url';
    const cards = draft.carousel?.cards ?? [];
    if (cards.length < LIMITS.cards.min || cards.length > LIMITS.cards.max)
      errors.push(`A carousel needs ${LIMITS.cards.min} to ${LIMITS.cards.max} cards.`);
    cards.forEach((c, i) => {
      const label = `Card ${i + 1}`;
      if (!c.mediaId) errors.push(`${label} needs an image.`);
      if (!len(c.text)) errors.push(`${label} needs text.`);
      tooLong(`${label} text`, c.text, LIMITS.cardText);
      if (kind === 'reply') {
        const buttons = c.buttons ?? [];
        if (!buttons.length || buttons.length > LIMITS.cardButtons)
          errors.push(`${label} needs 1 or ${LIMITS.cardButtons} reply buttons.`);
        buttons.forEach((b, bi) => {
          if (!len(b.title)) errors.push(`${label}, button ${bi + 1} needs a title.`);
          tooLong(`${label}, button ${bi + 1} title`, b.title, LIMITS.buttonTitle);
        });
      } else {
        const link = c.cta?.[0];
        if (!len(link?.title)) errors.push(`${label} needs a link button title.`);
        tooLong(`${label} link title`, link?.title, LIMITS.ctaTitle);
        if (!len(link?.value)) errors.push(`${label} needs a link.`);
      }
    });
  }
  return errors;
}
