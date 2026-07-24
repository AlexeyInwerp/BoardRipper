import { log } from './log-store';
import { Emitter } from './emitter';
import {
  type OverlaySlot,
  DEFAULT_OVERLAY_LAYOUT,
  reconcileOverlayLayout,
  nextSeparatorId,
} from './overlay-layout';
import { naturalCompare } from '../components/overlay/natural-sort';

/** Pad shape override — applies to pin pads within a part type */
export type PadShape = 'natural' | 'round' | 'square';

/**
 * Body/outline shape override for a part type.
 * natural = follow board data bounds
 * rect    = clamp aspect ratio to 2:1 (inflates the narrow axis)
 * square  = force 1:1 (inflates smaller axis to match larger)
 */
export type BodyShape = 'natural' | 'rect' | 'square';

/** Per-component-type rendering overrides — shape returned by resolvePartTypeOverride */
export interface PartTypeOverride {
  padShape: PadShape;
  bodyShape: BodyShape;
  hidden: boolean;
  /** Fill color as CSS hex string (e.g. '#7a7a7a'). Empty = no fill. */
  color: string;
}

/**
 * Part Type — groups one or more reference-designator prefixes under a named
 * category (Resistor, Capacitor, …). A single color / shape override applies
 * to every prefix in the group. Replaces the legacy prefix-keyed overrides
 * map (see GitHub issue #10).
 */
export interface PartType {
  /** Stable id — used for migration + rule ordering. */
  id: string;
  /** Display label shown in the Settings UI. */
  label: string;
  /** Uppercase prefix list (longest-match wins at resolve time). */
  prefixes: string[];
  /** Fill color as CSS hex (empty = no fill). */
  color: string;
  padShape: PadShape;
  bodyShape: BodyShape;
  hidden: boolean;
  /** When true, the hierarchical (chain-adjacent) net-line mode bridges nets
   *  through parts of this type regardless of pin count — beyond the universal
   *  2-pin rule. Lets 4-pin current-sense resistors, 3-pin transistors, etc.
   *  carry the propagation one hop. Default: resistors on, everything else off. */
  hierarchyBridge: boolean;
}

export interface NetColorRule {
  id: string;
  pattern: string;
  color: string;
  enabled: boolean;
}

/** One keyword→colour rule inside a pin group. `keywords` is a comma-separated
 *  list (e.g. "VCC, 3VA, VDD"); each keyword is matched case-insensitively
 *  against the net name. A keyword ending in `*` is a prefix match; one
 *  containing `#` matches a run of digits; otherwise the parent group's match
 *  mode applies (substring for normal groups, exact for outline-only groups —
 *  see matchPinGroupKeyword). */
export interface PinGroupRule {
  id: string;
  keywords: string;
  color: string;
}

/** A named, ordered category of pin/net colour rules (Power, Ground, Datalines,
 *  Logical, Misc…). Supersedes the flat `netColorRules` + `ncNetPatterns`.
 *  `outlineOnly` renders matching pins as outline-only circles (no fill / no
 *  labels) — the old "no-connect" behaviour, now generalised to any group. */
export interface PinGroup {
  id: string;
  label: string;
  outlineOnly: boolean;
  rules: PinGroupRule[];
}

export interface RenderSettings {
  outlineWidth: number;
  outlineAlpha: number;

  partBorderWidth: number;
  partBorderAlpha: number;
  partPadding: number;
  showPartLabels: boolean;
  partLabelShadow: boolean;
  /** Drop shadow on on-pin labels (pin numbers + net names). Net names were
   *  previously always shadowed with no toggle; this exposes it. Default true
   *  preserves the net-label look. */
  pinLabelShadow: boolean;
  /** Minimum label font size (board mils). Acts as a floor on the
   *  auto-computed size, so tiny parts still get a readable label. */
  labelMinSize: number;
  labelHideThreshold: number;
  /** Multiplier on the computed part-designator (component) label size.
   *  Part labels are auto-fit to the part body, so `labelMinSize` (a floor)
   *  barely moves them; this scales them directly. 1 = geometry-fit default. */
  partLabelScale: number;
  /** Multiplier on pin-number label size (Resize Mode). labelMinSize is only a
   *  floor and can't grow numbers already above it, so this scales directly. */
  pinNumberScale: number;
  /** Multiplier on net-name label size (Resize Mode). Independent of pin
   *  numbers so the two can be sized separately. 1 = unchanged. */
  netLabelScale: number;
  /** Multiplier on on-pin diode-value text size (Resize Mode). Diode text is
   *  otherwise derived from the pin radius, so it grows with pinSizeScale; this
   *  lets it be sized independently. 1 = unchanged. */
  diodeValueScale: number;

  pinMinRadius: number;
  pinMaxRadius: number;
  pinScaleFactor: number;
  /** Final uniform multiplier on every pin's rendered radius (Resize Mode's
   *  pin knob). 1 = unchanged. Applied after the min/max clamp in
   *  computePinRadius so it scales all pins, not just those at the floor. */
  pinSizeScale: number;
  /** Minimum body size (mils) in the narrow dimension for 2-pin parts. 0 = disabled. */
  partMinBodyRatio: number;
  pinAlpha: number;
  showPinNumbers: boolean;
  /** Show pin-1 marker (red color + triangle indicator) on multi-pin parts */
  showPin1Marker: boolean;
  /** Draw diode-mode reference readings directly on pins (XZZ-baked + OBD).
   *  The overlay only renders when the board actually carries readings, so
   *  this is harmless on normal boards. Toggled via the `diodeValues` overlay
   *  slot. */
  showDiodeValues: boolean;

  /** Min rendered font size in screen pixels — labels smaller than this are hidden */
  labelMinScreenPx: number;
  /** Min viewport scale to show labels (0 = always visible) */
  labelZoomHide: number;
  /** Selected part's labels never render smaller than this many screen px
   *  while selected (Text fast mode). 0 = scale naturally with zoom. */
  selectedLabelMinPx: number;
  /** LoD relax multiplier on the selected part's label appear-threshold (Text
   *  fast mode). Selected labels appear when fontSize*zoom ≥ minPx*relax, so
   *  lower = they stay visible when zoomed out further. 1 = no relax. */
  selectedLabelLodRelax: number;
  /** Draw board text on a Canvas2D overlay instead of scene BitmapText.
   */
  textFastMode: boolean;

  selectionWidth: number;
  selectionPadding: number;
  selectionFillAlpha: number;
  /** Target component size after navigating to a search result, as a fraction
   *  of the smaller viewport dimension. Higher = part fills more of the screen. */
  navTargetSize: number;
  /** How navigation should treat zoom level:
   *   - 'auto'   — keep the current zoom when the part is already in the
   *                comfortable band (1.5%–70% of the smaller viewport dim);
   *                snap to `navTargetSize` only when it would otherwise be
   *                invisible or oversized.
   *   - 'keep'   — never change zoom; just pan to center the part. The
   *                `navTargetSize` setting is ignored.
   *   - 'always' — every navigation snaps to `navTargetSize`. This is the
   *                pre-v0.31.4 behavior and the mode to use when you want to
   *                tune `navTargetSize` and see the effect on every click. */
  navZoomMode: 'auto' | 'keep' | 'always';
  netHighlightGrow: number;
  netHighlightAlpha: number;
  /** Draw the coloured halo (filled ring) around highlighted pins / part
   *  outlines on net selection. When false, pins still recolour but the
   *  yellow/blue selection overlay is suppressed — used by Landrex for a
   *  clean monochrome look without the noisy highlight glow. */
  showSelectionHalo: boolean;
  /** Opacity of the black dim overlay (0 = no dim, 1 = fully black) */
  dimOverlayAlpha: number;
  /** Always dim the board even when nothing is selected — hover/click punches through */
  ambientDim: boolean;

