import { log } from './log-store';

export type LabelSize = 'small' | 'medium' | 'large';

/** Pad shape override — applies to pin pads within a part type */
export type PadShape = 'natural' | 'round' | 'square';

/**
 * Body/outline shape override for a part type.
 * natural = follow board data bounds
 * rect    = clamp aspect ratio to 2:1 (inflates the narrow axis)
 * square  = force 1:1 (inflates smaller axis to match larger)
 */
export type BodyShape = 'natural' | 'rect' | 'square';

/** Per-component-type rendering overrides (keyed by first letter of part name) */
export interface PartTypeOverride {
  padShape: PadShape;
  bodyShape: BodyShape;
  hidden: boolean;
  /** Fill color as CSS hex string (e.g. '#7a7a7a'). Empty = no fill. */
  color: string;
}

export interface NetColorRule {
  id: string;
  pattern: string;
  color: string;
  enabled: boolean;
}

export interface RenderSettings {
  outlineWidth: number;
  outlineAlpha: number;

  partBorderWidth: number;
  partBorderAlpha: number;
  partPadding: number;
  showPartLabels: boolean;
  partLabelShadow: boolean;
  labelSize: LabelSize;
  labelSizeSmall: number;
  labelSizeMedium: number;
  labelSizeLarge: number;
  labelHideThreshold: number;

  pinMinRadius: number;
  pinMaxRadius: number;
  pinScaleFactor: number;
  /** Minimum body size (mils) in the narrow dimension for 2-pin parts. 0 = disabled. */
  partMinBodyMils: number;
  pinAlpha: number;
  showPinNumbers: boolean;
  /** Show pin-1 marker (red color + triangle indicator) on multi-pin parts */
  showPin1Marker: boolean;

  /** Min rendered font size in screen pixels — labels smaller than this are hidden */
  labelMinScreenPx: number;
  /** Min viewport scale to show labels (0 = always visible) */
  labelZoomHide: number;

  selectionWidth: number;
  selectionPadding: number;
  selectionFillAlpha: number;
  netHighlightGrow: number;
  netHighlightAlpha: number;
  /** Opacity of the black dim overlay (0 = no dim, 1 = fully black) */
  dimOverlayAlpha: number;
  /** Always dim the board even when nothing is selected — hover/click punches through */
  ambientDim: boolean;

  netLineWidth: number;
  netLineAlpha: number;
  netLineColor: number;
  netLineDashed: boolean;
  netLineDashLength: number;
  netLinePulse: boolean;

  boardFillAlpha: number;

  /** Show background-elevated label for selected component */
  showElevatedPartLabel: boolean;
  /** Show background-elevated label for selected pin */
  showElevatedPinLabel: boolean;
  /** Show big centered selection overlay text at top of board */
  showSelectionOverlay: boolean;

  /** Hide text labels during zoom for better performance on slower machines */
  hideTextDuringZoom: boolean;

  /**
   * Min screen pixels (pinMinRadius * scale) for Group A labels to appear
   * (pin numbers + net names on circle/1-pin parts). Higher = needs more zoom.
   */
  circleLabelMinScreenPx: number;
  /**
   * Min screen pixels threshold for Group B labels (net names on 2-pin parts).
   * 0 = always visible when part labels are visible.
   */
  twoPinLabelMinScreenPx: number;
  /** Draw a background block behind Group A net-name labels (circle pins) */
  pinNetLabelBg: boolean;
  /** Draw a background block behind Group B net-name labels (2-pin pads) */
  twoPinNetLabelBg: boolean;
  /**
   * BGA label gap: multiplier on pin radius that separates the pin number
   * and net name text when BGA alternating layout is active.
   * Higher = more vertical distance between the two labels. Default 0.25.
   */
  bgaLabelGapFactor: number;

  /** Debug: draw a crosshair at each pin's exact file coordinates */
  showPadVertices: boolean;
  /** Debug: show numbered markers at each outline vertex */
  showVertexNumbers: boolean;
  /** Debug: color part labels by font-size tier (blue=small, yellow=medium, green=large) */
  showLabelSizeDebug: boolean;
  /** Color part body fills by component type prefix (R/C/L/U/Q/D/J) */
  showComponentColors: boolean;
  /** Opacity of component type fill overlays */
  componentFillAlpha: number;

