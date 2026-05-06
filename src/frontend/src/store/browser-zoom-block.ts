/**
 * Block browser-level page zoom (Ctrl/Cmd+Wheel, Ctrl/Cmd +/-/0, trackpad
 * pinch, iOS Safari gestures). The board canvas and PDF viewer have their
 * own wheel listeners that handle ctrl+scroll for zooming their own view —
 * those still fire because preventDefault here only cancels the *browser's
 * default action* (page zoom), not event propagation.
 */
export function installBrowserZoomBlock(): void {
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey || e.metaKey) e.preventDefault();
  };
  window.addEventListener('wheel', onWheel, { passive: false, capture: true });

  const onKey = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === '+' || e.key === '-' || e.key === '=' || e.key === '0') {
      e.preventDefault();
    }
  };
  window.addEventListener('keydown', onKey, { capture: true });

  // Safari / iOS pinch gestures fire as 'gesture*' events, not wheel.
  // Panel handlers (PDF, board) attach gesture* listeners on their containers
  // and call stopPropagation — so this window-level block only fires for
  // gestures over non-panel chrome (toolbar, sidebar). If you see this log
  // when pinching over the PDF or board, the panel handler isn't running.
  const onGesture = (e: Event) => {
    if (import.meta.env.DEV) {
      const target = e.target as Element | null;
      // eslint-disable-next-line no-console
      console.debug('[browser-zoom-block] gesture suppressed at window', e.type, target?.tagName);
    }
    e.preventDefault();
  };
  window.addEventListener('gesturestart', onGesture, { passive: false });
  window.addEventListener('gesturechange', onGesture, { passive: false });
  window.addEventListener('gestureend', onGesture, { passive: false });
}
