import { Component, computed, input, output } from '@angular/core';

import { InteractiveDraft } from './interactive/interactive.model';
import { DraftAttachment } from './draft';
import { formatBytes, substitute } from './wa-format';

const CTA_ICONS = { url: 'open_in_new', call: 'call', copy: 'content_copy' } as const;

/** A WhatsApp chat mockup showing exactly what one recipient receives. */
@Component({
  selector: 'app-phone-preview',
  templateUrl: './phone-preview.html',
  styleUrl: './phone-preview.scss',
})
export class PhonePreview {
  readonly text = input('');
  readonly context = input<Record<string, string>>({});
  readonly fallbacks = input<Record<string, string>>({});
  readonly attachment = input<DraftAttachment | null>(null);
  readonly interactive = input<InteractiveDraft | null>(null);
  readonly index = input(0);
  readonly total = input(1);
  readonly contactLabel = input('');
  readonly seed = input(1);
  readonly sample = input(false);

  readonly prev = output<void>();
  readonly next = output<void>();
  readonly shuffle = output<void>();

  protected readonly ctaIcons = CTA_ICONS;
  protected readonly time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  protected readonly rendered = computed(() => substitute(this.text(), this.context(), this.fallbacks(), this.seed()));

  /** Unresolved keys in the message and in the interactive block. */
  protected readonly missing = computed(() => {
    const keys = new Set(this.rendered().missing);
    const block = this.interactive();
    if (block) {
      for (const part of [block.header, block.footer, ...(block.buttons ?? []).map((b) => b.title),
        ...(block.cta ?? []).map((c) => c.title)]) {
        for (const k of this.fill(part ?? '').missing) keys.add(k);
      }
    }
    return [...keys];
  });

  protected readonly name = computed(() => this.context()['name'] || this.contactLabel() || 'Contact');
  protected readonly initials = computed(() => {
    const words = this.name().trim().split(/\s+/).filter(Boolean);
    const letters = words.length ? words.slice(0, 2).map((w) => w[0]).join('') : '?';
    return /\d/.test(letters) ? '#' : letters.toUpperCase();
  });

  protected readonly kind = computed(() => {
    const type = this.attachment()?.mimetype ?? '';
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    return type ? 'doc' : '';
  });

  protected readonly listRows = computed(() =>
    (this.interactive()?.list?.sections ?? []).map((s) => ({ title: this.fill(s.title).text, rows: s.rows })));

  protected fill(text: string) {
    return substitute(text ?? '', this.context(), this.fallbacks(), this.seed());
  }

  protected size(bytes: number): string {
    return formatBytes(bytes);
  }
}