  clickThreshold: number;
  fitPadding: number;

  /** Disable inertia/momentum after panning */
  disableInertia: boolean;
  /** Wheel zoom smoothing factor (1 = instant, higher = smoother) */
  wheelSmooth: number;
  /** Require two fingers for panning (one finger does nothing); useful for trackpad users */
  twoFingerPan: boolean;

  netColorRules: NetColorRule[];

  /** Net name patterns treated as "no connect" — outline-only pins, no fill, no labels.
   *  Patterns are case-insensitive. Supports trailing `*` wildcard (e.g. `NC_*` matches `NC_PAD`). */
  ncNetPatterns: string[];

  /** Per-type rendering overrides, keyed by uppercase first letter (e.g. 'L', 'R', 'C') */
  partTypeOverrides: Record<string, PartTypeOverride>;
}

/** Check if a net name matches any NC (no-connect) pattern in settings.
 *  Patterns are case-insensitive; trailing `*` acts as a prefix wildcard. */
export function isNcNet(netUpper: string, patterns: string[]): boolean {
  for (const pat of patterns) {
    const p = pat.toUpperCase();
    if (p.endsWith('*')) {
      if (netUpper.startsWith(p.slice(0, -1))) return true;
    } else {
      if (netUpper === p) return true;
    }
  }
  return false;
}

/** Return the active label font size for the selected tier. */
export function getLabelFontSize(s: RenderSettings): number {
  if (s.labelSize === 'small') return s.labelSizeSmall;
  if (s.labelSize === 'large') return s.labelSizeLarge;
  return s.labelSizeMedium;
}

const DEFAULT_NET_COLOR_RULES: NetColorRule[] = [
  { id: 'gnd',  pattern: 'GND',  color: '#666666', enabled: true },
  { id: 'vcc',  pattern: 'VCC',  color: '#dd3333', enabled: true },
  { id: 'pp',   pattern: 'PP',   color: '#dd6633', enabled: true },
];

export const DEFAULTS: RenderSettings = {
  outlineWidth: 3,
  outlineAlpha: 0.8,

  partBorderWidth: 1,
  partBorderAlpha: 0.4,
  partPadding: 4,
  showPartLabels: true,
  partLabelShadow: false,
  labelSize: 'small',
  labelSizeSmall: 4,
  labelSizeMedium: 6,
  labelSizeLarge: 14,
  labelHideThreshold: 2,

  pinMinRadius: 3,
  pinMaxRadius: 30,
  pinScaleFactor: 1,
  partMinBodyMils: 0,
  pinAlpha: 0.85,
  showPinNumbers: true,
  showPin1Marker: true,
  labelMinScreenPx: 3,
  labelZoomHide: 0,

  selectionWidth: 2,
  selectionPadding: 6,
  selectionFillAlpha: 0.07,
  netHighlightGrow: 3,
  netHighlightAlpha: 0.6,
  dimOverlayAlpha: 0.5,
  ambientDim: true,

  netLineWidth: 3.5,
  netLineAlpha: 0.6,
  netLineColor: 0xffff44,
  netLineDashed: false,
  netLineDashLength: 8,
  netLinePulse: false,

  boardFillAlpha: 0.08,

  showElevatedPartLabel: false,
  showElevatedPinLabel: false,
  showSelectionOverlay: true,

  hideTextDuringZoom: true,

  circleLabelMinScreenPx: 3,
  twoPinLabelMinScreenPx: 6,
  pinNetLabelBg: true,
  twoPinNetLabelBg: true,
  bgaLabelGapFactor: 0.15,

  showPadVertices: false,
  showVertexNumbers: false,
  showLabelSizeDebug: false,
  showComponentColors: true,
  componentFillAlpha: 0.55,

  clickThreshold: 30,
  fitPadding: 50,
  disableInertia: true,
  wheelSmooth: 5,
  twoFingerPan: true,

  netColorRules: DEFAULT_NET_COLOR_RULES.map(r => ({ ...r })),

  ncNetPatterns: ['NC', 'NC_*', 'N/C', 'NO CONNECT'],

  partTypeOverrides: {
    R: { padShape: 'natural', bodyShape: 'natural', hidden: false, color: '#222222' },
    C: { padShape: 'natural', bodyShape: 'natural', hidden: false, color: '#9a5a35' },
    L: { padShape: 'natural', bodyShape: 'square',  hidden: false, color: '#7a7a7a' },
    U: { padShape: 'natural', bodyShape: 'natural', hidden: false, color: '#5a2090' },
    Q: { padShape: 'natural', bodyShape: 'natural', hidden: false, color: '#0d6b55' },
    D: { padShape: 'natural', bodyShape: 'natural', hidden: false, color: '#2255aa' },
    J: { padShape: 'natural', bodyShape: 'natural', hidden: false, color: '#2a5080' },
  },
};

