import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { InteractiveDraft } from './interactive/interactive.model';
import { DraftAttachment } from './draft';
import { formatBytes, substitute } from './wa-format';

/** Tabler icon per call-to-action kind, matching what WhatsApp draws on the button. */
const CTA_ICONS = { url: 'external-link', call: 'phone', copy: 'copy' } as const;

/**
 * A WhatsApp chat mockup showing exactly what one recipient receives. It runs
 * the same substitution as the server (variables, fallbacks, seeded spintax),
 * so the bubble is the real text, not an approximation. The chat itself keeps
 * WhatsApp's own colours on purpose; only the frame follows the app theme.
 */
@Component({
  selector: 'app-phone-preview',
  templateUrl: './phone-preview.html',
  styleUrl: './phone-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhonePreview {
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
      ]) {
        for (const k of this.fill(part ?? '').missing) keys.add(k);
      }
    }
    return [...keys];
  });

  protected readonly name = computed(
    () => this.context()['name'] || this.contactLabel() || 'Contact',
  );
  protected readonly initials = computed(() => {
    const words = this.name().trim().split(/\s+/).filter(Boolean);
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
