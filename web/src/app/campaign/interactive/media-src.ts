import { HttpClient } from '@angular/common/http';
import { DestroyRef, Directive, ElementRef, effect, inject, input } from '@angular/core';

/**
 * `<img [mediaSrc]="card.mediaUrl">`: shows an uploaded image from `/api/media/:id`.
 * That route needs the bearer token and tenant headers, which a plain `src` never
 * sends, so the bytes come through HttpClient (the auth interceptor) as a blob URL.
 */
@Directive({ selector: 'img[mediaSrc]' })
export class MediaSrc {
  readonly mediaSrc = input<string | null | undefined>('');

  private readonly img = inject<ElementRef<HTMLImageElement>>(ElementRef).nativeElement;
  private readonly http = inject(HttpClient);
  private blobUrl = '';

  constructor() {
    effect((onCleanup) => {
      const url = this.mediaSrc();
      if (!url) return;
      const sub = this.http.get(url, { responseType: 'blob' }).subscribe({
        next: (blob) => {
          this.revoke();
          this.blobUrl = URL.createObjectURL(blob);
          this.img.src = this.blobUrl;
        },
        // A missing file just leaves the image empty; the card still shows its text.
        error: () => this.img.removeAttribute('src'),
      });
      onCleanup(() => sub.unsubscribe());
    });
    inject(DestroyRef).onDestroy(() => this.revoke());
  }

  private revoke() {
    if (this.blobUrl) URL.revokeObjectURL(this.blobUrl);
    this.blobUrl = '';
  }
}