/** Discrete font-size steps — snapping to these enables BitmapFont atlas sharing */
const FONT_SIZE_STEPS = [2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];

/** Snap a continuous font size to the nearest discrete step */
export function quantizeFontSize(size: number): number {
  if (size <= FONT_SIZE_STEPS[0]) return FONT_SIZE_STEPS[0];
  for (let i = 1; i < FONT_SIZE_STEPS.length; i++) {
    if (size <= FONT_SIZE_STEPS[i]) {
      const lo = FONT_SIZE_STEPS[i - 1];
      const hi = FONT_SIZE_STEPS[i];
      return (size - lo) < (hi - size) ? lo : hi;
    }
  }
  return FONT_SIZE_STEPS[FONT_SIZE_STEPS.length - 1];
}

/** Compute display radius for a pin. At scaleFactor=0 all pins are pinMinRadius. */
export function computePinRadius(s: RenderSettings, fileRadius: number): number {
  const base = fileRadius || s.pinMinRadius;
  const r = s.pinMinRadius + (base - s.pinMinRadius) * s.pinScaleFactor;
  return Math.min(s.pinMaxRadius, Math.max(s.pinMinRadius, r));
}

/**
 * Compute effective padding for a multi-pin part so the outline clears all pins.
 * Uses the largest rendered pin radius in the part.
 */
export function computeMultiPinPadding(s: RenderSettings, pinRadii: number[]): number {
  let maxR = s.pinMinRadius;
  for (const fr of pinRadii) {
    const r = computePinRadius(s, fr);
    if (r > maxR) maxR = r;
  }
  return s.partPadding + maxR;
}

/** Inflate flat bounds for small parts (≤4 pins) and return padded outline rect */
export interface EffectiveBounds {
  minX: number; minY: number; maxX: number; maxY: number;
  px: number; py: number; pw: number; ph: number;
  horiz: boolean;
}

export function computeEffectiveBounds(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  pins: { position: { x: number; y: number }; radius?: number }[],
  s: RenderSettings,
): EffectiveBounds {
  let { minX, minY, maxX, maxY } = bounds;
  let horiz = false;
  const isSmallPart = pins.length <= 4;

  if (isSmallPart && pins.length >= 2) {
    // Determine orientation from the two most distant pins
    const p0 = pins[0].position;
    const p1 = pins[pins.length - 1].position;
    horiz = Math.abs(p0.x - p1.x) >= Math.abs(p0.y - p1.y);
    const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
    const inflate = Math.max(dist * 0.35, s.partMinBodyMils);
    if (horiz && maxY - minY < inflate) {
      const cy = (minY + maxY) / 2;
      minY = cy - inflate / 2;
      maxY = cy + inflate / 2;
    }
    if (!horiz && maxX - minX < inflate) {
      const cx = (minX + maxX) / 2;
      minX = cx - inflate / 2;
      maxX = cx + inflate / 2;
    }
  }

  // Small parts (≤4 pins) have no padding — pads fill the outline exactly
  const pad = isSmallPart
    ? 0
    : computeMultiPinPadding(s, pins.map(p => p.radius ?? 0));

  const bw = maxX - minX;
  const bh = maxY - minY;
  return {
    minX, minY, maxX, maxY,
    px: minX - pad, py: minY - pad,
    pw: bw + pad * 2, ph: bh + pad * 2,
    horiz,
  };
}

/**
 * Detect if a multi-pin part's pins are arranged diagonally and compute an
 * oriented bounding box (OBB) if so. Returns 4 corner points or null.
 *
 * Detection: ≥20 pins, and ≥5 consecutive pins with both dx and dy nonzero
 * and consistent sign (all moving in the same diagonal direction).
 */
