export type LabelSize = 'small' | 'medium' | 'large';

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
  pinAlpha: number;
  showPinNumbers: boolean;

  /** Min rendered font size in screen pixels — labels smaller than this are hidden */
  labelMinScreenPx: number;
  /** Min viewport scale to show labels (0 = always visible) */
  labelZoomHide: number;

  selectionWidth: number;
  selectionPadding: number;
  selectionFillAlpha: number;
  netHighlightGrow: number;
  netHighlightAlpha: number;

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

  clickThreshold: number;
  fitPadding: number;

  netColorRules: NetColorRule[];
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

const DEFAULTS: RenderSettings = {
  outlineWidth: 3,
  outlineAlpha: 0.8,

  partBorderWidth: 1,
  partBorderAlpha: 0.4,
  partPadding: 4,
  showPartLabels: true,
  partLabelShadow: false,
  labelSize: 'medium',
  labelSizeSmall: 4,
  labelSizeMedium: 8,
  labelSizeLarge: 14,
  labelHideThreshold: 2,

  pinMinRadius: 3,
  pinMaxRadius: 30,
  pinScaleFactor: 1.0,
  pinAlpha: 0.85,
  showPinNumbers: true,
  labelMinScreenPx: 3,
  labelZoomHide: 0,

  selectionWidth: 2,
  selectionPadding: 6,
  selectionFillAlpha: 0.07,
  netHighlightGrow: 3,
  netHighlightAlpha: 0.6,

  netLineWidth: 1,
  netLineAlpha: 0.5,
  netLineColor: 0xffff44,
  netLineDashed: true,
  netLineDashLength: 8,
  netLinePulse: true,

  boardFillAlpha: 0.08,

  showElevatedPartLabel: false,
  showElevatedPinLabel: true,
  showSelectionOverlay: true,

  hideTextDuringZoom: false,

  clickThreshold: 30,
  fitPadding: 50,

  netColorRules: DEFAULT_NET_COLOR_RULES.map(r => ({ ...r })),
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

/** Inflate flat bounds for 2-pin parts and return padded outline rect */
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
  const isTwoPin = pins.length === 2;

  if (isTwoPin) {
    const p0 = pins[0].position;
    const p1 = pins[1].position;
    horiz = Math.abs(p0.x - p1.x) >= Math.abs(p0.y - p1.y);
    const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
    const inflate = dist * 0.35;
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

  // 2-pin parts have no padding — pads fill the outline exactly
  const pad = isTwoPin
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

const STORAGE_KEY = 'boardviewer-render-settings';

function loadFromStorage(): RenderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Merge with defaults so new fields get default values
      return { ...structuredClone(DEFAULTS), ...parsed };
    }
  } catch { /* ignore corrupt data */ }
  return structuredClone(DEFAULTS);
}

function saveToStorage(s: RenderSettings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* ignore quota errors */ }
}

class RenderSettingsStore {
  private _settings: RenderSettings = loadFromStorage();
  private _listeners = new Set<RenderSettingsListener>();

  get settings(): RenderSettings {
    return this._settings;
  }

  get defaults(): RenderSettings {
    return structuredClone(DEFAULTS);
  }

  subscribe(listener: RenderSettingsListener): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  private notify() {
    for (const l of this._listeners) l();
  }

  /** Take a snapshot of current settings (for cancel/revert) */
  snapshot(): RenderSettings {
    return structuredClone(this._settings);
  }

  /** Apply a full settings object (used by Apply/Preview/Cancel) */
  applySettings(settings: RenderSettings) {
    this._settings = structuredClone(settings);
    saveToStorage(this._settings);
    this.notify();
  }

  update(partial: Partial<RenderSettings>) {
    this._settings = { ...this._settings, ...partial };
    saveToStorage(this._settings);
    this.notify();
  }

  reset() {
    this._settings = structuredClone(DEFAULTS);
    saveToStorage(this._settings);
    this.notify();
  }

  resolvePinColor(netName: string, side: 'top' | 'bottom'): number {
    return resolvePinColor(this._settings, netName, side);
  }
}

export const renderSettingsStore = new RenderSettingsStore();
