/** @layer utils */

/* -------------------------------------------- */
/*  Horizontal Scrolling                        */
/* -------------------------------------------- */

/**
 * Let a vertical mouse wheel scroll a horizontally-overflowing element.
 *
 * Browsers map the wheel to horizontal scrolling only for trackpads and shift+wheel, so a single-row strip that
 * scrolls sideways is otherwise unreachable with a plain mouse.
 *
 * Idempotent per element, and inert while the element fits or while Ctrl is held, so neither a page zoom nor the
 * scroll of whatever sits behind it is swallowed.
 * @param {HTMLElement} el        An element that scrolls on its x axis.
 * @returns {void}
 */
export function wireHorizontalWheelScroll(el) {
  if (!el || el._horizontalWheelScrollWired) return;
  el._horizontalWheelScrollWired = true;
  el.addEventListener('wheel', (event) => {
    if (event.ctrlKey) return;
    if (el.scrollWidth <= el.clientWidth) return;
    const delta = Math.abs(event.deltaY) > Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    el.scrollLeft += delta;
  }, { passive: false });
}
