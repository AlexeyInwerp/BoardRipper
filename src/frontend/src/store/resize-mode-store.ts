/** Resize Mode — direct-manipulation sizing.
 *
 *  When enabled, a plain click on the board opens a popup with the handles
 *  relevant to WHAT was clicked, each editing one global RenderSettings key
 *  live (the whole board previews as settings are reactive). Pan/zoom stay
 *  live — only the click gesture is repurposed.
 *
 *  A click classifies into a "group"; each group shows a set of controls:
 *    - pin (or a pin-number / net-name label) → pin size, pin number size,
 *      net label size
 *    - component label / part body → component label size, part outline
 *    - empty board area → board transparency
 */
import { Emitter } from './emitter';
import { renderSettingsStore, DEFAULTS, type RenderSettings } from './render-settings';

/** What the click landed on → which control group to show. */
export type ResizeGroup = 'pin' | 'part' | 'board';

/** A single editable control (one RenderSettings key). */
export interface ResizeControlDef {
  key: keyof RenderSettings;
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  /** One-line description shown under the control. */
  hint: string;
}

/** Registry of every control Resize Mode can show, keyed by setting key. */
export const CONTROLS: Record<string, ResizeControlDef> = {
  pinSizeScale:    { key: 'pinSizeScale',    label: 'Pin size',        unit: '×',  min: 0.3, max: 4,  step: 0.1, hint: 'Drawn radius of every pin & pad.' },
  pinNumberScale:  { key: 'pinNumberScale',  label: 'Pin number size', unit: '×',  min: 0.3, max: 4,  step: 0.1, hint: 'Size of the pin-number text.' },
  netLabelScale:   { key: 'netLabelScale',   label: 'Net label size',  unit: '×',  min: 0.3, max: 4,  step: 0.1, hint: 'Size of the net-name text on pins.' },
  partLabelScale:  { key: 'partLabelScale',  label: 'Component label',  unit: '×', min: 0.3, max: 4,  step: 0.1, hint: 'Size of component (designator) labels.' },
  partBorderWidth: { key: 'partBorderWidth', label: 'Part outline',    unit: 'px', min: 0.1, max: 10, step: 0.1, hint: 'Stroke thickness of part outlines.' },
  boardFillAlpha:  { key: 'boardFillAlpha',  label: 'Board opacity',   unit: '',   min: 0,   max: 1,  step: 0.05, hint: 'Opacity of the board fill (0 = transparent).' },
  selectedLabelMinPx: { key: 'selectedLabelMinPx', label: 'Selected label floor', unit: 'px', min: 0, max: 30, step: 1, hint: 'Min on-screen size for a selected part’s labels.' },
  selectedLabelLodRelax: { key: 'selectedLabelLodRelax', label: 'Selected label LOD', unit: '×', min: 0.1, max: 1, step: 0.05, hint: 'Lower = selected labels stay visible when zoomed out further.' },
};

/** Group → the ordered list of control keys it shows. */
export const GROUPS: Record<ResizeGroup, (keyof RenderSettings)[]> = {
  pin:   ['pinSizeScale', 'pinNumberScale', 'netLabelScale', 'selectedLabelMinPx', 'selectedLabelLodRelax'],
  part:  ['partLabelScale', 'partBorderWidth', 'selectedLabelMinPx', 'selectedLabelLodRelax'],
  board: ['boardFillAlpha'],
};

const GROUP_TITLE: Record<ResizeGroup, string> = {
  pin: 'Pin',
  part: 'Component',
  board: 'Board',
};

export interface ResizePopupState {
  group: ResizeGroup;
  title: string;
  keys: (keyof RenderSettings)[];
  pageX: number;
  pageY: number;
  context: string | null;
}

export interface ResizeModeSnapshot {
  enabled: boolean;
  popup: ResizePopupState | null;
}

function clampToStep(def: ResizeControlDef, v: number): number {
  const clamped = Math.min(def.max, Math.max(def.min, v));
  const snapped = Math.round(clamped / def.step) * def.step;
  return Math.round(snapped * 1000) / 1000;
}

class ResizeModeStore extends Emitter {
  private _enabled = false;
  private _popup: ResizePopupState | null = null;
  private _snapshot: ResizeModeSnapshot = { enabled: false, popup: null };

  get enabled(): boolean {
    return this._enabled;
  }

  snapshot(): ResizeModeSnapshot {
    return this._snapshot;
  }

  private rebuild() {
    this._snapshot = { enabled: this._enabled, popup: this._popup };
    this.notify();
  }

  setEnabled(v: boolean) {
    if (this._enabled === v) return;
    this._enabled = v;
    if (!v) this._popup = null;
    this.rebuild();
  }

  toggle() {
    this.setEnabled(!this._enabled);
  }

  /** Open the popup for a classified click group at the cursor. */
  openGroup(group: ResizeGroup, pageX: number, pageY: number, context: string | null = null) {
    if (!this._enabled) return;
    this._popup = { group, title: GROUP_TITLE[group], keys: GROUPS[group], pageX, pageY, context };
    this.rebuild();
  }

  close() {
    if (!this._popup) return;
    this._popup = null;
    this.rebuild();
  }

  /** Live value of a control's governed setting (global). */
  valueOf(key: keyof RenderSettings): number {
    return renderSettingsStore.globalSnapshot()[key] as number;
  }

  /** Set an absolute value for one control (writes global settings → board
   *  re-renders). */
  commit(key: keyof RenderSettings, rawValue: number) {
    const def = CONTROLS[key as string];
    if (!def) return;
    const value = clampToStep(def, rawValue);
    const current = renderSettingsStore.globalSnapshot();
    if ((current[key] as number) !== value) {
      renderSettingsStore.applyGlobal({ ...current, [key]: value });
      this.rebuild();   // reflect the new live value in the popup readout
    }
  }

  /** Nudge one control by ±1 step (buttons / wheel). */
  nudge(key: keyof RenderSettings, direction: 1 | -1) {
    const def = CONTROLS[key as string];
    if (!def) return;
    this.commit(key, this.valueOf(key) + direction * def.step);
  }

  /** Reset one control to its compile-time default (double-click). */
  reset(key: keyof RenderSettings) {
    this.commit(key, DEFAULTS[key] as number);
  }
}

export const resizeModeStore = new ResizeModeStore();

// Singleton shared between BoardRenderer (captured at module load) and the
// React UI. Hot-swapping desyncs those references, so force a full reload.
if (import.meta.hot) {
  import.meta.hot.accept(() => import.meta.hot!.invalidate());
}

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __resizeModeStore?: typeof resizeModeStore }).__resizeModeStore = resizeModeStore;
}