export function computeDiagonalOBB(
  pins: { position: { x: number; y: number }; radius?: number }[],
  s: RenderSettings,
): [number, number][] | null {
  if (pins.length < 20) return null;

  // Find longest run of consecutive pins with consistent diagonal deltas
  let bestRun = 0, bestStart = 0;
  let runLen = 0, runStart = 0;
  let lastSignX = 0, lastSignY = 0;

  for (let i = 1; i < pins.length; i++) {
    const dx = pins[i].position.x - pins[i - 1].position.x;
    const dy = pins[i].position.y - pins[i - 1].position.y;
    const sx = Math.sign(dx), sy = Math.sign(dy);
    // Both axes must move, and direction must be consistent with the run
    if (sx !== 0 && sy !== 0 && (runLen === 0 || (sx === lastSignX && sy === lastSignY))) {
      if (runLen === 0) runStart = i - 1;
      runLen++;
      lastSignX = sx; lastSignY = sy;
    } else {
      if (runLen > bestRun) { bestRun = runLen; bestStart = runStart; }
      runLen = 0;
    }
  }
  if (runLen > bestRun) { bestRun = runLen; bestStart = runStart; }

  // Require at least 10% of pins in the diagonal run to avoid false positives
  // on BGA packages where column-to-column transitions mimic diagonals
  if (bestRun < 5 || bestRun < pins.length * 0.1) return null;

  // Compute principal axis from the diagonal run
  const p0 = pins[bestStart].position;
  const pN = pins[bestStart + bestRun].position;
  const axisX = pN.x - p0.x;
  const axisY = pN.y - p0.y;
  const axisLen = Math.hypot(axisX, axisY);
  if (axisLen < 1) return null;

  // Unit vectors: along axis and perpendicular
  const ux = axisX / axisLen, uy = axisY / axisLen;
  const vx = -uy, vy = ux; // perpendicular

  // Project ALL pins onto the axis coordinate system
  const cx = (pins[0].position.x + pins[pins.length - 1].position.x) / 2;
  const cy = (pins[0].position.y + pins[pins.length - 1].position.y) / 2;

  let minU = Infinity, maxU = -Infinity;
  let minV = Infinity, maxV = -Infinity;
  for (const pin of pins) {
    const dx = pin.position.x - cx;
    const dy = pin.position.y - cy;
    const u = dx * ux + dy * uy;
    const v = dx * vx + dy * vy;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  // Pad the OBB
  const pad = computeMultiPinPadding(s, pins.map(p => p.radius ?? 0));
  minU -= pad; maxU += pad;
  minV -= pad; maxV += pad;

  // Convert back to world-space corners
  return [
    [cx + minU * ux + minV * vx, cy + minU * uy + minV * vy],
    [cx + maxU * ux + minV * vx, cy + maxU * uy + minV * vy],
    [cx + maxU * ux + maxV * vx, cy + maxU * uy + maxV * vy],
    [cx + minU * ux + maxV * vx, cy + minU * uy + maxV * vy],
  ];
}

/**
 * Compute an oriented bounding box for a diagonal 2-pin part.
 * Returns 4 corner points forming a rotated rectangle along the pin-to-pin axis.
 */
export function computeTwoPinOBB(
  pins: { position: { x: number; y: number }; radius?: number }[],
  s: RenderSettings,
): [number, number][] | null {
  if (pins.length !== 2) return null;
  const p0 = pins[0].position;
  const p1 = pins[1].position;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;

  // Unit vectors: along pin axis and perpendicular
  const ux = dx / dist, uy = dy / dist;
  const vx = -uy, vy = ux;

  // Body half-width perpendicular to pin axis (proportional to distance)
  const halfW = Math.max(dist * 0.18, s.partMinBodyMils / 2);
  // Extend slightly beyond pins along the axis
  const ext = halfW * 0.5;

  const cx = (p0.x + p1.x) / 2;
  const cy = (p0.y + p1.y) / 2;
  const halfLen = dist / 2 + ext;

  return [
    [cx - halfLen * ux - halfW * vx, cy - halfLen * uy - halfW * vy],
    [cx + halfLen * ux - halfW * vx, cy + halfLen * uy - halfW * vy],
    [cx + halfLen * ux + halfW * vx, cy + halfLen * uy + halfW * vy],
    [cx - halfLen * ux + halfW * vx, cy - halfLen * uy + halfW * vy],
  ];
}

/** Convenience wrapper: compute OBB polygon for a part, or null if axis-aligned. */
export function computePartRenderPoly(
  part: { pins: { position: { x: number; y: number }; radius?: number }[] },
  s: RenderSettings,
): [number, number][] | null {
  // Check diagonal 2-pin parts first
  if (part.pins.length === 2) {
    const dx = Math.abs(part.pins[1].position.x - part.pins[0].position.x);
    const dy = Math.abs(part.pins[1].position.y - part.pins[0].position.y);
    const ratio = Math.min(dx, dy) / (Math.max(dx, dy) || 1);
    if (ratio > 0.4) return computeTwoPinOBB(part.pins, s);
  }
  return computeDiagonalOBB(part.pins, s);
}

/** Resolve the matching part-type override for a part name (prefix match, longest key wins) */
export function resolvePartTypeOverride(partName: string, s: RenderSettings): PartTypeOverride | undefined {
  const upper = partName.toUpperCase();
  let best: PartTypeOverride | undefined;
  let bestLen = 0;
  for (const [key, ov] of Object.entries(s.partTypeOverrides)) {
    if (key && upper.startsWith(key.toUpperCase()) && key.length > bestLen) {
      bestLen = key.length; best = ov;
    }
  }
  return best;
}

/**
 * Apply bodyShape override in-place to EffectiveBounds.
 * Only affects small parts (≤4 pins) where isSmallPart is true.
 */
export function applyBodyShapeOverride(eb: EffectiveBounds, override: PartTypeOverride | undefined, isSmallPart: boolean): void {
  if (!isSmallPart || !override?.bodyShape || override.bodyShape === 'natural') return;
  const cx = eb.px + eb.pw / 2;
  const cy = eb.py + eb.ph / 2;
  const wide = Math.max(eb.pw, eb.ph);
  const narrow = Math.min(eb.pw, eb.ph);
  const newNarrow = override.bodyShape === 'square' ? wide : Math.max(narrow, wide / 2);
  if (eb.pw >= eb.ph) { eb.py = cy - newNarrow / 2; eb.ph = newNarrow; }
  else                 { eb.px = cx - newNarrow / 2; eb.pw = newNarrow; }
}

/**
 * Compute the final rendered body rect for a part.
 * Applies bodyShape override and 2-pin pad expansion (the visible border rect).
 * Use this for selection highlights and hit-testing.
 */
export function computePartRenderBounds(
  part: { name: string; bounds: { minX: number; minY: number; maxX: number; maxY: number }; pins: { position: { x: number; y: number }; radius?: number }[] },
  s: RenderSettings,
): { px: number; py: number; pw: number; ph: number } {
  const eb = computeEffectiveBounds(part.bounds, part.pins, s);
  const isSmallPart = part.pins.length <= 4;
  applyBodyShapeOverride(eb, resolvePartTypeOverride(part.name, s), isSmallPart);
  if (part.pins.length === 2) {
    const d = eb.horiz ? Math.min(eb.ph, eb.pw * 0.4) : Math.min(eb.pw, eb.ph * 0.4);
    return {
      px: eb.horiz ? eb.px - d / 2 : eb.px,
      py: eb.horiz ? eb.py : eb.py - d / 2,
      pw: eb.horiz ? eb.pw + d : eb.pw,
      ph: eb.horiz ? eb.ph : eb.ph + d,
    };
  }
  return { px: eb.px, py: eb.py, pw: eb.pw, ph: eb.ph };
}

/** Resolve pin color from a settings object (not necessarily the live one) */
export function resolvePinColor(settings: RenderSettings, netName: string, side: 'top' | 'bottom'): number {
  if (netName) {
    const upper = netName.toUpperCase();
    for (const rule of settings.netColorRules) {
      if (rule.enabled && upper.includes(rule.pattern.toUpperCase())) {
        return parseInt(rule.color.replace('#', ''), 16);
      }
    }
  }
  return side === 'bottom' ? 0xcc4444 : 0x44cc44;
}

export type RenderSettingsListener = () => void;

const STORAGE_KEY = 'boardripper-render-settings';
const BOARD_OVERRIDES_KEY = 'boardripper-board-overrides';

// ── Per-board overrides persistence ──────────────────────────────────────

function loadBoardOverridesMap(): Record<string, Partial<RenderSettings>> {
  try {
    const raw = localStorage.getItem(BOARD_OVERRIDES_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return {};
}

function saveBoardOverridesMap(m: Record<string, Partial<RenderSettings>>) {
  try {
    localStorage.setItem(BOARD_OVERRIDES_KEY, JSON.stringify(m));
  } catch { /* ignore quota errors */ }
}

// ── Global settings persistence ──────────────────────────────────────────

function loadFromStorage(): RenderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const result: RenderSettings = { ...structuredClone(DEFAULTS), ...parsed };
      // Deep-merge partTypeOverrides so new default entries survive old stored data.
      const mergedOverrides: Record<string, PartTypeOverride> = structuredClone(DEFAULTS.partTypeOverrides);
      for (const [key, stored] of Object.entries(parsed.partTypeOverrides ?? {})) {
        mergedOverrides[key] = { ...(mergedOverrides[key] ?? {} as PartTypeOverride), ...(stored as PartTypeOverride) };
      }
      result.partTypeOverrides = mergedOverrides;
      return result;
    }
  } catch { /* ignore corrupt data */ }
  return structuredClone(DEFAULTS);
}

