/**
 * Which board tabs show the 3D view instead of the 2D one. Session state,
 * per tab: a tab id does not survive a reload, and 3D is a look you take, not
 * a mode to come back to. See docs/specs/2026-11-14-3d-mode-design.md.
 */
type Listener = () => void;

/** What the ribbon may ask of a tab's open 3D view. Implemented by
 *  three3d/Board3DRenderer; typed here so the ribbon never imports three.js. */
export interface View3DHandle {
  view(preset: 'iso' | 'top' | 'bottom'): void;
  zoomBy(factor: number): void;
  fit(): void;
  setLeftDrag(mode: 'orbit' | 'pan'): void;
}

class View3DStore {
  private on = new Set<number>();
  private listeners = new Set<Listener>();
  private snap: ReadonlySet<number> = new Set();
  private handles = new Map<number, View3DHandle>();
  /** Per tab: what a plain left-drag does in 3D, and the last camera preset the ribbon chose. */
  private ui = new Map<number, { drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' }>();
  private uiSnap = new Map<number, { drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' }>();

  register(tabId: number, h: View3DHandle | null): void { if (h) this.handles.set(tabId, h); else this.handles.delete(tabId); }
  handle(tabId: number): View3DHandle | undefined { return this.handles.get(tabId); }
  uiOf(tabId: number): { drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' } { return this.uiSnap.get(tabId) ?? DEFAULT_UI; }
  setDrag(tabId: number, drag: 'orbit' | 'pan'): void { this.patchUi(tabId, { drag }); this.handles.get(tabId)?.setLeftDrag(drag); }
  setPreset(tabId: number, preset: 'iso' | 'top' | 'bottom'): void { this.patchUi(tabId, { preset }); this.handles.get(tabId)?.view(preset); }
  private patchUi(tabId: number, p: Partial<{ drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' }>): void {
    const next = { ...(this.ui.get(tabId) ?? DEFAULT_UI), ...p }; this.ui.set(tabId, next);
    this.uiSnap = new Map(this.ui); this.snap = new Set(this.on); this.listeners.forEach(l => l());
  }

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

const DEFAULT_UI = { drag: 'orbit' as const, preset: 'iso' as const };
export const view3dStore = new View3DStore();
