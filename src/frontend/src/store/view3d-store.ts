/**
 * The 3D view's state outside the renderer: which board tabs show it (session,
 * per tab — a tab id does not survive a reload, and 3D is a look you take, not a
 * mode to come back to), each tab's drag mode and camera preset, and the visual
 * settings, which are global and persisted (`boardripper-view3d`). See
 * docs/specs/2026-11-14-3d-mode-design.md.
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

/** Colours a board never has (its mask is dark green, lands gold, bodies tan /
 *  black / grey, names white), so the selection reads at a glance. */
export const SEL_COLOURS = {
  cyan: 0x00e5ff, lime: 0xc8ff3a, magenta: 0xff2bd6, orange: 0xff8a1f, violet: 0xa66bff, white: 0xffffff,
} as const;
export type SelColour = keyof typeof SEL_COLOURS;

export type View3DQuality = 'quality' | 'balanced' | 'fast';

export interface View3DSettings {
  /** Render quality: target sizes, multisampling and shadows — see QUALITY_PRESETS. */
  quality: View3DQuality;
  /** The lit net: lands, part outlines, markers under bodies, net lines. */
  netColour: SelColour;
  /** The picked pin: its land and the ring that finds it from any distance. */
  pinColour: SelColour;
  /** The selected part's outline. */
  partColour: SelColour;
  /** Reference designators on the bodies. */
  partNames: boolean;
  /** Net names on the lands, readable only close up (they fade in with size). */
  netNames: boolean;
  /** Large bodies fade when the camera comes close, showing the lands under them. */
  seeThrough: boolean;
  shadows: boolean;
  /** Screen size of the picked-pin ring and the net markers, px. */
  markerPx: number;
  /** Screen width of the selection outlines, px. */
  outlinePx: number;
  /** Draw every copper layer as geometry in the Layers tab's colours (the outer faces keep their mask texture underneath). */
  copperLayers: boolean;
  /** The board's dielectric and faces go translucent so the inner layers show. */
  xray: boolean;
  /** 0 = the real stack, 1 = the layers pulled apart (parts ride on the outer faces). */
  explode: number;
  /** The component bodies: solid, ghosted (mostly transparent, so they do not mix with the copper) or hidden. */
  parts: 'solid' | 'ghost' | 'off';
}

/** What each quality preset sets. `settledPr` caps the full-resolution frame's pixel ratio;
 *  `movingScale` is the moving target's size as a fraction of 1×. Multisampling on the moving
 *  target is what keeps sub-pixel lands visible while the board turns (4× costs nothing at 1×). */
export const QUALITY_PRESETS: Record<View3DQuality, { settledPr: number; settledSamples: number; movingFull: boolean; movingScale: number; movingSamples: number; shadows: boolean; label: string; hint: string }> = {
  // Quality moves at full resolution too: a sub-pixel land can miss every sample of a smaller target and flicker
  quality:  { settledPr: 2,   settledSamples: 4, movingFull: true,  movingScale: 1,    movingSamples: 4, shadows: true,  label: 'Quality',  hint: 'full resolution always, 4× smoothing, shadows' },
  balanced: { settledPr: 2,   settledSamples: 4, movingFull: false, movingScale: 1,    movingSamples: 4, shadows: true,  label: 'Balanced', hint: 'full resolution when still, 1× while moving' },
  fast:     { settledPr: 1.5, settledSamples: 2, movingFull: false, movingScale: 0.5,  movingSamples: 2, shadows: false, label: 'Fast',     hint: '1.5× when still, ½ while moving, no shadows' },
};

export const DEFAULT_VIEW3D_SETTINGS: View3DSettings = {
  copperLayers: false, xray: false, explode: 0, parts: 'solid',
  quality: 'quality',
  netColour: 'cyan', pinColour: 'lime', partColour: 'violet',
  partNames: true, netNames: true, seeThrough: true, shadows: true,
  markerPx: 14, outlinePx: 2.5,
};
const KEY = 'boardripper-view3d';