function saveToStorage(s: RenderSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* ignore quota errors */ }
}

/** Merge global settings with sparse board overrides → effective settings */
function mergeSettings(global: RenderSettings, overrides: Partial<RenderSettings>): RenderSettings {
  if (!overrides || Object.keys(overrides).length === 0) return global;
  const merged = { ...global, ...overrides };
  // Deep-merge partTypeOverrides when both sides have them
  if (overrides.partTypeOverrides) {
    const base: Record<string, PartTypeOverride> = structuredClone(global.partTypeOverrides);
    for (const [key, ov] of Object.entries(overrides.partTypeOverrides)) {
      base[key] = { ...(base[key] ?? {} as PartTypeOverride), ...ov };
    }
    merged.partTypeOverrides = base;
  }
  // Deep-merge netColorRules: board overrides replace entirely (not merged per-rule)
  return merged;
}

/**
 * Compute the sparse diff: only keys where `edited` differs from `base`.
 * Returns an empty object when they are identical.
 */
export function computeOverrides(base: RenderSettings, edited: RenderSettings): Partial<RenderSettings> {
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(base) as (keyof RenderSettings)[]) {
    const bv = base[key];
    const ev = edited[key];
    if (typeof bv === 'object') {
      if (JSON.stringify(bv) !== JSON.stringify(ev)) diff[key] = structuredClone(ev);
    } else if (bv !== ev) {
      diff[key] = ev;
    }
  }
  return diff as Partial<RenderSettings>;
}

