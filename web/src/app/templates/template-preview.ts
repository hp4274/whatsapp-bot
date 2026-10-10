import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';

import { InteractiveDraft, formatWhatsApp } from './templates-api';

/** What the header shows: a local or fetched object URL, or just a kind + name. */
export interface HeaderMedia {
  kind: 'image' | 'video' | 'document';
  name: string;
  url: string | null;
}

/** Tabler icon per call-to-action kind, matching the glyphs WhatsApp shows. */
const CTA_ICONS = { url: 'external-link', call: 'phone', copy: 'copy' } as const;

/**
 * A phone mock that renders a template the way a customer sees it. Pure
 * display; the chat uses WhatsApp's own colours on purpose, only the frame
 * around it follows the app theme.
 */
@Component({
  selector: 'app-template-preview',
  templateUrl: './template-preview.html',
  styleUrl: './template-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatePreview {
  readonly text = input('');
  readonly media = input<HeaderMedia | null>(null);
  readonly interactive = input<InteractiveDraft | null>(null);

  protected readonly ctaIcons = CTA_ICONS;
  protected readonly sheetOpen = signal(false);
  /** Fixed at creation: a ticking clock would re-render the bubble for nothing. */
  protected readonly time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
  protected readonly html = computed(() => formatWhatsApp(this.text()));
}