  netLineWidth: number;
  netLineAlpha: number;
  netLineColor: number;
  /** Color used for chain-adjacent net lines (the propagated nets reached
   *  from the selected net through 2-pin components). Default bluish. */
  adjacentNetLineColor: number;
  netLineDashed: boolean;
  netLineDashLength: number;
  netLinePulse: boolean;

  boardFillAlpha: number;

  /** When true, board fill uses the matched colors.hex value instead of the
   *  theme default. Falls back to theme default when no metadata color is set. */
  useMetadataBoardColor: boolean;

  /** Show background-elevated label for selected component */
  showElevatedPartLabel: boolean;
  /** Show background-elevated label for selected pin */
  showElevatedPinLabel: boolean;
  /** Show big centered selection overlay text at top of board */
  showSelectionOverlay: boolean;

  /** Hide text labels during zoom for better performance on slower machines */
  hideTextDuringZoom: boolean;

  /** BitmapFont atlas pixel multiplier for pin/net/part labels.
   *  Higher = sharper at deep zoom, larger atlas (memory ~ mult²). Default 8
   *  matches the v0.17.1 baseline; bump via Settings → Performance & Debug. */
  labelAtlasResolution: number;

  /** Cap renderer ticker to 60 FPS. Disable to let the ticker run at the
   *  display refresh rate (120/144/240 Hz) — smoother but more CPU/GPU work. */
  cap60Fps: boolean;

  /** Show the per-phase frame-time overlay on the board canvas. Same toggle
   *  as the small "i" button at the bottom-left of each board panel. */
  showPerfOverlay: boolean;

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
   * BGA label gap: visible vertical gap between the pin number and net name
   * labels on BGA alternating layout, expressed as a fraction of pin radius.
   * 0 = labels touch at the pin center; positive values insert that fraction
   * of the radius as empty space between them.
   */
  bgaLabelGapFactor: number;
  /**
   * Vertical shift factor for net labels on horizontal 2-pin parts.
   * Multiplied by body half-height to offset labels above/below the part name.
   */
  twoPinLabelGapFactor: number;

  /** PDF watermark filter — list of terms to erase from rendered PDF pages.
   *  Matching is case-insensitive and whitespace-insensitive (so "w w w . c h i n a f i x . c o m"
   *  matches "www.chinafix.com"). Always represents the user's list verbatim;
   *  the on/off state of the filter lives in `pdfWatermarkFilterEnabled` so
   *  toggling the wand button never destroys the list. */
  pdfWatermarkFilter: string[];

  /** Whether the watermark filter is currently active. Decoupled from the
   *  list itself so toggling off doesn't drop the user's terms — the list
   *  survives across reload, settings edits, and "off then on" cycles. */
  pdfWatermarkFilterEnabled: boolean;

  /** PDF render mode.
   *  - 'auto' (default): tile above 1.05× zoom, full-page below — crisp at deep zoom.
   *  - 'standard': always full-page, never tile. Smoother gesture feel; pixels go soft
   *    past the browser canvas-max dimension (~5–6× on A4). Firefox-style.
   *  - 'always-tile': tile at every zoom. Mostly a debugging escape hatch. */
  pdfRenderMode: 'auto' | 'standard' | 'always-tile';

  /** Enable PDF pan boundary clamps.
   *  - true (default): hard clamps on first/last page Y and page-fits-screen
   *    X centering. Prevents accidentally scrolling off the document.
   *  - false: free pan in both axes. Page-flip thresholds still fire as the
   *    user crosses them; nothing stops scroll motion regardless of position.
   *  Zoom range is unaffected (always 0.5–10) either way. */
  pdfEnableBoundaries: boolean;

  /** Fraction of screen dimension panned per WSAD keypress. Range 0.02–0.30, default 0.10. */
  keyboardPanFraction: number;

  /** Raw scroll-delta equivalent per Shift+W / Shift+S keypress. Range 50–400, default 100.
   *  Maps to zoom factor via 2^(1.3 × Δ/500). Used by both board and PDF surfaces. */
  keyboardZoomDelta: number;

  /** Debug: draw a crosshair at each pin's exact file coordinates */
  showPadVertices: boolean;
  /** Debug: show numbered markers at each outline vertex */
  showVertexNumbers: boolean;
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
  /** Animated exponential wheel zoom (cursor-anchored tween). Off = legacy
   *  instant/pixi-viewport zoom. */
  smoothZoom: boolean;
  /** Require two fingers for panning (one finger does nothing); useful for trackpad users */
  twoFingerPan: boolean;
  /**
   * When scroll is configured to pan, override classic mouse-wheel events
   * (sustained-burst timing) to zoom instead — avoids jerky
   * one-notch-equals-100px pan behavior. Trackpads and fine-grained wheels
   * are unaffected by the heuristic. Default: false — the per-event override
   * could split a single Mac/Safari smooth-scrolled click into mixed pan+zoom
   * frames; users who want the safety net can re-enable it in Settings.
   */
  wheelDetection: boolean;
  /**
   * When true, bare left-drag on the board zooms (vertical delta, anchored
   * at the initial click point) and Shift+left-drag pans. When false
   * (default), bare left-drag pans via pixi-viewport and Shift+left-drag
   * zooms. Does not affect trackpad two-finger scroll, scroll wheel, pinch,
   * or right/middle mouse button behavior. Default: false.
   */
  dragToZoom: boolean;

  /** @deprecated Superseded by `pinGroups`. Retained so older persisted
   *  settings still parse and can be migrated (migrateToPinGroups). Not read by
   *  the pin-colour resolver anymore. */
  netColorRules: NetColorRule[];

  /** Pin/net colour groups — the source of truth for pin fill colours and
   *  outline-only (no-connect-style) rendering. Each group is an ordered list
   *  of keyword→colour rules; first matching rule across all groups wins. */
  pinGroups: PinGroup[];

  /** Default pin fill color (hex `#rrggbb`) applied when no `pinGroups` rule
   *  matches. Separate values for the top and bottom side of the board.
   *  Traditional defaults: green top, red bottom. */
  defaultPinColorTop: string;
  defaultPinColorBottom: string;

  /** @deprecated Folded into `pinGroups` (the outline-only group). Kept for
   *  migration of older persisted settings. */
  ncNetPatterns: string[];

  /** Part Types — ordered list of component categories with prefix rules. */
  partTypes: PartType[];

  /** How many hops the hierarchical (chain-adjacent) net-line mode propagates
   *  through bridging parts. 1 = immediate neighbours only; higher follows the
   *  signal further down series chains. Clamped to 1–4 by the UI. */
  hierarchyDepth: number;