class View3DStore {
  private on = new Set<number>();
  private listeners = new Set<Listener>();
  private snap: ReadonlySet<number> = new Set();
  private handles = new Map<number, View3DHandle>();
  /** Per tab: what a plain left-drag does in 3D, and the last camera preset the ribbon chose. */
  private ui = new Map<number, { drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' }>();
  private uiSnap = new Map<number, { drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' }>();
  private _settings: View3DSettings = loadSettings();

  register(tabId: number, h: View3DHandle | null): void { if (h) this.handles.set(tabId, h); else this.handles.delete(tabId); }
  handle(tabId: number): View3DHandle | undefined { return this.handles.get(tabId); }
  uiOf(tabId: number): { drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' } { return this.uiSnap.get(tabId) ?? DEFAULT_UI; }
  setDrag(tabId: number, drag: 'orbit' | 'pan'): void { this.patchUi(tabId, { drag }); this.handles.get(tabId)?.setLeftDrag(drag); }
  setPreset(tabId: number, preset: 'iso' | 'top' | 'bottom'): void { this.patchUi(tabId, { preset }); this.handles.get(tabId)?.view(preset); }
  private patchUi(tabId: number, p: Partial<{ drag: 'orbit' | 'pan'; preset: 'iso' | 'top' | 'bottom' }>): void {
    const next = { ...(this.ui.get(tabId) ?? DEFAULT_UI), ...p }; this.ui.set(tabId, next);
    this.uiSnap = new Map(this.ui); this.notify();
  }

  get settings(): View3DSettings { return this._settings; }
  setSettings(p: Partial<View3DSettings>): void {
    this._settings = { ...this._settings, ...p };
    try { localStorage.setItem(KEY, JSON.stringify(this._settings)); } catch { /* private mode, quota */ }
    this.notify();
  }
  resetSettings(): void { this.setSettings(DEFAULT_VIEW3D_SETTINGS); }

  subscribe(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  snapshot(): ReadonlySet<number> { return this.snap; }
  isOn(tabId: number): boolean { return this.on.has(tabId); }
  toggle(tabId: number): void { this.set(tabId, !this.on.has(tabId)); }
  set(tabId: number, on: boolean): void {
    if (on === this.on.has(tabId)) return;
    if (on) this.on.add(tabId); else this.on.delete(tabId);
    this.notify();
  }
  private notify(): void { this.snap = new Set(this.on); this.listeners.forEach(l => l()); }
}

function loadSettings(): View3DSettings {
  try {
    const raw = localStorage.getItem(KEY); if (!raw) return DEFAULT_VIEW3D_SETTINGS;
    const p = JSON.parse(raw) as Partial<View3DSettings>, s = { ...DEFAULT_VIEW3D_SETTINGS, ...p };
    for (const k of ['netColour', 'pinColour', 'partColour'] as const) if (!(s[k] in SEL_COLOURS)) s[k] = DEFAULT_VIEW3D_SETTINGS[k];
    if (!(s.quality in QUALITY_PRESETS)) s.quality = DEFAULT_VIEW3D_SETTINGS.quality;
    s.markerPx = clamp(s.markerPx, 6, 40, DEFAULT_VIEW3D_SETTINGS.markerPx); s.outlinePx = clamp(s.outlinePx, 1, 8, DEFAULT_VIEW3D_SETTINGS.outlinePx);
    s.explode = clamp(s.explode, 0, 1, 0); s.copperLayers = s.copperLayers === true; s.xray = s.xray === true; if (!['solid', 'ghost', 'off'].includes(s.parts)) s.parts = 'solid';
    return s;
  } catch { return DEFAULT_VIEW3D_SETTINGS; }
}
const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

const DEFAULT_UI = { drag: 'orbit' as const, preset: 'iso' as const };
export const view3dStore = new View3DStore();
