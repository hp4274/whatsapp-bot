import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';

import { InboxApi, ThreadMedia } from './inbox-api';

/**
 * One attachment inside a bubble. Files are behind the bearer token, so they
 * are fetched as blobs and shown through object URLs (revoked on destroy).
 */
@Component({
  selector: 'app-inbox-media',
  template: `
    @let m = media();
    @if (!m.url) {
      <span class="file in"
        ><i class="ti ti-{{ icon() }}" aria-hidden="true"></i>{{ label() }} received</span
      >
    } @else if (kind() === 'image' && src()) {
      <a
        class="thumb"
        [href]="src()"
        target="_blank"
        rel="noopener"
        [attr.aria-label]="'Open image ' + m.filename"
      >
        <img [src]="src()" [alt]="m.filename || 'Image'" loading="lazy" />
      </a>
    } @else if (kind() === 'video' && src()) {
      <video
        [src]="src()"
        controls
        preload="metadata"
        [attr.aria-label]="m.filename || 'Video'"
      ></video>
    } @else {
      <button type="button" class="file" (click)="download()" [disabled]="state() === 'loading'">
        <i class="ti ti-{{ state() === 'error' ? 'alert-circle' : icon() }}" aria-hidden="true"></i>
        <span class="nm">{{ m.filename || label() }}</span>
        @if (state() === 'loading') {
          <span class="spinner"></span>
        } @else {
          <i class="ti ti-download dl" aria-hidden="true"></i>
        }
      </button>
    }
  `,
  styles: `
    :host {
      display: block;
      margin: 2px 0 6px;
    }
    .thumb {
      display: block;
      border-radius: 10px;
      overflow: hidden;
      line-height: 0;
    }
    img,
    video {
      display: block;
      max-width: min(280px, 100%);
      max-height: 260px;
      border-radius: 10px;
      object-fit: cover;
      background: var(--surface-sunken);
    }
    .thumb img {
      transition: transform var(--base) var(--ease);
    }
    .thumb:hover img {
      transform: scale(1.03);
    }
    .file {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      max-width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--border-color);
      border-radius: 10px;
      background: color-mix(in srgb, var(--surface-card) 70%, transparent);
      color: var(--text-strong);
      font-size: 12.5px;
      font-weight: 500;
      transition: border-color var(--fast) var(--ease);
    }
    button.file {
      cursor: pointer;
    }
    button.file:hover:not(:disabled) {
      border-color: var(--border-hover);
    }
    .file.in {
      color: var(--text-muted);
      font-weight: 500;
    }
    .nm {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .dl {
      font-size: 17px;
      color: var(--hint);
    }
    @media (prefers-reduced-motion: reduce) {
      .thumb img {
        transition: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InboxMedia {
  private readonly api = inject(InboxApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly media = input.required<ThreadMedia>();

  protected readonly kind = computed(() => kindOf(this.media().mimetype));
  protected readonly icon = computed(
    () =>
      ({ image: 'photo', video: 'movie', pdf: 'file-type-pdf', file: 'paperclip' })[this.kind()],
  );
  protected readonly label = computed(
    () => ({ image: 'Image', video: 'Video', pdf: 'PDF', file: 'File' })[this.kind()],
  );
  protected readonly src = signal<string | null>(null);
  protected readonly state = signal<'idle' | 'loading' | 'error'>('idle');

  /** URL already fetched, so live re-renders of the same message do not refetch it. */
  private loaded: string | null = null;

  constructor() {
    this.destroyRef.onDestroy(() => this.revoke());
    effect(() => {
      const m = this.media();
      // The thread is re-fetched on every live tick with fresh objects; fetch each file once.
      if (!m.url || m.url === this.loaded) return;
      this.loaded = m.url;
      if (this.kind() === 'image' || this.kind() === 'video') this.fetch(m.url);
    });
  }

  protected download() {
    const m = this.media();
    if (!m.url) return;
    if (this.src()) return this.save();
    this.fetch(m.url, () => this.save());
  }

  private fetch(url: string, then?: () => void) {
    this.state.set('loading');
    this.api.mediaBlob(url).subscribe({
      next: (blob) => {
        this.revoke();
        this.src.set(URL.createObjectURL(blob));
        this.state.set('idle');
        then?.();
      },
      error: () => this.state.set('error'),
    });
  }

  private save() {
    const a = document.createElement('a');
    a.href = this.src()!;
    a.download = this.media().filename || 'attachment';
    a.click();
  }

  private revoke() {
    const url = this.src();
    if (url) URL.revokeObjectURL(url);
  }
}

/** The four ways an attachment is shown; also used by the composer's preview. */
export function kindOf(mimetype: string): 'image' | 'video' | 'pdf' | 'file' {
  if (mimetype.startsWith('image/')) return 'image';
  if (mimetype.startsWith('video/')) return 'video';
  if (mimetype === 'application/pdf') return 'pdf';
  return 'file';
}