class RenderSettingsStore {
  private _global: RenderSettings = loadFromStorage();
  private _boardOverrides: Record<string, Partial<RenderSettings>> = loadBoardOverridesMap();
  private _activeBoard: string = '';
  private _effective: RenderSettings = this._global;
  private _listeners = new Set<RenderSettingsListener>();

  private recomputeEffective() {
    const ov = this._activeBoard ? (this._boardOverrides[this._activeBoard] ?? {}) : {};
    this._effective = mergeSettings(this._global, ov);
  }

  /** Effective settings (global + active board overrides merged) */
  get settings(): RenderSettings {
    return this._effective;
  }

  /** Raw global settings (no board overrides) */
  get globalSettings(): RenderSettings {
    return this._global;
  }

  /** The currently active board fileName (empty = none) */
  get activeBoard(): string {
    return this._activeBoard;
  }

  subscribe(listener: RenderSettingsListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    for (const l of this._listeners) l();
  }

  /** Set the active board fileName — recomputes effective settings and notifies */
  setActiveBoard(fileName: string) {
    if (this._activeBoard === fileName) return;
    this._activeBoard = fileName;
    this.recomputeEffective();
    this.notify();
  }

  /** Take a snapshot of effective settings */
  snapshot(): RenderSettings {
    return structuredClone(this._effective);
  }

  /** Take a snapshot of global settings (ignoring board overrides) */
  globalSnapshot(): RenderSettings {
    return structuredClone(this._global);
  }

