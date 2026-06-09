import { Emitter } from './emitter';
import { useSyncExternalStore } from 'react';

/**
 * Tiny store driving the "you're peeking — release to revert" chip that
 * appears after Space-flip's hold threshold trips. Kept separate from
 * boardStore so the hint can render even when the active panel isn't a
 * board (an edge case: the user pressed Space over the canvas then moved
 * focus before releasing).
 *
 * State machine: idle → showing → idle
 *   show()  — chip becomes visible (the keyboard handler calls this once
 *             the press crosses SPACE_HOLD_PEEK_MS)
 *   hide()  — chip disappears (keyup or window blur)
 */
class PeekHintStore extends Emitter {
  private _visible = false;
  get visible(): boolean { return this._visible; }
  show() {
    if (this._visible) return;
    this._visible = true;
    this.notify();
  }
  hide() {
    if (!this._visible) return;
    this._visible = false;
    this.notify();
  }
}

export const peekHintStore = new PeekHintStore();

export function usePeekHintVisible(): boolean {
  return useSyncExternalStore(
    (l) => peekHintStore.subscribe(l),
    () => peekHintStore.visible,
    () => peekHintStore.visible,
  );
}
