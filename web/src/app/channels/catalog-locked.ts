import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  inject,
  input,
  output,
} from '@angular/core';

import type { Channel } from '../core/api';

/**
 * The catalog on a number linked from the regular WhatsApp app: WhatsApp only keeps catalogs for Business
 * accounts, so this explains how to get there instead of opening an empty drawer. Focus stays inside while
 * it is open, and Escape or the backdrop closes it.
 */
@Component({
  selector: 'app-catalog-locked',
  template: `
    <div class="dialog-wrap" (click)="closed.emit()">
      <div
        class="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="catalog-locked-title"
        aria-describedby="catalog-locked-desc"
        (click)="$event.stopPropagation()"
        (keydown)="trap($event)"
      >
        <span class="badge" aria-hidden="true"><i class="ti ti-building-store"></i></span>
        <h3 id="catalog-locked-title">Catalog needs WhatsApp Business</h3>
        <p id="catalog-locked-desc">
          A catalog shows your products with photos and prices inside WhatsApp. Customers add them to a cart and
          send the order, and it lands in your Orders. {{ channel().displayName }} is linked from the regular
          WhatsApp app, which has no catalog.
        </p>
        <ol class="steps">
          <li><span class="num">1</span>Install the free WhatsApp Business app.</li>
          <li>
            <span class="num">2</span>Move this number to it (WhatsApp Business offers to use your existing
            number), or use another number.
          </li>
          <li><span class="num">3</span>Come back here and link it again by scanning a new QR code.</li>
        </ol>
        <p class="fine">Linking again signs this number out here until the new code is scanned.</p>
        <div class="dialog-actions">
          <button class="btn" type="button" (click)="closed.emit()">Not now</button>
          <button class="btn primary" type="button" (click)="relink.emit()">
            <i class="ti ti-qrcode" aria-hidden="true"></i>Link a WhatsApp Business number
          </button>
        </div>
      </div>
    </div>
  `,
  styleUrl: './catalog-locked.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown.escape)': 'closed.emit()' },
})
export class CatalogLocked {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly channel = input.required<Channel>();
  readonly closed = output<void>();
  /** Start the QR link again for this number, the way its link card does. */
  readonly relink = output<void>();

  constructor() {
    afterNextRender(() => this.buttons()[0]?.focus());
  }

  private buttons(): HTMLButtonElement[] {
    return [...this.host.nativeElement.querySelectorAll<HTMLButtonElement>('.dialog button')];
  }

  /** Tab wraps between the two buttons, so focus cannot wander onto the page behind. */
  protected trap(event: KeyboardEvent) {
    if (event.key !== 'Tab') return;
    const list = this.buttons();
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