  // ── Global settings mutations ──────────────────────────────────────────

  /** Apply full global settings */
  applyGlobal(settings: RenderSettings) {
    this._global = structuredClone(settings);
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  /** Reset global settings to compile-time defaults */
  resetGlobal() {
    this._global = structuredClone(DEFAULTS);
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  // ── Per-board override mutations ───────────────────────────────────────

  /** Get the sparse overrides for a board (empty object if none) */
  getBoardOverrides(fileName: string): Partial<RenderSettings> {
    return this._boardOverrides[fileName] ?? {};
  }

  /** Whether a board has any overrides stored */
  hasBoardOverrides(fileName: string): boolean {
    const ov = this._boardOverrides[fileName];
    return !!ov && Object.keys(ov).length > 0;
  }

  /** Set sparse overrides for a board. Empty object = clear all overrides. */
  setBoardOverrides(fileName: string, overrides: Partial<RenderSettings>) {
    if (Object.keys(overrides).length === 0) {
      delete this._boardOverrides[fileName];
    } else {
      this._boardOverrides[fileName] = structuredClone(overrides);
    }
    saveBoardOverridesMap(this._boardOverrides);
    if (fileName === this._activeBoard) {
      this.recomputeEffective();
      this.notify();
    }
  }

  /** Clear all overrides for a board (revert to global) */
  clearBoardOverrides(fileName: string) {
    if (!this._boardOverrides[fileName]) return;
    delete this._boardOverrides[fileName];
    saveBoardOverridesMap(this._boardOverrides);
    if (fileName === this._activeBoard) {
      this.recomputeEffective();
      this.notify();
    }
  }

  // ── Legacy compat (used by preview/cancel flow) ────────────────────────

  /** Apply effective settings directly (for preview mode) */
  applySettings(settings: RenderSettings) {
    this._effective = structuredClone(settings);
    // Don't persist to global or overrides — preview is temporary
    this.notify();
  }

  resolvePinColor(netName: string, side: 'top' | 'bottom'): number {
    return resolvePinColor(this._effective, netName, side);
  }
}

export const renderSettingsStore = new RenderSettingsStore();

// ── Dev utility: export current settings as DEFAULTS constant ─────────────

/**
 * Generate a TypeScript `DEFAULTS` constant from the current global settings.
 * Run in browser console: `exportSettingsAsDefaults()` — copy the output and
 * paste it into render-settings.ts to update the compile-time defaults.
 */
export function exportSettingsAsDefaults(): string {
  const s = renderSettingsStore.globalSettings;
  const lines: string[] = ['export const DEFAULTS: RenderSettings = {'];

  for (const [key, val] of Object.entries(s)) {
    if (key === 'netColorRules' || key === 'ncNetPatterns' || key === 'partTypeOverrides') continue;
    if (typeof val === 'string') {
      lines.push(`  ${key}: '${val}',`);
    } else if (typeof val === 'number' && key.toLowerCase().includes('color') && val > 255) {
      lines.push(`  ${key}: 0x${val.toString(16).padStart(6, '0')},`);
    } else {
      lines.push(`  ${key}: ${JSON.stringify(val)},`);
    }
  }

  // netColorRules
  lines.push('');
  lines.push('  netColorRules: [');
  for (const r of s.netColorRules) {
    lines.push(`    { id: '${r.id}', pattern: '${r.pattern}', color: '${r.color}', enabled: ${r.enabled} },`);
  }
  lines.push('  ],');

  // ncNetPatterns
  lines.push('');
  lines.push(`  ncNetPatterns: ${JSON.stringify(s.ncNetPatterns)},`);

  // partTypeOverrides
  lines.push('');
  lines.push('  partTypeOverrides: {');
  for (const [key, ov] of Object.entries(s.partTypeOverrides)) {
    lines.push(`    ${key}: { padShape: '${ov.padShape}', bodyShape: '${ov.bodyShape}', hidden: ${ov.hidden}, color: '${ov.color}' },`);
  }
  lines.push('  },');
  lines.push('};');

  const result = lines.join('\n');
  log.render.log(result);
  return result;
}

// Expose on window for console access in dev
if (typeof window !== 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).exportSettingsAsDefaults = exportSettingsAsDefaults;
}
