import { ChangeDetectionStrategy, Component, input, model } from '@angular/core';

import { InteractivePreview } from '../campaign/interactive/interactive-preview';
import { MediaSrc } from '../campaign/interactive/media-src';
import { Interactive, Media } from './auto-replies.api';

export interface PreviewTurn {
  incoming: string;
  /** What the customer sent along (test console): a photo shows, anything else is an icon and a name. */
  attachment?: PreviewAttachment | null;
  replies: PreviewReply[];
}

export interface PreviewAttachment {
  /** A message type: image, video, audio, document, sticker, location, contact. */
  readonly type: string;
  readonly icon: string;
  readonly name: string;
  /** A local object URL for a picked photo or sticker, so it can be drawn; never uploaded. */
  readonly url: string | null;
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
 * Buttons and lists are drawn as WhatsApp's own, which is how they are sent.
 */
@Component({
  selector: 'ar-wa-preview',
  imports: [InteractivePreview, MediaSrc],
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
