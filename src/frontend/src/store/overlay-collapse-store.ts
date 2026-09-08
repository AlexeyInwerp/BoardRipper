/**
 * Whether the board panel's overlay control bar (mode switcher, spotlight,
 * parts/nets filters …) is rolled up into its left-edge handle. One value for
 * every board tab, persisted, like the rest of the overlay layout.
 */
import { Emitter } from './emitter';
import { createStoreHook } from '../hooks/createStoreHook';

const KEY = 'boardripper-overlay-collapsed';

class OverlayCollapseStore extends Emitter {
  private _collapsed: boolean;

  constructor() {
    super();
    let v: string | null = null;
    try { v = localStorage.getItem(KEY); } catch { /* no storage */ }
    this._collapsed = v === 'true';
  }

  get collapsed(): boolean { return this._collapsed; }

  set(v: boolean): void {
    if (this._collapsed === v) return;
    this._collapsed = v;
    try { localStorage.setItem(KEY, String(v)); } catch { /* no storage */ }
    this.notify();
  }

  toggle(): void { this.set(!this._collapsed); }
}

export const overlayCollapseStore = new OverlayCollapseStore();

export const useOverlayCollapsed = createStoreHook(overlayCollapseStore, () => overlayCollapseStore.collapsed);

export function toggleOverlayCollapsed(): void { overlayCollapseStore.toggle(); }
