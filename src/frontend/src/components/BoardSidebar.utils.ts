/**
 * BoardSidebar non-component sibling — module-level focus relay for the
 * search input, plus the public `focusBoardSearchInput` entrypoint used by
 * `useKeyboardShortcuts` (Cmd/Ctrl+F when a board panel is active).
 *
 * Split out of `BoardSidebar.tsx` to satisfy `react-refresh/only-export-components`.
 */

let activeSearchInput: HTMLInputElement | null = null;
let pendingFocus = false;

/** Called by SearchTab on mount/unmount to register/unregister its input. */
export function setActiveSearchInput(el: HTMLInputElement | null): void {
  activeSearchInput = el;
  if (el && pendingFocus) {
    pendingFocus = false;
    el.focus();
    el.select();
  }
}

/** Read the currently registered search input (used by SearchTab's cleanup
 *  to confirm it's still the owner before clearing). */
export function getActiveSearchInput(): HTMLInputElement | null {
  return activeSearchInput;
}

/** Public: focus the board search input. If SearchTab isn't mounted, flag a
 *  pending focus request — the next mount will pick it up. */
export function focusBoardSearchInput(): void {
  if (activeSearchInput) {
    activeSearchInput.focus();
    activeSearchInput.select();
    return;
  }
  pendingFocus = true;
}
