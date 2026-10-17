import {
  ChangeDetectionStrategy,
  Component,
  type Signal,
  computed,
  input,
  linkedSignal,
} from '@angular/core';

import { TIP_WIDTH, type TipInfo, type TipPlace, tipPlacement } from './quiet-time';

/** Where a tooltip hangs, in px inside the positioned `host` it is drawn in. */
export interface TipAnchor {
  readonly x: number;
  readonly y: number;
  /** Width of `host`: the strip the tooltip is clamped to. */
  readonly w: number;
}

/** The point `frac` of the way across `el`, a little below it, in `host`'s coordinates. */
export function anchorBelow(host: Element, el: Element, frac = 0.5, gap = 8): TipAnchor {
  const h = host.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - h.left + frac * r.width, y: r.bottom - h.top + gap, w: h.width };
}

/**
 * Where the tooltip goes for an anchor that may be null (nothing hovered). The last anchor is kept
 * through the fade-out so the card does not jump to the corner while it leaves.
 */
export function tipLayout(spot: Signal<TipAnchor | null>, edge = 12) {
  const last = linkedSignal<TipAnchor | null, TipAnchor | null>({
    source: spot,
    computation: (next, prev) => next ?? prev?.value ?? null,
  });
  return {
    place: computed<TipPlace>(() => {
      const s = last();
      return tipPlacement(s?.x ?? 0, TIP_WIDTH, edge, (s?.w ?? 0) - edge);
    }),
    top: computed(() => last()?.y ?? 0),
  };
}

/**
 * True while a hover-capable pointer (or the keyboard) is on `el`. Touch browsers keep `:hover`
 * stuck on whatever was tapped, so the media query is what tells a tap from a real hover.
 */
export const isHovered = (el: Element): boolean =>
  el.matches(':focus-visible') || (matchMedia('(hover: hover)').matches && el.matches(':hover'));

/**
 * The floating card behind every quiet-time hover: token surface, soft ink shadow, no arrow.
 * It is drawn by the parent (absolutely positioned inside a `position: relative` strip) and placed
 * with `tipPlacement`; this only owns the look and the pop-in. It is `aria-hidden` because the
 * parent mirrors the same text into a live region when the keyboard drives it.
 */
@Component({
  selector: 'app-quiet-tip',
  templateUrl: './quiet-tip.html',
  styleUrl: './quiet-tip.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'aria-hidden': 'true',
    '[class.show]': 'info() !== null',
    '[attr.data-tone]': 'shown()?.tone',
    '[style.left.px]': 'place().left',
    '[style.top.px]': 'top()',
    '[style.width.px]': 'place().width',
    '[style.--ox.px]': 'place().origin',
  },
})
export class QuietTip {
  /** Null hides it. */
  readonly info = input<TipInfo | null>(null);
  readonly place = input.required<TipPlace>();
  readonly top = input(0);

  /** Holds the last text through the fade-out, so the card never empties before it is gone. */
  protected readonly shown = linkedSignal<TipInfo | null, TipInfo | null>({
    source: this.info,
    computation: (next, prev) => next ?? prev?.value ?? null,
  });
}
