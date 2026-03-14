/**
 * Simple event emitter for viewport commands.
 * The active BoardRenderer subscribes; keyboard shortcuts dispatch.
 */

export type PanDirection = 'left' | 'right' | 'up' | 'down';

type ViewCommandListener = (command: string, payload?: unknown) => void;

class ViewCommands {
  private _listeners = new Set<ViewCommandListener>();

  subscribe(listener: ViewCommandListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  pan(direction: PanDirection) {
    for (const l of this._listeners) l('pan', direction);
  }
}

export const viewCommands = new ViewCommands();
