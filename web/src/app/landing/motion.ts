import {
  DestroyRef,
  Directive,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  inject,
  input,
} from '@angular/core';
import { animate, inView, stagger } from 'motion';

/** Reduced motion: spatial movement is skipped; content shows in its final state and state colours still change. */
export const still = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The one spring every entrance uses: settles in about 0.7s with a hint of overshoot. */
export const SPRING = { type: 'spring', visualDuration: 0.7, bounce: 0.18 } as const;

/** Confident deceleration for authored, non-spring moves. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * The page's signature move, "one message becomes many": each item starts
 * at the centre of `source` (the template) and springs out to its own place,
 * one after another. Used by the hero campaign and the personalisation card.
 */
export function fanOut(source: Element, items: readonly Element[], delay = 0): void {
  if (still()) return;
  const from = source.getBoundingClientRect();
  const fromY = from.top + from.height / 2;
  items.forEach((el, i) => {
    const r = el.getBoundingClientRect();
    (el as HTMLElement).style.opacity = '0';
    animate(
      el,
      { opacity: [0, 1], y: [fromY - (r.top + r.height / 2), 0], scale: [0.86, 1] },
      { ...SPRING, delay: delay + i * 0.08 },
    );
  });
}

/**
 * Lists only: rises each child in turn the first time the list scrolls into
 * view. Headings are left alone, visible from the start, so the page does not
 * repeat one entrance on every section. The hidden state is written by script
 * after render, so without script or with reduced motion nothing is hidden.
 *
 * Motion leaves an inline `transform` behind, so do not put this on an element
 * whose CSS transform matters at rest (e.g. a 3D tilt); wrap those instead.
 */
@Directive({ selector: '[reveal]' })
export class Reveal {
  readonly reveal = input<'' | 'children'>('');

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (still()) return;
      const targets = this.reveal() === 'children' ? [...el.children] : [el];
      for (const t of targets as HTMLElement[]) t.style.opacity = '0';
      const stop = inView(
        el,
        () => {
          // Capped: a long list still finishes within half a second of the first item.
          animate(targets, { opacity: [0, 1], y: [24, 0] }, { ...SPRING, delay: stagger(Math.min(0.08, 0.5 / targets.length)) });
        },
        { margin: '0px 0px -12% 0px' },
      );
      destroyRef.onDestroy(stop);
    });
  }
}

/** On first view, fans the host's children out of the element matched by `fanOut` inside the same fragment. */
@Directive({ selector: '[fanOut]' })
export class FanOut {
  readonly fanOut = input.required<string>();

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const source = el.closest('[data-ui]')?.querySelector(this.fanOut());
      if (!source || still()) return;
      for (const c of el.children as HTMLCollectionOf<HTMLElement>) c.style.opacity = '0';
      const stop = inView(el, () => fanOut(source, [...el.children], 0.15), { amount: 0.6 });
      destroyRef.onDestroy(stop);
    });
  }
}

/** Counts a figure up from zero when it scrolls into view; the template's text is the no-script value. */
@Directive({ selector: '[countUp]' })
export class CountUp {
  readonly countUp = input.required<number>();

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      if (still()) return;
      const to = this.countUp();
      el.textContent = '0';
      const stop = inView(el, () => {
        animate(0, to, {
          duration: 1.6,
          ease: EASE_OUT,
          onUpdate: (v) => (el.textContent = Math.round(v).toLocaleString('en-IN')),
        });
      });
      destroyRef.onDestroy(stop);
    });
  }
}

/**
 * A segmented control's sliding highlight: the host holds a `.thumb` and
 * buttons with `aria-pressed`; whenever `segThumb` (the chosen key) changes,
 * the thumb springs under the pressed button. It is re-placed without motion
 * when the control resizes (web fonts arriving, a breakpoint).
 */
@Directive({ selector: '[segThumb]' })
export class SegThumb {
  readonly segThumb = input.required<string>();

  constructor() {
    const el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    const place = (glide: boolean) => {
      const thumb = el.querySelector<HTMLElement>('.thumb');
      const btn = el.querySelector<HTMLElement>('[aria-pressed="true"]');
      if (!thumb || !btn) return;
      const to = { x: btn.offsetLeft, width: btn.offsetWidth };
      animate(thumb, to, glide && !still() ? { type: 'spring', visualDuration: 0.35, bounce: 0.2 } : { duration: 0 });
    };
    const destroyRef = inject(DestroyRef);
    let placed = false;
    afterRenderEffect(() => {
      this.segThumb();
      place(placed);
      placed = true;
    });
    afterNextRender(() => {
      const ro = new ResizeObserver(() => place(false));
      ro.observe(el);
      destroyRef.onDestroy(() => ro.disconnect());
    });
  }
}
