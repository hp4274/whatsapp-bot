// Scrolling that stays inside the page. The shell is one viewport and only
// `main.page` scrolls; `focus()` and `scrollIntoView()` would also scroll the
// clipped shell and the document, shoving the whole layout up. These scroll
// the page alone.

const page = (el: Element): HTMLElement | null => el.closest<HTMLElement>('main.page');

const behaviour = (): ScrollBehavior =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/** Scroll `main.page` so `el`'s top sits at the top of the page. */
export function scrollToTop(el: Element, gap = 16): void {
  const scroller = page(el);
  if (!scroller) return;
  const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTo({ top: scroller.scrollTop + top - gap, behavior: behaviour() });
}

/** Scroll `main.page` just enough to show `el`, if it is out of view. */
export function scrollIntoPage(el: Element, gap = 16): void {
  const scroller = page(el);
  if (!scroller) return;
  const box = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (box.top < view.top) scroller.scrollBy({ top: box.top - view.top - gap });
  else if (box.bottom > view.bottom)
    scroller.scrollBy({ top: Math.min(box.bottom - view.bottom + gap, box.top - view.top - gap) });
}

/** Focus without scrolling the shell or the document; bring it into view in the page. */
export function focusInPage(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  scrollIntoPage(el);
}
