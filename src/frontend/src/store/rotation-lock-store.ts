/**
 * Whether two-finger rotation is locked — session state, one for the app,
 * not persisted.
 *
 * Locked is the starting state: a pinch that turns a little (every real
 * pinch does) turns nothing, and only a deliberate turn past
 * `ROTATE_UNLOCK_DEG` unlocks it — with a toast, because a mode that
 * changes under the fingers with nothing on screen to say so reads as a
 * bug. Unlocked, the board follows the fingers at once. A double-tap with
 * two fingers locks it again and snaps to the nearest right angle (a locked
 * board is one that sits square).
 */
type Listener = () => void;

class RotationLockStore {
  private _locked = true;
  private listeners = new Set<Listener>();

  get locked(): boolean { return this._locked; }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  setLocked(locked: boolean): void {
    if (this._locked === locked) return;
    this._locked = locked;
    for (const fn of this.listeners) fn();
  }
}

export const rotationLockStore = new RotationLockStore();

if (import.meta.env.DEV && typeof window !== 'undefined') {
  (window as { __rotationLock?: RotationLockStore }).__rotationLock = rotationLockStore;
}