  /** BoardViewer overlay row — ordered slot list, persisted globally. */
  overlayLayout: OverlaySlot[];
  /** Action when picking a part from the Parts dropdown. */
  overlayPartsOnSelect: 'highlight' | 'panIfOffscreen' | 'panZoomFit';
  /** Action when picking a net from the Nets dropdown. */
  overlayNetsOnSelect: 'highlight' | 'panIfOffscreen' | 'panZoomFit';
  /** Overlay row position. 'left' (default) keeps the row in its
   *  historical position. 'center' centers it horizontally. */
  overlayPosition: 'left' | 'center';
  /** Auto-enable selection-dim while a search-driven selection (focusPart /
   *  focusNet) is active, even if the user's showNetDim toggle is off. */
  searchAutoDim: boolean;
  /** Auto-detect mechanical/oversized parts (EMI shields, heatsink frames,
   *  opposite-side connector shadows) and render them without a body fill so
   *  the smaller components they overlap stay visible. Pin shapes and border
   *  outlines still draw normally. When off, only user-marked
   *  (`partOverrides.sendToBack`) parts are affected. */
  autoMarkMechanical: boolean;
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

const DEFAULT_NET_COLOR_RULES: NetColorRule[] = [
  { id: 'gnd',  pattern: 'GND',  color: '#666666', enabled: true },
  { id: 'vcc',  pattern: 'VCC',  color: '#dd3333', enabled: true },
  { id: 'pp',   pattern: 'PP',   color: '#dd6633', enabled: true },
];

/** Canonical pin/net groups. Colours for Power/Ground/PP preserve the legacy
 *  net-colour-rule values; Datalines/Logical are new. The Misc group is
 *  outline-only (the old no-connect rendering). */
export const DEFAULT_PIN_GROUPS: PinGroup[] = [
  {
    id: 'power', label: 'Power', outlineOnly: false,
    rules: [
      { id: 'power-v',  keywords: 'VCC, 3VA, VDD, VSG, 3VS, 5VS', color: '#dd3333' },
      { id: 'power-pp', keywords: 'PP',                           color: '#dd6633' },
    ],
  },
  {
    id: 'ground', label: 'Ground', outlineOnly: false,
    rules: [
      // Separate / analog grounds get the lighter shade. Listed BEFORE the
      // main GND rule because substring matching would otherwise let AGND fall
      // into GND first (AGND contains "GND"). AGND ≡ VSS per spec.
      { id: 'gnd-sep', keywords: 'AGND, VSS', color: '#9a9a9a' },
      { id: 'gnd',     keywords: 'GND',       color: '#666666' },
    ],
  },
  {
    id: 'datalines', label: 'Datalines', outlineOnly: false,
    rules: [
      { id: 'serial', keywords: 'I2C, SPI, SDA, SCL, SPMI, UART, SMB', color: '#d96bb0' },
      { id: 'pci',    keywords: 'PCI',                                 color: '#3a7bd5' },
      { id: 'ddr',    keywords: 'DDR',                                 color: '#6fa8e0' },
    ],
  },
  {
    id: 'logical', label: 'Logical', outlineOnly: false,
    rules: [
      { id: 'enable', keywords: 'EN, RESET, RST, SW#', color: '#3aa6a0' },
      { id: 'onoff',  keywords: 'ONOFF',               color: '#9a6bd9' },
    ],
  },
  {
    id: 'misc', label: 'Misc', outlineOnly: true,
    rules: [
      { id: 'nc', keywords: 'NC, NC_*, NO CONNECT, N/C', color: '#555555' },
    ],
  },
];

/**
 * Match one keyword against an upper-cased net name.
 *  - `*` is a wildcard run, `#` matches a run of digits → anchored regex.
 *  - No wildcard: substring match for normal groups (so VCC→VCCIO, GND→AGND
 *    keep working as before), exact match for outline-only groups (so the bare
 *    keyword `NC` never catches `SYNC` — preserves the old isNcNet behaviour).
 */
export function matchPinGroupKeyword(netUpper: string, keyword: string, exact: boolean): boolean {
  const kw = keyword.trim().toUpperCase();
  if (!kw) return false;
  if (kw.includes('*') || kw.includes('#')) {
    const re = '^' + kw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/#/g, '[0-9]+') + '$';
    try { return new RegExp(re).test(netUpper); } catch { return false; }
  }
  return exact ? netUpper === kw : netUpper.includes(kw);
}

/** Resolve the first matching pin group/rule for a net name, or null. */
export function resolvePinGroup(
  settings: RenderSettings,
  netName: string,
): { color: number; outlineOnly: boolean } | null {
  if (!netName || !settings.pinGroups) return null;
  const upper = netName.toUpperCase();
  for (const group of settings.pinGroups) {
    for (const rule of group.rules) {
      for (const kw of rule.keywords.split(',')) {
        if (matchPinGroupKeyword(upper, kw, group.outlineOnly)) {
          return { color: parseInt(rule.color.replace('#', ''), 16), outlineOnly: group.outlineOnly };
        }
      }
    }
  }
  return null;
}

/** True when a net should render as an outline-only pin (no fill / no labels). */
export function isOutlineOnlyNet(settings: RenderSettings, netName: string): boolean {
  return resolvePinGroup(settings, netName)?.outlineOnly ?? false;
}

/**
 * Build pinGroups for a settings object that predates them (migration). Starts
 * from the canonical defaults; folds any *custom* legacy netColorRules (beyond
 * the built-in gnd/vcc/pp) into a "Custom" group, and replaces the Misc/NC
 * keywords if the user customised ncNetPatterns.
 */
export function migrateToPinGroups(s: Partial<RenderSettings>): PinGroup[] {
  const groups: PinGroup[] = DEFAULT_PIN_GROUPS.map(g => ({ ...g, rules: g.rules.map(r => ({ ...r })) }));
  const legacyDefaults = new Set(['GND', 'VCC', 'PP']);
  const custom = (s.netColorRules ?? []).filter(r => r.enabled && !legacyDefaults.has(r.pattern.toUpperCase()));
  if (custom.length) {
    groups.splice(groups.length - 1, 0, {
      id: 'custom-legacy', label: 'Custom', outlineOnly: false,
      rules: custom.map((r, i) => ({ id: `legacy-${i}`, keywords: r.pattern, color: r.color })),
    });
  }
  if (s.ncNetPatterns && s.ncNetPatterns.length) {
    const misc = groups.find(g => g.id === 'misc');
    if (misc) misc.rules = [{ id: 'nc', keywords: s.ncNetPatterns.join(', '), color: '#555555' }];
  }
  return groups;
}

export const DEFAULTS: RenderSettings = {
  outlineWidth: 3,
  outlineAlpha: 0.8,

  partBorderWidth: 1,
  partBorderAlpha: 0.4,
  partPadding: 4,
  showPartLabels: true,
  partLabelShadow: false,
  pinLabelShadow: true,
  labelMinSize: 3,
  partLabelScale: 1,
  pinNumberScale: 1,
  netLabelScale: 1,
  diodeValueScale: 1,
  labelHideThreshold: 2,

  pinMinRadius: 3,
  pinMaxRadius: 15,
  pinScaleFactor: 1,
  pinSizeScale: 1,
  partMinBodyRatio: 0.8,
  pinAlpha: 0.85,
  showPinNumbers: true,
  showPin1Marker: true,
  showDiodeValues: true,
  labelMinScreenPx: 3,
  labelZoomHide: 0,
  selectedLabelMinPx: 11,
  selectedLabelLodRelax: 0.75,
  textFastMode: true,

  selectionWidth: 2,
  selectionPadding: 4,
  selectionFillAlpha: 0.07,
  navTargetSize: 0.25,
  navZoomMode: 'auto',
  netHighlightGrow: 3,
  netHighlightAlpha: 0.6,
  showSelectionHalo: true,
  dimOverlayAlpha: 0.5,
  ambientDim: true,

  netLineWidth: 3.5,
  netLineAlpha: 0.6,
  netLineColor: 0xffff44,
  adjacentNetLineColor: 0x4488ff,
  netLineDashed: false,
  netLineDashLength: 8,
  netLinePulse: false,

  boardFillAlpha: 0.08,
  useMetadataBoardColor: false,

  showElevatedPartLabel: false,
  showElevatedPinLabel: false,
  showSelectionOverlay: true,

  hideTextDuringZoom: true,
  labelAtlasResolution: 8,
  cap60Fps: false,
  showPerfOverlay: false,

  circleLabelMinScreenPx: 3,
  twoPinLabelMinScreenPx: 6,
  pinNetLabelBg: true,
  twoPinNetLabelBg: true,
  bgaLabelGapFactor: 0,
  twoPinLabelGapFactor: 0.6,

  pdfWatermarkFilter: [
    'Vinafix',
    'www.chinafix.com',
    'www.xinxunwei.com',
    'notebookschematics.com',
    'notebook-schematics.com',
  ],
  pdfWatermarkFilterEnabled: true,

  pdfRenderMode: 'standard',
  pdfEnableBoundaries: true,

  showPadVertices: false,
  showVertexNumbers: false,
  showComponentColors: true,
  componentFillAlpha: 0.55,

  keyboardPanFraction: 0.10,
  keyboardZoomDelta: 100,

  clickThreshold: 15,
  fitPadding: 50,
  disableInertia: true,
  wheelSmooth: 5,
  smoothZoom: true,
  twoFingerPan: true,
  wheelDetection: false,
  dragToZoom: false,

  netColorRules: DEFAULT_NET_COLOR_RULES.map(r => ({ ...r })),
  pinGroups: DEFAULT_PIN_GROUPS.map(g => ({ ...g, rules: g.rules.map(r => ({ ...r })) })),
  defaultPinColorTop: '#44cc44',
  defaultPinColorBottom: '#cc4444',

  ncNetPatterns: ['NC', 'NC_*', 'N/C', 'NO CONNECT'],

  partTypes: [
    { id: 'resistor',  label: 'Resistor',   prefixes: ['R', 'PR', 'PH'],       color: '#222222', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: true },
    { id: 'capacitor', label: 'Capacitor',  prefixes: ['C', 'PC'],             color: '#9a5a35', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: false },
    { id: 'inductor',  label: 'Inductor',   prefixes: ['L', 'PL', 'B'],        color: '#7a7a7a', padShape: 'natural', bodyShape: 'square',  hidden: false, hierarchyBridge: true },
    { id: 'diode',     label: 'Diode',      prefixes: ['D', 'PD', 'Z', 'PZ'],  color: '#2255aa', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: true },
    { id: 'crystal',   label: 'Crystal',    prefixes: ['Y', 'X'],              color: '#e2ee00', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: false },
    { id: 'transistor', label: 'Transistor', prefixes: ['Q', 'PQ'],             color: '#0d6b55', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: false },
    { id: 'ic',        label: 'IC',         prefixes: ['U', 'PU'],             color: '#5a2090', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: false },
    { id: 'connector', label: 'Connector',  prefixes: ['J', 'SW'],             color: '#2a5080', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: false },
    { id: 'fuse',      label: 'Fuse',       prefixes: ['F'],                   color: '#efefef', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: false },
    { id: 'testpoint', label: 'Test Point', prefixes: ['TP'],                  color: '#4a9060', padShape: 'round',   bodyShape: 'natural', hidden: false, hierarchyBridge: false },
    { id: 'shield',    label: 'Shield',     prefixes: ['SH', 'MEC'],           color: '#3a3a3a', padShape: 'natural', bodyShape: 'natural', hidden: false, hierarchyBridge: false },
  ],
  hierarchyDepth: 2,

  overlayLayout: DEFAULT_OVERLAY_LAYOUT.map(s => ({ ...s })),
  overlayPartsOnSelect: 'panZoomFit',
  overlayNetsOnSelect: 'panZoomFit',
  overlayPosition: 'left',
  searchAutoDim: true,
  autoMarkMechanical: true,
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

/** Compute display radius for a pin. At scaleFactor=0 all pins are pinMinRadius.
 *  `pinSizeScale` is a final uniform multiplier (Resize Mode's pin knob) applied
 *  after the min/max clamp so it grows/shrinks every pin regardless of file
 *  radius — pinMinRadius alone is only a floor and can't shrink larger pins. */
export function computePinRadius(s: RenderSettings, fileRadius: number): number {
  const base = fileRadius || s.pinMinRadius;
  const r = s.pinMinRadius + (base - s.pinMinRadius) * s.pinScaleFactor;
  const clamped = Math.min(s.pinMaxRadius, Math.max(s.pinMinRadius, r));
  return clamped * (s.pinSizeScale || 1);
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
  pins: { position: { x: number; y: number }; radius?: number; padBounds?: { minX: number; minY: number; maxX: number; maxY: number } }[],
  s: RenderSettings,
): EffectiveBounds {
  let { minX, minY, maxX, maxY } = bounds;
  // Expand the AABB to include each pin's real pad outline when the parser
  // exposes it (TVW / Allegro / XZZ populate pin.padBounds). `bounds` from
  // the parser is the AABB of pin CENTRES only, so on parts with wide /
  // overhanging pads (RP-series resistor packs, regulator IC corner pads)
  // the outline + selection rectangle were cutting through the pads. Union
  // of pin.padBounds gives the true pad extent. Parsers without padBounds
  // (BVR/BDV/CAD/Mentor) hit this code as a no-op and behaviour matches
  // pre-fix.
  for (const pin of pins) {
    const pb = pin.padBounds;
    if (!pb) continue;
    if (pb.minX < minX) minX = pb.minX;
    if (pb.maxX > maxX) maxX = pb.maxX;
    if (pb.minY < minY) minY = pb.minY;
    if (pb.maxY > maxY) maxY = pb.maxY;
  }
  let horiz = false;
  const isSmallPart = pins.length <= 4;

  if (isSmallPart && pins.length >= 2) {
    // Determine orientation from the two most distant pins
    const p0 = pins[0].position;
    const p1 = pins[pins.length - 1].position;
    horiz = Math.abs(p0.x - p1.x) >= Math.abs(p0.y - p1.y);
    const dist = Math.sqrt((p1.x - p0.x) ** 2 + (p1.y - p0.y) ** 2);
    const inflate = dist * s.partMinBodyRatio;
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
 * Uses PCA (principal component analysis) on pin positions to find the axis
 * of maximum variance. If the OBB saves >30% area vs the AABB, it's diagonal
 * enough to warrant an oriented outline.
 */
export function computeDiagonalOBB(
  pins: { position: { x: number; y: number }; radius?: number }[],
  s: RenderSettings,
): [number, number][] | null {
  if (pins.length < 3) return null;

  // Axis-aligned chip-layout guard: when a substantial fraction of pins
  // sit exactly on the AABB perimeter and at least one horizontal and one
  // vertical edge are populated, the part is a normal QFN/QFP/DFN-style
  // chip and the AABB is correct. PCA on partial-perimeter pinouts (e.g.
  // Quanta DrMOS exports that label pins only on left+bottom edges)
  // otherwise returns a 45° principal axis, the area gate accepts it
  // because the L-shaped point cloud fits a rotated rectangle far smaller
  // than the AABB, and the part renders as a diamond. This guard runs
  // first so PCA never gets the chance.
  {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const pin of pins) {
      const x = pin.position.x, y = pin.position.y;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const span = Math.max(maxX - minX, maxY - minY);
    const eps = Math.min(2, span * 0.01);
    let onL = 0, onR = 0, onT = 0, onB = 0, onAny = 0;
    for (const pin of pins) {
      const isL = Math.abs(pin.position.x - minX) <= eps;
      const isR = Math.abs(pin.position.x - maxX) <= eps;
      const isB = Math.abs(pin.position.y - minY) <= eps;
      const isT = Math.abs(pin.position.y - maxY) <= eps;
      if (isL) onL++;
      if (isR) onR++;
      if (isB) onB++;
      if (isT) onT++;
      if (isL || isR || isB || isT) onAny++;
    }
    const hasH = onT >= 2 || onB >= 2;
    const hasV = onL >= 2 || onR >= 2;
    if (hasH && hasV && onAny >= pins.length * 0.4) return null;
  }

  // Centroid
  let cx = 0, cy = 0;
  for (const pin of pins) { cx += pin.position.x; cy += pin.position.y; }
  cx /= pins.length; cy /= pins.length;

  // Covariance matrix [cxx cxy; cxy cyy]
  let cxx = 0, cxy = 0, cyy = 0;
  for (const pin of pins) {
    const dx = pin.position.x - cx;
    const dy = pin.position.y - cy;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }

  // Principal eigenvector via analytic solution for 2×2 symmetric matrix
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lambda1 = trace / 2 + disc; // largest eigenvalue
  // Eigenvector for lambda1
  let ux: number, uy: number;
  // Degeneracy check uses the correlation ratio, not a raw 1e-6 floor: a
  // 908-pin diamond-BGA accumulates cxy ≈ 3 from sub-mil pin-placement
  // noise even when the analytic diamond is perfectly symmetric — that's
  // seven orders of magnitude below cxx/cyy (~1e8) yet still above the
  // old 1e-6 gate, so it was being interpreted as a "tilted" PCA axis
  // and rejected by the |ux·uy|<0.15 axis-alignment guard below.
  const varAvg = (cxx + cyy) / 2;
  const isNearSquare = Math.abs(cxx - cyy) < varAvg * 0.01;
  const isDecorrelated = Math.abs(cxy) < varAvg * 0.01;
  if (isNearSquare && isDecorrelated) {
    // PCA degenerate — pin cloud is 90°-rotation symmetric. Could be an
    // axis-aligned square BGA (AABB is already optimal) or a 45°-rotated
    // diamond BGA (AABB is ~2× too big). Probe a 45° axis; the later
    // area-saving gate rejects it for the genuine axis-aligned case.
    ux = Math.SQRT1_2; uy = Math.SQRT1_2;
  } else if (Math.abs(cxy) > 1e-6) {
    ux = lambda1 - cyy; uy = cxy;
  } else {
    // Axis-aligned anisotropic distribution (rectangular BGA, DIMM, etc.) —
    // AABB is already optimal.
    return null;
  }
  const len = Math.hypot(ux, uy);
  if (len < 1e-6) return null;
  ux /= len; uy /= len;
  // Reject near-axis-aligned principal axes. ux*uy = sin(2θ)/2, so
  // |ux*uy| < 0.15 corresponds to ~9° from horizontal/vertical. Parts
  // placed at multiples of 90° (most of them) have axis-aligned bboxes
  // and don't need an OBB at all — but slight pin asymmetry in
  // connectors etc. produces a tiny non-zero covariance term that
  // would otherwise yield a visibly skewed parallelogram outline.
  if (Math.abs(ux * uy) < 0.15) return null;
  const vx = -uy, vy = ux;

  // Project all pins onto principal axes
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

  // Compare OBB area vs AABB area — only use OBB if it saves >30%
  const obbW = maxU - minU, obbH = maxV - minV;
  let aabbW = 0, aabbH = 0;
  for (const pin of pins) {
    const dx = Math.abs(pin.position.x - cx);
    const dy = Math.abs(pin.position.y - cy);
    if (dx * 2 > aabbW) aabbW = dx * 2;
    if (dy * 2 > aabbH) aabbH = dy * 2;
  }
  const obbArea = obbW * obbH;
  const aabbArea = aabbW * aabbH;
  if (aabbArea < 1 || obbArea / aabbArea > 0.7) return null;

  // Pad the OBB
  const pad = pins.length <= 4
    ? 0
    : computeMultiPinPadding(s, pins.map(p => p.radius ?? 0));
  minU -= pad; maxU += pad;
  minV -= pad; maxV += pad;

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
  const halfW = dist * s.partMinBodyRatio / 2;
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

/**
 * Compute two rotated pad polygons for a diagonal 2-pin part.
 * Each pad is a rotated rectangle centered on its pin, spanning the full body
 * width perpendicular to the pin axis and ~40% of the body length along it.
 * Returns null if the part is not a valid diagonal 2-pin.
 */
export function computeDiag2PinPads(
  pins: { position: { x: number; y: number }; radius?: number }[],
  s: RenderSettings,
): { pads: [number, number][][]; ux: number; uy: number; vx: number; vy: number; halfW: number } | null {
  if (pins.length !== 2) return null;
  const p0 = pins[0].position;
  const p1 = pins[1].position;
  const dx = p1.x - p0.x, dy = p1.y - p0.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return null;

  // Same axes and dimensions as computeTwoPinOBB
  const ux = dx / dist, uy = dy / dist;
  const vx = -uy, vy = ux;
  const halfW = dist * s.partMinBodyRatio / 2;
  const ext = halfW * 0.5;
  const halfLen = dist / 2 + ext;
  const bodyW = halfW * 2;

  // Pad depth along axis: same ratio as axis-aligned (min of short axis, long axis * 0.4)
  const padDepth = Math.min(bodyW, halfLen * 2 * 0.4);
  const padHL = padDepth / 2;

  // Clamp so pads don't exceed OBB edges: pin is at ±dist/2 from center,
  // OBB edge is at ±halfLen, so outward limit from pin = ext
  const makePad = (px: number, py: number, outwardSign: number): [number, number][] => {
    // From pin center: extend padHL inward (toward other pin) and min(padHL, ext) outward
    const inner = padHL;
    const outer = Math.min(padHL, ext);
    // outwardSign: -1 for p0 (OBB edge at -halfLen), +1 for p1 (OBB edge at +halfLen)
    const e0 = -inner * outwardSign; // toward other pin
    const e1 = outer * outwardSign;  // toward OBB edge
    const lo = Math.min(e0, e1), hi = Math.max(e0, e1);
    return [
      [px + lo * ux - halfW * vx, py + lo * uy - halfW * vy],
      [px + hi * ux - halfW * vx, py + hi * uy - halfW * vy],
      [px + hi * ux + halfW * vx, py + hi * uy + halfW * vy],
      [px + lo * ux + halfW * vx, py + lo * uy + halfW * vy],
    ];
  };

  return { pads: [makePad(p0.x, p0.y, -1), makePad(p1.x, p1.y, 1)], ux, uy, vx, vy, halfW };
}

/** OBB built by projecting pin positions onto axes rotated by `angleRad`.
 *  Used when the source format records an explicit part rotation, so we don't
 *  need PCA to discover it (and don't apply the area-saving gate that PCA
 *  needs to suppress spurious tilts on axis-aligned parts). */
function computeRotatedOBB(
  pins: { position: { x: number; y: number }; radius?: number }[],
  angleRad: number,
  s: RenderSettings,
): [number, number][] | null {
  if (pins.length === 0) return null;
  let cx = 0, cy = 0;
  for (const pin of pins) { cx += pin.position.x; cy += pin.position.y; }
  cx /= pins.length; cy /= pins.length;
  const ux = Math.cos(angleRad), uy = Math.sin(angleRad);
  const vx = -uy, vy = ux;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const pin of pins) {
    const dx = pin.position.x - cx;
    const dy = pin.position.y - cy;
    const u = dx * ux + dy * uy;
    const v = dx * vx + dy * vy;
    if (u < minU) minU = u; if (u > maxU) maxU = u;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const pad = pins.length <= 4 ? 0 : computeMultiPinPadding(s, pins.map(p => p.radius ?? 0));
  minU -= pad; maxU += pad; minV -= pad; maxV += pad;
  return [
    [cx + minU * ux + minV * vx, cy + minU * uy + minV * vy],
    [cx + maxU * ux + minV * vx, cy + maxU * uy + minV * vy],
    [cx + maxU * ux + maxV * vx, cy + maxU * uy + maxV * vy],
    [cx + minU * ux + maxV * vx, cy + minU * uy + maxV * vy],
  ];
}

/** Convenience wrapper: compute OBB polygon for a part, or null if axis-aligned. */
export function computePartRenderPoly(
  part: { angleDeg?: number; pins: { position: { x: number; y: number }; radius?: number }[] },
  s: RenderSettings,
): [number, number][] | null {
  // Explicit rotation from the source format (e.g. XZZ's per-pad angleDeg
  // resolved into a single part angle) — bypass PCA. Multiples of 90° are
  // axis-aligned and fall through to the heuristic path.
  if (part.angleDeg !== undefined && part.pins.length > 0) {
    const mod90 = ((part.angleDeg % 90) + 90) % 90;
    if (mod90 > 0.5 && mod90 < 89.5) {
      return computeRotatedOBB(part.pins, mod90 * Math.PI / 180, s);
    }
  }
  // Check diagonal 2-pin parts first
  if (part.pins.length === 2) {
    const dx = Math.abs(part.pins[1].position.x - part.pins[0].position.x);
    const dy = Math.abs(part.pins[1].position.y - part.pins[0].position.y);
    const ratio = Math.min(dx, dy) / (Math.max(dx, dy) || 1);
    if (ratio > 0.4) return computeTwoPinOBB(part.pins, s);
  }
  return computeDiagonalOBB(part.pins, s);
}

/** Resolve the matching part-type override for a part name by scanning every
 *  prefix in every PartType (longest prefix wins, ties broken by type order). */
export function resolvePartType(partName: string, s: RenderSettings): PartType | undefined {
  const upper = partName.toUpperCase();
  let bestType: PartType | undefined;
  let bestLen = 0;
  for (const type of s.partTypes) {
    for (const rawPrefix of type.prefixes) {
      const p = rawPrefix.trim().toUpperCase();
      if (!p) continue;
      if (upper.startsWith(p) && p.length > bestLen) {
        bestLen = p.length;
        bestType = type;
      }
    }
  }
  return bestType;
}

export function resolvePartTypeOverride(partName: string, s: RenderSettings): PartTypeOverride | undefined {
  const bestType = resolvePartType(partName, s);
  if (!bestType) return undefined;
  return {
    padShape: bestType.padShape,
    bodyShape: bestType.bodyShape,
    hidden: bestType.hidden,
    color: bestType.color,
  };
}

/** True when the hierarchical (chain-adjacent) net-line mode should bridge nets
 *  through this part regardless of pin count — per its PartType's
 *  `hierarchyBridge` flag. Unmatched refdes (no type) never bridge. */
export function partBridgesHierarchy(partName: string, s: RenderSettings): boolean {
  return resolvePartType(partName, s)?.hierarchyBridge ?? false;
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

/** Resolve pin color from a settings object (not necessarily the live one).
 *  Driven by `pinGroups`; the matched rule's colour wins (outline-only groups
 *  use it as the outline stroke colour). Falls back to the per-side default. */
export function resolvePinColor(settings: RenderSettings, netName: string, side: 'top' | 'bottom'): number {
  const g = resolvePinGroup(settings, netName);
  if (g) return g.color;
  const fallback = side === 'bottom' ? settings.defaultPinColorBottom : settings.defaultPinColorTop;
  return parseInt(fallback.replace('#', ''), 16);
}


/**
 * Theme overrides provider — set by themes.ts after both modules load. Avoids
 * a circular import: render-settings.ts can't import themeStore at module top
 * (themes.ts imports the RenderSettings type from here).
 *
 * Default returns undefined ⇒ no theme overrides ⇒ behaviour unchanged.
 */
type ThemeOverridesProvider = () => Partial<RenderSettings> | undefined;
let themeOverridesProvider: ThemeOverridesProvider = () => undefined;

/** Called by themes.ts at module init. Subsequent calls update the provider. */
export function setThemeOverridesProvider(provider: ThemeOverridesProvider) {
  themeOverridesProvider = provider;
}

const STORAGE_KEY = 'boardripper-render-settings';
const BOARD_OVERRIDES_KEY = 'boardripper-board-overrides';
const WHEEL_DETECTION_MIGRATED_KEY = 'boardripper-wheel-detection-migrated-v1';
/** One-time forced default: Text fast mode graduated to ON (v0.31.41). Any
 *  install whose persisted settings predate (or opted out during) the
 *  experimental window gets flipped ON exactly once; the user stays free to
 *  turn it back off afterwards — the marker prevents re-forcing. */
const TEXT_FAST_GRADUATED_KEY = 'boardripper-textfastmode-graduated-v1';
let pendingTextFastGraduationNotice = false;
/** True exactly once, on the first boot where the graduation migration ran
 *  against a pre-existing installation — drives the one-time "text rendering
 *  updated" notice in App.tsx. Consuming resets it. */
export function consumeTextFastGraduationNotice(): boolean {
  const v = pendingTextFastGraduationNotice;
  pendingTextFastGraduationNotice = false;
  return v;
}

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

/** Migrate legacy `partTypeOverrides` (prefix-keyed map) into the new
 *  `partTypes` array. For each default type, copy color/shape from the
 *  first matching legacy entry so user customizations survive. */
function migrateLegacyPartTypes(
  legacy: Record<string, Partial<PartTypeOverride>> | undefined,
): PartType[] {
  const types = structuredClone(DEFAULTS.partTypes);
  if (!legacy) return types;
  for (const type of types) {
    for (const prefix of type.prefixes) {
      const old = legacy[prefix] ?? legacy[prefix.toUpperCase()];
      if (old) {
        if (old.color) type.color = old.color;
        if (old.padShape) type.padShape = old.padShape;
        if (old.bodyShape) type.bodyShape = old.bodyShape;
        if (typeof old.hidden === 'boolean') type.hidden = old.hidden;
        break;
      }
    }
  }
  return types;
}

function loadFromStorage(): RenderSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Text-fast-mode graduation (one-time, marker-gated): force ON for
      // pre-existing installs and persist immediately so a stored `false`
      // can't resurface on the next boot. Fresh installs never reach this
      // branch (no stored settings) — the default already covers them.
      try {
        if (!localStorage.getItem(TEXT_FAST_GRADUATED_KEY)) {
          localStorage.setItem(TEXT_FAST_GRADUATED_KEY, '1');
          if (parsed.textFastMode !== true) {
            parsed.textFastMode = true;
            localStorage.setItem(STORAGE_KEY, JSON.stringify(parsed));
          }
          pendingTextFastGraduationNotice = true;
        }
      } catch { /* ignore quota/private-mode errors */ }
      const result: RenderSettings = { ...structuredClone(DEFAULTS), ...parsed };
      if (Array.isArray(parsed.partTypes)) {
        // New format — trust stored list but fall back to defaults if empty.
        result.partTypes = parsed.partTypes.length > 0
          ? parsed.partTypes
          : structuredClone(DEFAULTS.partTypes);
        // In-place rename: id 'mosfet' → 'transistor' (label too) from the
        // first Part Types commit. Preserves user customizations.
        for (const t of result.partTypes) {
          if (t.id === 'mosfet') {
            t.id = 'transistor';
            if (t.label === 'MOSFET') t.label = 'Transistor';
          }
          // Migration: hierarchyBridge added with the Connections feature.
          // Backfill from the matching default (resistors on, rest off);
          // custom user types with no default match stay off.
          if (typeof (t as Partial<PartType>).hierarchyBridge !== 'boolean') {
            t.hierarchyBridge = DEFAULTS.partTypes.find(d => d.id === t.id)?.hierarchyBridge ?? false;
          }
        }
        // Migration: shield gained the 'MEC' prefix default (MEC* refdes =
        // mechanical shield can). Users whose shield type still carries
        // exactly the old ['SH'] default get 'MEC' appended; any customised
        // prefix list is left untouched.
        const shield = result.partTypes.find(t => t.id === 'shield');
        if (shield && Array.isArray(shield.prefixes)
            && shield.prefixes.length === 1 && shield.prefixes[0] === 'SH') {
          shield.prefixes = ['SH', 'MEC'];
        }
      } else {
        // Legacy format — migrate prefix-keyed overrides into types.
        result.partTypes = migrateLegacyPartTypes(parsed.partTypeOverrides);
      }
      // Migration: pinGroups superseded netColorRules + ncNetPatterns. Old
      // persisted settings have no pinGroups → build them from defaults, folding
      // in any custom legacy rules. New persisted settings keep their groups
      // (fall back to defaults if the stored array is empty/corrupt).
      if (!Array.isArray(parsed.pinGroups) || parsed.pinGroups.length === 0) {
        result.pinGroups = migrateToPinGroups(parsed);
      } else {
        result.pinGroups = parsed.pinGroups;
      }

      // Clamp hierarchyDepth into the supported 1–4 range (the slider enforces
      // it, but guard hand-edited / corrupt persisted values). A missing key is
      // already backfilled by the DEFAULTS spread above.
      if (typeof result.hierarchyDepth !== 'number' || !Number.isFinite(result.hierarchyDepth)) {
        result.hierarchyDepth = DEFAULTS.hierarchyDepth;
      } else {
        result.hierarchyDepth = Math.max(1, Math.min(4, Math.round(result.hierarchyDepth)));
      }
      // Migration: label-size tier system (labelSize + labelSizeSmall/Medium/
      // Large) collapsed to a single labelMinSize. Take whichever tier was
      // active and assign it to the new field. Old fields then drop out of
      // the spread because they're no longer on RenderSettings.
      if (typeof result.labelMinSize !== 'number' || !Number.isFinite(result.labelMinSize)) {
        const p = parsed as Record<string, unknown>;
        const tier = p.labelSize;
        const pick = tier === 'large'  ? p.labelSizeLarge
                   : tier === 'medium' ? p.labelSizeMedium
                   :                     p.labelSizeSmall;
        if (typeof pick === 'number' && Number.isFinite(pick) && pick >= 1 && pick <= 30) {
          result.labelMinSize = pick;
        } else {
          result.labelMinSize = DEFAULTS.labelMinSize;
        }
      }
      // Migration: BGA gap formula was halved (factor now equals visible gap
      // as fraction of pin radius, not 2× of it) and the default dropped to 0.
      // Users on the previous default get the new default; other customizations
      // are preserved verbatim — they end up with half the visible gap they
      // had before, which is closer to the value the slider promised.
      if (result.bgaLabelGapFactor === 0.15) result.bgaLabelGapFactor = 0;
      // Migration: pinMaxRadius default dropped from 30 → 15. Users on the
      // previous default get the new cap so testpoints and other large-radius
      // pins stop dominating the view. Explicit customisations are preserved.
      if (result.pinMaxRadius === 30) result.pinMaxRadius = 15;
      // Migration: PDF watermark filter defaults grew over time. Whenever the
      // saved filter is an exact match for any previous compile-time default,
      // replace with the current default so users keep getting new
      // watermark patterns automatically. Explicit customisations (any other
      // contents) are preserved verbatim.
      const _wmF = result.pdfWatermarkFilter;
      const PRIOR_DEFAULTS: readonly (readonly string[])[] = [
        ['www.chinafix.com', 'NotebookSchematics.com'],
        ['Vinafix', 'www.chinafix.com', 'notebookschematics.com', 'notebook-schematics.com'],
      ];
      const _wmMatchesPrior = Array.isArray(_wmF) && PRIOR_DEFAULTS.some(
        d => _wmF.length === d.length && _wmF.every((v, i) => v === d[i])
      );
      if (_wmMatchesPrior) {
        result.pdfWatermarkFilter = structuredClone(DEFAULTS.pdfWatermarkFilter);
      }
      // Migration: pre-v0.30.7 the wand-toggle "off" state was persisted as
      // `pdfWatermarkFilter: []`, which destroyed the user's custom terms on
      // reload. Recover by promoting `[]` to the current defaults *and*
      // setting `pdfWatermarkFilterEnabled: false`. Users who had genuinely
      // cleared their list (rare) get the defaults back plus a one-click
      // toggle to dismiss — that's the better failure mode than silently
      // remaining empty forever.
      if (Array.isArray(_wmF) && _wmF.length === 0 && parsed.pdfWatermarkFilterEnabled === undefined) {
        result.pdfWatermarkFilter = structuredClone(DEFAULTS.pdfWatermarkFilter);
        result.pdfWatermarkFilterEnabled = false;
      } else if (parsed.pdfWatermarkFilterEnabled === undefined) {
        // Existing user, non-empty list, no flag yet → assume filter is on
        // (matches pre-v0.30.7 semantics where any non-empty list was active).
        result.pdfWatermarkFilterEnabled = true;
      }
      // Migration: wheelDetection default flipped true → false. The per-event
      // safety net could split a Mac/Safari smooth-scrolled wheel click into
      // mixed pan+zoom frames. Force-flip ONCE for users carrying the legacy
      // value; the guard flag prevents re-flipping if the user later turns
      // wheelDetection back on.
      if (parsed.wheelDetection === true && !localStorage.getItem(WHEEL_DETECTION_MIGRATED_KEY)) {
        result.wheelDetection = false;
      }
      try { localStorage.setItem(WHEEL_DETECTION_MIGRATED_KEY, '1'); } catch { /* ignore */ }
      // Migration: navAutoZoom (boolean) → navZoomMode (string). true → 'auto',
      // false → 'always'. The new 'keep' value is opt-in only.
      if (typeof parsed.navAutoZoom === 'boolean' && typeof parsed.navZoomMode !== 'string') {
        result.navZoomMode = parsed.navAutoZoom ? 'auto' : 'always';
      } else if (parsed.navZoomMode !== 'auto' && parsed.navZoomMode !== 'keep' && parsed.navZoomMode !== 'always') {
        result.navZoomMode = DEFAULTS.navZoomMode;
      }
      // Reconcile saved overlay layout (drop unknown slots, append new defaults)
      result.overlayLayout = reconcileOverlayLayout(parsed.overlayLayout);

      const partsMode = parsed.overlayPartsOnSelect;
      if (partsMode === 'highlight' || partsMode === 'panIfOffscreen' || partsMode === 'panZoomFit') {
        result.overlayPartsOnSelect = partsMode;
      }

      const netsMode = parsed.overlayNetsOnSelect;
      if (netsMode === 'highlight' || netsMode === 'panIfOffscreen' || netsMode === 'panZoomFit') {
        result.overlayNetsOnSelect = netsMode;
      }

      if (parsed.overlayPosition === 'left' || parsed.overlayPosition === 'center') {
        result.overlayPosition = parsed.overlayPosition;
      }

      if (parsed.pdfRenderMode === 'auto' || parsed.pdfRenderMode === 'standard' || parsed.pdfRenderMode === 'always-tile') {
        result.pdfRenderMode = parsed.pdfRenderMode;
      }
      // Clamp keyboard navigation settings to valid ranges
      result.keyboardPanFraction = Math.min(0.30, Math.max(0.02, result.keyboardPanFraction));
      result.keyboardZoomDelta = Math.min(400, Math.max(50, result.keyboardZoomDelta));
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
  // partTypes / pinGroups: board (and theme) overrides fully replace the global
  // list when present — deep-clone so callers can't mutate the override source.
  if (overrides.partTypes) {
    merged.partTypes = structuredClone(overrides.partTypes);
  }
  if (overrides.pinGroups) {
    merged.pinGroups = structuredClone(overrides.pinGroups);
  }
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

class RenderSettingsStore extends Emitter {
  private _global: RenderSettings = loadFromStorage();
  private _boardOverrides: Record<string, Partial<RenderSettings>> = loadBoardOverridesMap();
  private _activeBoard: string = '';
  private _effective: RenderSettings = this._global;

  private recomputeEffective() {
    const boardOv = this._activeBoard ? (this._boardOverrides[this._activeBoard] ?? {}) : {};
    // Theme overrides layer ON TOP of board overrides — themes are the user's
    // most recent intent ("I picked Landrex, please make everything monochrome")
    // and should override saved board-specific settings.
    const themeOv = themeOverridesProvider() ?? {};
    this._effective = mergeSettings(mergeSettings(this._global, boardOv), themeOv);
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


  /** Set the active board fileName — recomputes effective settings, notifies only if they changed */
  setActiveBoard(fileName: string) {
    if (this._activeBoard === fileName) return;
    // Recompute effective settings if switching boards could change them: when
    // either board carries per-board overrides, OR the active THEME carries
    // boardOverrides (e.g. Landrex greyscale, a custom theme's pin colours).
    // Missing the theme case meant a board loaded under a saved override-theme
    // rendered with un-merged settings until the next theme switch.
    const hadOverrides = this._activeBoard ? this.hasBoardOverrides(this._activeBoard) : false;
    const hasOverrides = fileName ? this.hasBoardOverrides(fileName) : false;
    const themeOv = themeOverridesProvider();
    const themeHasOverrides = !!themeOv && Object.keys(themeOv).length > 0;
    this._activeBoard = fileName;
    if (hadOverrides || hasOverrides || themeHasOverrides) {
      this.recomputeEffective();
      this.notify();
    }
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

  setOverlayLayout(layout: OverlaySlot[]) {
    this._global = { ...this._global, overlayLayout: layout.map(s => ({ ...s })) };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  /** Append a fresh separator slot to the end of the visible overlay row.
   *  The id is auto-generated as the next free `sep${N}`. */
  addOverlaySeparator() {
    const cur = this._global.overlayLayout ?? [];
    const id = nextSeparatorId(cur);
    // Insert after the last currently-visible slot so it lands at the end
    // of the visible row. If everything is hidden, append at the end.
    let lastVisIdx = -1;
    for (let i = 0; i < cur.length; i++) if (cur[i].visible) lastVisIdx = i;
    const next: OverlaySlot[] = [];
    let placed = false;
    for (let i = 0; i < cur.length; i++) {
      next.push({ ...cur[i] });
      if (i === lastVisIdx) { next.push({ id, visible: true }); placed = true; }
    }
    if (!placed) next.push({ id, visible: true });
    this._global = { ...this._global, overlayLayout: next };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setShowSelectionOverlay(v: boolean) {
    this._global = { ...this._global, showSelectionOverlay: v };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setOverlayPartsOnSelect(mode: 'highlight' | 'panIfOffscreen' | 'panZoomFit') {
    this._global = { ...this._global, overlayPartsOnSelect: mode };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setOverlayNetsOnSelect(mode: 'highlight' | 'panIfOffscreen' | 'panZoomFit') {
    this._global = { ...this._global, overlayNetsOnSelect: mode };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setOverlayPosition(pos: 'left' | 'center') {
    this._global = { ...this._global, overlayPosition: pos };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setPdfRenderMode(mode: 'auto' | 'standard' | 'always-tile') {
    if (this._global.pdfRenderMode === mode) return;
    this._global = { ...this._global, pdfRenderMode: mode };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  resetOverlayDefaults() {
    this._global = {
      ...this._global,
      overlayLayout: DEFAULT_OVERLAY_LAYOUT.map(s => ({ ...s })),
      overlayPartsOnSelect: 'panZoomFit',
      overlayNetsOnSelect: 'panZoomFit',
      overlayPosition: 'left',
    };
    saveToStorage(this._global);
    this.recomputeEffective();
    this.notify();
  }

  setSearchAutoDim(v: boolean) {
    this._global = { ...this._global, searchAutoDim: v };
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

// Expose for integration tests (Playwright) — DEV builds only
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  (window as { __renderSettings?: typeof renderSettingsStore }).__renderSettings = renderSettingsStore;
}

function normalizeForWatermark(s: string): string {
  // NFKC decomposes compatibility characters — crucially, Latin ligatures
  // like ﬁ (U+FB01), ﬂ (U+FB02), ﬀ, ﬃ, ﬄ, ﬆ — into their constituent
  // letters. Many vendor watermark fonts emit ligature glyphs for fi/fl/etc.,
  // so without this step "Vinaﬁx.com" never matches a "Vinafix" filter term.
  // Must stay in lock-step with the worker-side filter in the pdf.js patch.
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/** Return the effective watermark filter — the user's list when the filter is
 *  enabled, an empty array otherwise. Consumers should call this instead of
 *  reading `pdfWatermarkFilter` directly so the enabled flag is respected
 *  uniformly. */
export function getActiveWatermarkFilter(s: RenderSettings): string[] {
  return s.pdfWatermarkFilterEnabled !== false ? s.pdfWatermarkFilter : [];
}

export function isPdfWatermarkText(str: string, filter: string[]): boolean {
  if (!filter || filter.length === 0) return false;
  const norm = normalizeForWatermark(str);
  if (!norm) return false;
  for (const term of filter) {
    const nTerm = normalizeForWatermark(term);
    if (nTerm && norm.includes(nTerm)) return true;
  }
  return false;
}

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
    if (key === 'netColorRules' || key === 'ncNetPatterns' || key === 'partTypes') continue;
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

  // partTypes
  lines.push('');
  lines.push('  partTypes: [');
  for (const t of s.partTypes) {
    const prefixes = JSON.stringify(t.prefixes);
    lines.push(`    { id: '${t.id}', label: '${t.label}', prefixes: ${prefixes}, color: '${t.color}', padShape: '${t.padShape}', bodyShape: '${t.bodyShape}', hidden: ${t.hidden}, hierarchyBridge: ${t.hierarchyBridge} },`);
  }
  lines.push('  ],');
  lines.push('};');

  const result = lines.join('\n');
  log.render.log(result);
  return result;
}

// Expose on window for console access in dev
if (typeof window !== 'undefined' && import.meta.env.DEV) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).exportSettingsAsDefaults = exportSettingsAsDefaults;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__renderSettings = renderSettingsStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__overlayTest = { reconcileOverlayLayout, naturalCompare };
}
