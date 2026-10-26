import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';

import { Auth } from '../core/auth';
import {
  InteractiveDraft,
  carouselCaptions,
  renderFallbackText,
} from './interactive/interactive.model';
import { MediaSrc } from './interactive/media-src';
import { DraftAttachment, VariantKey } from './draft';
import { formatBytes, linkify, substitute, waToHtml } from './wa-format';

/** Tabler icon per call-to-action kind, matching what WhatsApp draws on the button. */
const CTA_ICONS = { url: 'external-link', call: 'phone', copy: 'copy' } as const;

/** The block with its variables filled field by field, as the server's personalizeInteractive does. */
function fillBlock(block: InteractiveDraft, fill: (text: string) => string): InteractiveDraft {
  const f = (v: string | undefined) => (v === undefined ? undefined : fill(v));
  return {
    ...block,
    header: f(block.header),
    footer: f(block.footer),
    buttons: block.buttons?.map((b) => ({ ...b, title: fill(b.title) })),
    cta: block.cta?.map((c) => ({ ...c, title: fill(c.title), value: fill(c.value) })),
    list: block.list && {
      ...block.list,
      sections: block.list.sections.map((s) => ({
        ...s,
        rows: s.rows.map((r) => ({ ...r, title: fill(r.title), description: f(r.description) })),
      })),
    },
    carousel: block.carousel && {
      ...block.carousel,
      cards: block.carousel.cards.map((c) => ({
        ...c,
        text: fill(c.text),
        buttons: c.buttons?.map((b) => ({ ...b, title: fill(b.title) })),
        cta: c.cta?.map((x) => ({ ...x, title: fill(x.title), value: fill(x.value) })),
      })),
    },
  };
}

/**
 * A WhatsApp chat mockup showing exactly what one recipient receives. It runs
 * the same substitution as the server (variables, fallbacks, seeded spintax),
 * so the bubble is the real text, not an approximation. The chat itself keeps
 * WhatsApp's own colours on purpose; only the frame follows the app theme.
 *
 * `textMenu` (QR numbers) shows what such a number really sends: buttons and
 * lists as the numbered menu text, a carousel as its text then one captioned
 * image per card, each its own message.
 */
@Component({
  selector: 'app-phone-preview',
  imports: [MediaSrc],
  templateUrl: './phone-preview.html',
  styleUrl: './phone-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhonePreview {
  private readonly auth = inject(Auth);
  readonly text = input('');
  readonly context = input<Record<string, string>>({});
  readonly fallbacks = input<Record<string, string>>({});
  readonly attachment = input<DraftAttachment | null>(null);
  readonly interactive = input<InteractiveDraft | null>(null);
  /** Zero-based position of the previewed contact among `total`. */
  readonly index = input(0);
  readonly total = input(1);
  readonly contactLabel = input('');
  /** Spintax seed; Shuffle changes it to show another variant. */
  readonly seed = input(1);
  /** True when there is no audience yet and the preview uses a made-up contact. */
  readonly sample = input(false);
  /** QR number: buttons go as a numbered text menu, a carousel as captioned images. */
  readonly textMenu = input(false);

  /** A/B test versions on offer (`['A', 'B']`); empty hides the switch. */
  readonly versions = input<readonly VariantKey[]>([]);
  /** The version `text` is showing. */
  readonly version = input<VariantKey>('A');

  readonly versionChange = output<VariantKey>();
  readonly prev = output<void>();
  readonly next = output<void>();
  readonly shuffle = output<void>();

  protected readonly ctaIcons = CTA_ICONS;
  protected readonly time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  protected readonly rendered = computed(() =>
    substitute(this.text(), this.context(), this.fallbacks(), this.seed()),
  );
  /** The bubble body with links styled like WhatsApp draws them. */
  protected readonly bodyHtml = computed(() => linkify(this.rendered().html));

  /** The interactive block with every variable filled, for the text-menu rendering. */
  private readonly filledBlock = computed(() => {
    const block = this.interactive();
    return block ? fillBlock(block, (t) => this.fill(t).text) : null;
  });
  /** Text-menu mode, buttons or a list: the one message the server sends (renderFallbackText). */
  protected readonly menuHtml = computed(() => {
    const block = this.filledBlock();
    if (!this.textMenu() || !block || block.type === 'carousel') return null;
    return linkify(waToHtml(renderFallbackText(this.rendered().text, block)));
  });
  /** Text-menu mode, a carousel: one image message per card, captioned as the server does. */
  protected readonly cardMessages = computed(() => {
    const block = this.filledBlock();
    if (!this.textMenu() || block?.type !== 'carousel') return [];
    const captions = carouselCaptions(block);
    return (block.carousel?.cards ?? []).map((c, i) => ({
      mediaUrl: c.mediaUrl,
      html: linkify(waToHtml(captions[i] ?? '')),
    }));
  });

  /** Unresolved keys in the message and in the interactive block. */
  protected readonly missing = computed(() => {
    const keys = new Set(this.rendered().missing);
    const block = this.interactive();
    if (block) {
      for (const part of [
        block.header,
        block.footer,
        ...(block.buttons ?? []).map((b) => b.title),
        ...(block.cta ?? []).map((c) => c.title),
        ...(block.carousel?.cards ?? []).flatMap((c) => [
          c.text,
          ...(c.buttons ?? []).map((b) => b.title),
          ...(c.cta ?? []).map((l) => l.title),
        ]),
      ]) {
        for (const k of this.fill(part ?? '').missing) keys.add(k);
      }
    }
    return [...keys];
  });

  protected readonly name = computed(
    () => this.context()['name'] || this.contactLabel() || 'Contact',
  );
  /**
   * The chat header is the recipient's view, so it names the sender. A super
   * admin acting as a tenant has no `tenant()` of their own, hence the stand-in.
   */
  protected readonly business = computed(() => this.auth.tenant()?.name || 'Your business');
  protected readonly initials = computed(() => {
    const words = this.business().trim().split(/\s+/).filter(Boolean);
    const letters = words.length
      ? words
          .slice(0, 2)
          .map((w) => w[0])
          .join('')
      : '?';
    return /\d/.test(letters) ? '#' : letters.toUpperCase();
  });

  protected readonly kind = computed(() => {
    const type = this.attachment()?.mimetype ?? '';
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    return type ? 'doc' : '';
  });

  protected readonly listRows = computed(() =>
    (this.interactive()?.list?.sections ?? []).map((s) => ({
      title: this.fill(s.title).text,
      rows: s.rows,
    })),
  );

  protected fill(text: string) {
    return substitute(text ?? '', this.context(), this.fallbacks(), this.seed());
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }
}
