/**
 * Which board tabs show the 3D view instead of the 2D one. Session state,
 * per tab: a tab id does not survive a reload, and 3D is a look you take, not
 * a mode to come back to. See docs/specs/2026-11-14-3d-mode-design.md.
 */
type Listener = () => void;

class View3DStore {
  private on = new Set<number>();
  private listeners = new Set<Listener>();
  private snap: ReadonlySet<number> = new Set();

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  snapshot(): ReadonlySet<number> { return this.snap; }
  isOn(tabId: number): boolean { return this.on.has(tabId); }
  toggle(tabId: number): void { this.set(tabId, !this.on.has(tabId)); }
  set(tabId: number, on: boolean): void {
    if (on === this.on.has(tabId)) return;
    if (on) this.on.add(tabId); else this.on.delete(tabId);
    this.snap = new Set(this.on);
    this.listeners.forEach(l => l());
  }
}

export const view3dStore = new View3DStore();
