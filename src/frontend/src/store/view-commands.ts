/**
 * Simple event emitter for viewport commands.
 * The active BoardRenderer subscribes; keyboard shortcuts dispatch.
 */

export type PanDirection = 'left' | 'right' | 'up' | 'down';
export type ZoomDirection = 'in' | 'out';

/** Raw scroll-delta equivalent for one keyboard zoom step.
 *  Maps to zoom factor ≈ 1.72 via zoomAtScreen's 2^(1.3 × Δ/500) formula.
 *  Shared so the PDF viewer's keyboard-zoom step stays in lockstep
 *  with the board's. */
export const KEY_ZOOM_RAW_DELTA = 200;

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

  zoom(direction: ZoomDirection) {
    for (const l of this._listeners) l('zoom', direction);
  }
}

export const viewCommands = new ViewCommands();
