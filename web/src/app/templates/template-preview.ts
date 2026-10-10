import { Component, computed, input, signal } from '@angular/core';

import { InteractiveDraft, formatWhatsApp } from './templates-api';

/** What the header shows: a local or fetched object URL, or just a kind + name. */
export interface HeaderMedia {
  kind: 'image' | 'video' | 'document';
  name: string;
  url: string | null;
}

const CTA_ICONS = { url: 'open_in_new', call: 'call', copy: 'content_copy' } as const;

/** A phone mock that renders a template the way a customer sees it. Pure display. */
@Component({
  selector: 'app-template-preview',
  templateUrl: './template-preview.html',
  styleUrl: './template-preview.scss',
})
export class TemplatePreview {
  readonly text = input('');
  readonly media = input<HeaderMedia | null>(null);
  readonly interactive = input<InteractiveDraft | null>(null);

  protected readonly ctaIcons = CTA_ICONS;
  protected readonly sheetOpen = signal(false);
  protected readonly time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  protected readonly html = computed(() => formatWhatsApp(this.text()));
}
