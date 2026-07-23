/** Resize Mode — a direct-manipulation sizing mode.
 *
 *  When enabled, a plain click on the board no longer selects; instead the
 *  renderer classifies WHAT was clicked (text label / pin / part outline) and
 *  opens a small popup that edits the ONE global RenderSettings key that
 *  governs that element class. Changes are written to global settings and the
 *  whole board previews live (settings are reactive). Pan/zoom stay live —
 *  only the click gesture is repurposed.
 *
 *  See docs/superpowers/specs/*-resize-mode-*.md (brainstorm) for rationale.
 */
import { Emitter } from './emitter';
import { renderSettingsStore, type RenderSettings } from './render-settings';

/** The element classes the board exposes for direct resize. */
export type ResizeKind = 'text' | 'partText' | 'pin' | 'part';

export interface ResizeTargetDef {
  /** The global RenderSettings key this class edits. */
  key: keyof RenderSettings;
  /** Popup title. */
  label: string;
  /** Short unit shown next to the value. */
  unit: string;
  min: number;
  max: number;
  step: number;
  /** One-line hint under the title explaining the knob. */
  hint: string;
}

/** Class → governing setting. Each maps to the single knob that most
 *  visibly controls that element on typical boards (see brainstorm). */
export const RESIZE_TARGETS: Record<ResizeKind, ResizeTargetDef> = {
  text: {
    key: 'labelMinSize',
    label: 'Text size',
    unit: 'mils',
    min: 1,
    max: 30,
    step: 1,
    hint: 'Minimum label size — floors pin numbers and net names.',
  },
  partText: {
    key: 'partLabelScale',
    label: 'Component label size',
    unit: '×',
    min: 0.3,
    max: 4,
    step: 0.1,
    hint: 'Scales every component (part designator) label.',
  },
  pin: {
    key: 'pinSizeScale',
    label: 'Pin size',
    unit: '×',
    min: 0.3,
    max: 4,
    step: 0.1,
    hint: 'Scales the drawn radius of every pin/pad.',
  },
  part: {
    key: 'partBorderWidth',
    label: 'Part outline',
    unit: 'px',
    min: 0.1,
    max: 10,
    step: 0.1,
    hint: 'Stroke width of every part body outline.',
  },
};

export interface ResizePopupState {
  kind: ResizeKind;
  /** Page coordinates for the DOM popup. */
  pageX: number;
  pageY: number;
  /** Current live value of the governed setting. */
  value: number;
  /** Extra label context (e.g. the clicked net name / refdes) for the header. */
  context: string | null;
}

export interface ResizeModeSnapshot {
  enabled: boolean;
  popup: ResizePopupState | null;
}

function clampToStep(def: ResizeTargetDef, v: number): number {
  const clamped = Math.min(def.max, Math.max(def.min, v));
  // Snap to the step grid so the number reads cleanly (0.1 steps → no float dust).
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

  /** Stable snapshot for useSyncExternalStore. */
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
    if (!v) this._popup = null;   // leaving the mode closes any open popup
    this.rebuild();
  }

  toggle() {
    this.setEnabled(!this._enabled);
  }

  /** Open (or move) the popup for a classified click. Reads the current live
   *  value from global settings. */
  openFor(kind: ResizeKind, pageX: number, pageY: number, context: string | null = null) {
    if (!this._enabled) return;
    const def = RESIZE_TARGETS[kind];
    const value = renderSettingsStore.globalSnapshot()[def.key] as number;
    this._popup = { kind, pageX, pageY, value, context };
    this.rebuild();
  }

  close() {
    if (!this._popup) return;
    this._popup = null;
    this.rebuild();
  }

  /** Set an absolute value for the open popup's governed setting (writes
   *  global settings → whole board re-renders). */
  commit(rawValue: number) {
    const p = this._popup;
    if (!p) return;
    const def = RESIZE_TARGETS[p.kind];
    const value = clampToStep(def, rawValue);
    const current = renderSettingsStore.globalSnapshot();
    if ((current[def.key] as number) !== value) {
      renderSettingsStore.applyGlobal({ ...current, [def.key]: value });
    }
    this._popup = { ...p, value };
    this.rebuild();
  }

  /** Nudge the open popup's value by ±1 step (for +/- buttons and wheel). */
  nudge(direction: 1 | -1) {
    const p = this._popup;
    if (!p) return;
    const def = RESIZE_TARGETS[p.kind];
    this.commit(p.value + direction * def.step);
  }
}

export const resizeModeStore = new ResizeModeStore();

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __resizeModeStore?: typeof resizeModeStore }).__resizeModeStore = resizeModeStore;
}
