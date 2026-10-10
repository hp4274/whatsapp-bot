import { ChangeDetectionStrategy, Component, computed, input, model, signal } from '@angular/core';

import { InteractiveDraft, renderFallbackText } from './interactive.model';

/** Tabler icon per call-to-action kind, matching what WhatsApp draws on the button. */
const CTA_ICONS = { url: 'external-link', call: 'phone', copy: 'copy' } as const;

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

/**
 * One incoming WhatsApp bubble with its native buttons or list sheet. The
 * toggle shows the numbered plain-text version transports without native
 * buttons send instead, so the user sees both renderings before saving.
 */
@Component({
  selector: 'app-interactive-preview',
  templateUrl: './interactive-preview.html',
  styleUrl: './interactive-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InteractivePreview {
  readonly interactive = input<InteractiveDraft | null>(null);
  readonly text = input<string>('');
  /** Two-way: show the plain-text fallback instead of native buttons. */
  readonly fallback = model<boolean>(false);
  readonly showToggle = input<boolean>(true);

  protected readonly ctaIcons = CTA_ICONS;
  protected readonly sheetOpen = signal(false);
  protected readonly time = new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  protected readonly bodyHtml = computed(() => formatWhatsApp(String(this.text() ?? '').trim()));
  protected readonly fallbackHtml = computed(() =>
    formatWhatsApp(renderFallbackText(this.text(), this.interactive())),
  );
}
