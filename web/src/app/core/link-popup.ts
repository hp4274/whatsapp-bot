import { ChangeDetectionStrategy, Component, ElementRef, afterNextRender, computed, effect, inject, Injector, signal, untracked, viewChild } from '@angular/core';
import { Router } from '@angular/router';

import { LinkCard } from '../connection/link-card';
import { Api, ChannelsApi } from './api';
import { Store } from './store';

/**
 * The QR popup a campaign's "Connect number" opens (campaign list, detail, island): it links each number in
 * Store.linkAsk in turn, then puts the number that was selected before back. The server links the selected
 * number, so the popup selects each one while it is up, as the WhatsApp page's Connect does.
 */
@Component({
  selector: 'app-link-popup',
  imports: [LinkCard],
  template: `
    @if (current(); as id) {
      <div class="dialog-wrap" (click)="close()">
        <div
          #box
          class="dialog"
          role="dialog"
          aria-modal="true"
          tabindex="-1"
          [attr.aria-label]="'Connect ' + nameOf(id)"
          (click)="$event.stopPropagation()"
          (keydown.escape)="close()"
        >
          <header class="pop-head">
            <span class="pop-title">
              <i class="ti ti-brand-whatsapp" aria-hidden="true"></i>{{ nameOf(id) }}
              @if (queue().length > 1) {
                <small>{{ at() + 1 }} of {{ queue().length }}</small>
              }
            </span>
            <button type="button" class="btn sm icon ghost" aria-label="Close" (click)="close()">
              <i class="ti ti-x" aria-hidden="true"></i>
            </button>
          </header>
          @for (k of [id]; track k) {
            <app-link-card [autoStart]="true" (linked)="next()" (cancelled)="close()" (recover)="recover()" />
          }
        </div>
      </div>
    }
  `,
  styleUrl: './link-popup.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LinkPopup {
  private readonly store = inject(Store);
  private readonly api = inject(Api);
  private readonly channelsApi = inject(ChannelsApi);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);

  protected readonly queue = signal<readonly number[]>([]);
  protected readonly at = signal(0);
  protected readonly current = computed(() => this.queue()[this.at()] ?? null);
  private readonly names = signal<ReadonlyMap<number, string>>(new Map());
  private readonly box = viewChild<ElementRef<HTMLElement>>('box');
  /** The number selected before the popup, put back when it closes. */
  private before: number | null = null;

  constructor() {
    effect(() => {
      const ask = this.store.linkAsk();
      if (!ask?.length) return;
      untracked(() => {
        if (!this.queue().length) this.before = this.store.channelId();
        this.queue.set(ask);
        this.at.set(0);
        this.store.useChannel(ask[0]);
        this.channelsApi.list().subscribe({
          next: ({ channels }) => this.names.set(new Map(channels.map((c) => [c.id, c.displayName]))),
          error: () => undefined,
        });
        afterNextRender(() => this.box()?.nativeElement.focus(), { injector: this.injector });
      });
    });
  }

  protected nameOf(id: number): string {
    return this.names().get(id) ?? 'Your number';
  }

  /** Linked: on to the next number, or done. */
  protected next(): void {
    const i = this.at() + 1;
    if (i >= this.queue().length) return this.finish();
    this.at.set(i);
    this.store.useChannel(this.queue()[i]);
  }

  /** Closed before linking: a code left unscanned is called off, so the number reads Not linked again. */
  protected close(): void {
    const id = this.current();
    this.finish();
    if (id !== null) this.api.cancelLink(id).subscribe({ error: () => undefined });
  }

  /** The ban card's "how to ask for a review" lives on the WhatsApp page. */
  protected recover(): void {
    this.close();
    void this.router.navigate(['/whatsapp']);
  }

  private finish(): void {
    this.queue.set([]);
    this.at.set(0);
    this.store.linkAsk.set(null);
    this.store.useChannel(this.before);
  }
}
