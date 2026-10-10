import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

import { InteractivePreview } from '../campaign/interactive/interactive-preview';
import { Interactive, Media } from './auto-replies.api';

export interface PreviewTurn {
  incoming: string;
  replies: PreviewReply[];
}

export interface PreviewReply {
  text: string;
  media: Media | null;
  interactive: Interactive | null;
  label?: string;
}

/**
 * WhatsApp chat mock: optional phone frame (with a pointer-driven 3D tilt),
 * customer bubble, bot replies. The chat deliberately uses WhatsApp's own
 * colours, not the app tokens, so what you preview is what the customer sees.
 */
@Component({
  selector: 'ar-wa-preview',
  imports: [InteractivePreview],
  templateUrl: './wa-preview.html',
  styleUrl: './wa-preview.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WaPreview {
  readonly turns = input<PreviewTurn[]>([]);
  readonly showToggle = input(true);
  readonly framed = input(true);
  readonly title = input('Your business');
  /** Render interactive replies as WhatsApp Web's numbered-text fallback. */
  readonly fallback = model(false);

  protected isImage(m: Media): boolean {
    return (m.mimetype ?? '').startsWith('image/');
  }

  protected icon(m: Media): string {
    const t = m.mimetype ?? '';
    return t.startsWith('video/')
      ? 'movie'
      : t.startsWith('audio/')
        ? 'wave-sine'
        : t.includes('pdf')
          ? 'file-type-pdf'
          : 'file-text';
  }

  protected tilt(e: PointerEvent): void {
    if (
      !this.framed() ||
      e.pointerType === 'touch' ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--px', ((e.clientX - r.left) / r.width - 0.5).toFixed(3));
    el.style.setProperty('--py', ((e.clientY - r.top) / r.height - 0.5).toFixed(3));
  }

  protected untilt(e: PointerEvent): void {
    const el = e.currentTarget as HTMLElement;
    el.style.removeProperty('--px');
    el.style.removeProperty('--py');
  }
}
