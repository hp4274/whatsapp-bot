import { Directive, ElementRef, inject, input } from '@angular/core';

/**
 * `<div class="s-card" schoolTilt>` or `[schoolTilt]="4"` (max degrees, default 6).
 * Writes --rx / --ry (rotation) and --mx / --my (pointer position, 0-100%) on the
 * host; `.s-tilt` from school-shared.scss turns them into a perspective rotate.
 * Mouse/pen only, and inert under prefers-reduced-motion.
 */
@Directive({
  selector: '[schoolTilt]',
  host: {
    class: 's-tilt',
    '(pointermove)': 'move($event)',
    '(pointerleave)': 'reset()',
  },
})
export class Tilt {
  readonly schoolTilt = input(6, { transform: (v: unknown) => Number(v) || 6 });

  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  protected move(e: PointerEvent) {
    if (this.still || e.pointerType === 'touch') return;
    const r = this.el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    const max = this.schoolTilt();
    const s = this.el.style;
    s.setProperty('--rx', `${(-y * 2 * max).toFixed(2)}deg`);
    s.setProperty('--ry', `${(x * 2 * max).toFixed(2)}deg`);
    s.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
    s.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
  }

  protected reset() {
    for (const k of ['--rx', '--ry', '--mx', '--my']) this.el.style.removeProperty(k);
  }
}
