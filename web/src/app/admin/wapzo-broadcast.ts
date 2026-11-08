import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, input, output, signal, viewChild } from '@angular/core';

import { ConfirmDialog } from '../core/confirm-dialog';
import { AudiencePicker, insertWord } from './audience-picker';
import { WapzoApi, WapzoBroadcastResult } from './wapzo-api';

/** The image beside the text: uploaded at once, shown from the file the admin picked. */
interface Attachment {
  readonly name: string;
  readonly preview: string;
  readonly mediaId: string | null;
}

/** The words a message to many fills in, per business (server app.js /wapzo/broadcast). */
const WORDS: readonly string[] = ['name', 'business'];

/**
 * One message from the Wuzie number to many people: every business, the ones picked, or numbers typed in. It
 * queues as bulk traffic on the server, so it goes out paced like a bulk send.
 */
@Component({
  selector: 'app-wapzo-broadcast',
  imports: [AudiencePicker, ConfirmDialog],
  templateUrl: './wapzo-broadcast.html',
  styleUrl: './wapzo-broadcast.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WapzoBroadcast {
  private readonly api = inject(WapzoApi);

  /** Sending needs the number linked. */
  readonly linked = input(false);
  /** Queued: the page reloads its log. */
  readonly sent = output<void>();

  protected readonly picker = viewChild.required(AudiencePicker);
  protected readonly words = WORDS;
  protected readonly text = signal('');
  protected readonly busy = signal(false);
  protected readonly confirming = signal(false);
  protected readonly error = signal('');
  protected readonly result = signal<WapzoBroadcastResult | null>(null);
  protected readonly image = signal<Attachment | null>(null);
  protected readonly uploading = computed(() => !!this.image() && !this.image()!.mediaId);

  /** As near as the page can fill it: the owner's name is not in the list, so {name} stays for the server to fill. */
  protected readonly preview = computed(() => this.text().replace(/\{business\}/g, this.picker().choice().first || '{business}').trim());
  protected readonly ready = computed(
    () => this.linked() && !this.busy() && !this.uploading() && (!!this.text().trim() || !!this.image()) && this.picker().choice().count > 0,
  );

  constructor() {
    inject(DestroyRef).onDestroy(() => this.dropImage());
  }

  protected insert(box: HTMLTextAreaElement, word: string): void {
    this.text.set(insertWord(box, word));
  }

  /** Images only: WhatsApp shows them in the chat with the text as their caption. */
  protected attach(box: HTMLInputElement): void {
    const file = box.files?.[0];
    box.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.error.set('Choose an image (JPG, PNG or WebP).');
      return;
    }
    this.dropImage();
    this.error.set('');
    const preview = URL.createObjectURL(file);
    this.image.set({ name: file.name, preview, mediaId: null });
    this.api.uploadImage(file).subscribe({
      next: ({ mediaId }) => {
        if (this.image()?.preview === preview) this.image.set({ name: file.name, preview, mediaId });
      },
      error: (err: Error) => {
        if (this.image()?.preview === preview) this.dropImage();
        this.error.set(err.message);
      },
    });
  }

  protected dropImage(): void {
    const image = this.image();
    if (image) URL.revokeObjectURL(image.preview);
    this.image.set(null);
  }

  protected send(): void {
    this.confirming.set(false);
    this.busy.set(true);
    this.error.set('');
    this.result.set(null);
    const choice = this.picker().choice();
    this.api
      .broadcast({
        text: this.text().trim(),
        tenants: choice.tenants,
        leads: choice.leads,
        numbers: choice.typed,
        mediaId: this.image()?.mediaId ?? null,
      })
      .subscribe({
        next: (result) => {
          this.busy.set(false);
          this.result.set(result);
          if (result.queued) {
            this.text.set('');
            this.dropImage();
          }
          this.sent.emit();
        },
        error: (err: Error) => {
          this.busy.set(false);
          this.error.set(err.message);
        },
      });
  }
}
