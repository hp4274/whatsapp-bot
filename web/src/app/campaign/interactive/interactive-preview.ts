import { Component, computed, input, model, signal } from '@angular/core';

import { InteractiveDraft, renderFallbackText } from './interactive.model';

const CTA_ICONS = { url: 'open_in_new', call: 'call', copy: 'content_copy' } as const;

/** Escape HTML first, then apply WhatsApp *bold* and _italic_. Safe for [innerHTML]. */
export function formatWhatsApp(text: string): string {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/gm, '$1<i>$2</i>');
}

@Component({
  selector: 'app-interactive-preview',
  templateUrl: './interactive-preview.html',
  styleUrl: './interactive-preview.scss',
})
export class InteractivePreview {
  readonly interactive = input<InteractiveDraft | null>(null);
  readonly text = input<string>('');
  readonly fallback = model<boolean>(false);
  readonly showToggle = input<boolean>(true);

  protected readonly ctaIcons = CTA_ICONS;
  protected readonly sheetOpen = signal(false);
  protected readonly time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  protected readonly bodyHtml = computed(() => formatWhatsApp(String(this.text() ?? '').trim()));
  protected readonly fallbackHtml = computed(() => formatWhatsApp(renderFallbackText(this.text(), this.interactive())));
}
