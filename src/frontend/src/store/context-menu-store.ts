export interface ContextMenuState {
  visible: boolean;
  screenX: number;
  screenY: number;
  componentName: string;
  /** Set when right-clicking a specific pin — enables chip+pin PDF search */
  pinId: string | null;
  /** Net name of the right-clicked pin */
  netName: string | null;
}

type Listener = () => void;

class ContextMenuStore {
  private _state: ContextMenuState = { visible: false, screenX: 0, screenY: 0, componentName: '', pinId: null, netName: null };
  private _listeners = new Set<Listener>();

  get state(): ContextMenuState {
    return this._state;
  }

  subscribe(listener: Listener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    for (const l of this._listeners) l();
  }

  show(screenX: number, screenY: number, componentName: string, pinId: string | null = null, netName: string | null = null) {
    this._state = { visible: true, screenX, screenY, componentName, pinId, netName };
    this.notify();
  }

  hide() {
    if (!this._state.visible) return;
    this._state = { ...this._state, visible: false };
    this.notify();
  }
}

export const contextMenuStore = new ContextMenuStore();
