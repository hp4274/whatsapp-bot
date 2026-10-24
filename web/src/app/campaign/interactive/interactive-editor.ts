import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  signal,
} from '@angular/core';

import { ArSwitch } from '../../auto-replies/ar-fields';
import { Api } from '../../core/api';
import { MediaSrc } from './media-src';
import {
  InteractiveButton,
  InteractiveCard,
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

/** Instance counter for unique element ids. */
let seq = 0;

const TYPES: { value: Choice; label: string; icon: string }[] = [
  { value: 'none', label: 'None', icon: 'ban' },
  { value: 'buttons', label: 'Reply buttons', icon: 'hand-click' },
  { value: 'cta', label: 'Call-to-action', icon: 'external-link' },
  { value: 'list', label: 'List menu', icon: 'list' },
  { value: 'carousel', label: 'Carousel', icon: 'carousel-horizontal' },
];

/** Carousel card images: WhatsApp accepts JPEG/PNG headers; the upload endpoint caps files at 16 MB. */
const CARD_IMAGE_TYPES = ['image/jpeg', 'image/png'];
const CARD_IMAGE_MAX = 16 * 1024 * 1024;

const blankCard = (kind: 'url' | 'reply', no: number): InteractiveCard => ({
  mediaId: '',
  mediaUrl: '',
  text: '',
  ...(kind === 'url'
    ? { cta: [{ kind: 'url' as const, title: 'Learn more', value: '' }] }
    : { buttons: [{ id: `${slugId('Learn more', 0)}_${no}`, title: 'Learn more' }] }),
});

/** Label and example per call-to-action kind, so the value field says what it expects. */
const CTA_HINTS: Record<InteractiveCta['kind'], { label: string; placeholder: string }> = {
  url: { label: 'Link', placeholder: 'https://shop.com/track/{order_id}' },
  call: { label: 'Phone number', placeholder: '+919876543210' },
  copy: { label: 'Code', placeholder: 'SAVE20' },
};

/** Keep an id the user (or saved data) set; re-derive it from the title while it is still the auto one. */
function nextId(
  old: { id: string; title: string },
  title: string,
  i: number,
  taken: string[],
): string {
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

/**
 * Builds the optional WhatsApp interactive block (reply buttons, call-to-action
 * or list menu) as a two-way `value`. Limits and validation come from
 * interactive.model so the editor flags exactly what the server would reject.
 */
@Component({
  selector: 'app-interactive-editor',
  imports: [ArSwitch, MediaSrc],
  templateUrl: './interactive-editor.html',
  styleUrl: './interactive-editor.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InteractiveEditor {
  readonly value = model<InteractiveDraft | null>(null);
  readonly variables = input<string[]>([]);
  /** Offer the Carousel type; only the campaign composer does (templates and auto-replies can't send one). */
  readonly carousel = input(false);

  private readonly api = inject(Api);

  /** Prefix for element ids so label[for] stays unique across instances. */
  protected readonly uid = `ie${++seq}`;
  protected readonly types = computed(() =>
    TYPES.filter((t) => t.value !== 'carousel' || this.carousel()),
  );
  protected readonly limits = LIMITS;
  protected readonly ctaHints = CTA_HINTS;
  protected readonly type = computed<Choice>(() => this.value()?.type ?? 'none');
  protected readonly errors = computed(() => validateInteractive(this.value()));
  /** Index of the card whose image is uploading, and the last upload error as [card, message]. */
  protected readonly uploading = signal(-1);
  protected readonly uploadError = signal<[number, string] | null>(null);
  protected readonly rowCount = computed(() =>
    (this.value()?.list?.sections ?? []).reduce((n, s) => n + s.rows.length, 0),
  );

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
    const base = { type, header: current?.header, footer: current?.footer, native: current?.native };
    if (type === 'buttons') {
      this.value.set({
        ...base,
        buttons: [
          { id: 'YES', title: 'Yes' },
          { id: 'NO', title: 'No' },
        ],
      });
    } else if (type === 'carousel') {
      // No header/footer on a carousel: the main message is the only text above the cards.
      this.value.set({
        type,
        native: current?.native,
        carousel: { kind: 'url', cards: [blankCard('url', 1), blankCard('url', 2)] },
      });
    } else if (type === 'cta') {
      this.value.set({ ...base, cta: [{ kind: 'url', title: 'Track order', value: '' }] });
    } else {
      this.value.set({
        ...base,
        list: {
          button: 'View options',
          sections: [{ title: 'Options', rows: [{ id: 'OPTION_1', title: 'Option 1' }] }],
        },
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
        next.id = nextId(
          b,
          change.title,
          i,
          this.buttons()
            .filter((_, k) => k !== i)
            .map((o) => o.id),
        );
      }
      return next;
    });
    this.patch({ buttons });
  }

  protected addButton(): void {
    const buttons = this.buttons();
    if (buttons.length >= LIMITS.buttons) return;
    const title = `Option ${buttons.length + 1}`;
    this.patch({
      buttons: [
        ...buttons,
        {
          id: uniqueId(
            slugId(title, buttons.length),
            buttons.map((b) => b.id),
          ),
          title,
        },
      ],
    });
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
    return this.sections()
      .flatMap((s) => s.rows)
      .filter((r) => r !== except)
      .map((r) => r.id);
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
    this.setSections([
      ...this.sections(),
      { title: `Section ${this.sections().length + 1}`, rows: [row] },
    ]);
  }

  protected removeSection(si: number): void {
    this.setSections(this.sections().filter((_, j) => j !== si));
  }

  protected updateRow(si: number, ri: number, change: Partial<InteractiveRow>): void {
    this.setSections(
      this.sections().map((s, j) =>
        j !== si
          ? s
          : {
              ...s,
              rows: s.rows.map((r, k) => {
                if (k !== ri) return r;
                const next = { ...r, ...change };
                if (change.title !== undefined)
                  next.id = nextId(r, change.title, k, this.rowIds(r));
                return next;
              }),
            },
      ),
    );
  }

  protected addRow(si: number): void {
    if (this.rowCount() >= LIMITS.rows) return;
    const title = `Option ${this.rowCount() + 1}`;
    const row = { id: uniqueId(slugId(title, this.rowCount()), this.rowIds()), title };
    this.setSections(
      this.sections().map((s, j) => (j === si ? { ...s, rows: [...s.rows, row] } : s)),
    );
  }

  protected removeRow(si: number, ri: number): void {
    this.setSections(
      this.sections().map((s, j) =>
        j === si ? { ...s, rows: s.rows.filter((_, k) => k !== ri) } : s,
      ),
    );
  }

  // Carousel --------------------------------------------------------------
  protected cards(): InteractiveCard[] {
    return this.value()?.carousel?.cards ?? [];
  }

  protected kind(): 'url' | 'reply' {
    return this.value()?.carousel?.kind ?? 'url';
  }

  private setCards(cards: InteractiveCard[], kind = this.kind()): void {
    this.patch({ carousel: { kind, cards } });
  }

  protected patchCard(i: number, change: Partial<InteractiveCard>): void {
    this.setCards(this.cards().map((c, j) => (j === i ? { ...c, ...change } : c)));
  }

  /** Every card follows the carousel's kind, so switching converts them all and keeps the button titles. */
  protected setKind(kind: 'url' | 'reply'): void {
    if (kind === this.kind()) return;
    this.setCards(
      this.cards().map(({ mediaId, mediaUrl, text, buttons, cta }, i) => {
        const title = buttons?.[0]?.title || cta?.[0]?.title || 'Learn more';
        return kind === 'url'
          ? { mediaId, mediaUrl, text, cta: [{ kind: 'url' as const, title, value: '' }] }
          : { mediaId, mediaUrl, text, buttons: [{ id: this.replyId(title, i, 0, []), title }] };
      }),
      kind,
    );
  }

  protected addCard(): void {
    if (this.cards().length >= LIMITS.cards.max) return;
    this.setCards([...this.cards(), blankCard(this.kind(), this.cards().length + 1)]);
  }

  protected removeCard(i: number): void {
    if (this.cards().length <= LIMITS.cards.min) return;
    // Reply ids carry the card number, so re-derive them for the cards that shift up.
    this.setCards(
      this.cards()
        .filter((_, j) => j !== i)
        .map((c, j) => this.renumber(c, j)),
    );
  }

  private renumber(card: InteractiveCard, i: number): InteractiveCard {
    if (!card.buttons) return card;
    const buttons: InteractiveButton[] = [];
    card.buttons.forEach((b, bi) =>
      buttons.push({ ...b, id: this.replyId(b.title, i, bi, buttons.map((o) => o.id)) }),
    );
    return { ...card, buttons };
  }

  /** slug(title)_<cardNo>, with the button number added when two buttons on a card would clash. */
  private replyId(title: string, card: number, bi: number, taken: string[]): string {
    const id = `${slugId(title, bi)}_${card + 1}`;
    return taken.includes(id) ? `${id}_${bi + 1}` : id;
  }

  protected updateCardReply(i: number, bi: number, title: string): void {
    const card = this.cards()[i];
    const buttons = (card.buttons ?? []).map((b, j) => (j === bi ? { ...b, title } : b));
    this.patchCard(i, this.renumber({ ...card, buttons }, i));
  }

  protected addCardReply(i: number): void {
    const card = this.cards()[i];
    const buttons = card.buttons ?? [];
    if (buttons.length >= LIMITS.cardButtons) return;
    const title = `Option ${buttons.length + 1}`;
    this.patchCard(i, {
      buttons: [
        ...buttons,
        { id: this.replyId(title, i, buttons.length, buttons.map((b) => b.id)), title },
      ],
    });
  }

  protected removeCardReply(i: number, bi: number): void {
    const card = this.cards()[i];
    this.patchCard(
      i,
      this.renumber({ ...card, buttons: (card.buttons ?? []).filter((_, j) => j !== bi) }, i),
    );
  }

  protected updateCardLink(i: number, change: Partial<InteractiveCta>): void {
    const link = this.cards()[i].cta?.[0] ?? { kind: 'url' as const, title: '', value: '' };
    this.patchCard(i, { cta: [{ ...link, ...change }] });
  }

  protected insertCardLinkVar(select: HTMLSelectElement, i: number): void {
    const token = this.pick(select);
    if (token) this.updateCardLink(i, { value: (this.cards()[i].cta?.[0]?.value ?? '') + token });
  }

  protected pickCardImage(input: HTMLInputElement, i: number): void {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (!CARD_IMAGE_TYPES.includes(file.type))
      return this.uploadError.set([i, 'Use a JPEG or PNG image.']);
    if (file.size > CARD_IMAGE_MAX) return this.uploadError.set([i, 'The image is over 16 MB.']);
    this.uploadError.set(null);
    this.uploading.set(i);
    this.api.uploadMedia(file).subscribe({
      next: (m) => {
        this.uploading.set(-1);
        this.patchCard(i, { mediaId: m.mediaId, mediaUrl: m.url });
      },
      error: (err: Error) => {
        this.uploading.set(-1);
        this.uploadError.set([i, err.message]);
      },
    });
  }

  protected clearCardImage(i: number): void {
    this.patchCard(i, { mediaId: '', mediaUrl: '' });
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
    if (token)
      this.updateRow(si, ri, { payload: (this.sections()[si].rows[ri].payload ?? '') + token });
  }
}
