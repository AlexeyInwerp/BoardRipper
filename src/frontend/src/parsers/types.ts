import { log } from '../store/log-store';

export interface Point {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface Pin {
  name: string;
  number: string;
  position: Point;
  radius: number;
  side: 'top' | 'bottom';
  net: string;
  /** Copper-pad rectangle in board coords. Optional — formats that expose it
   *  (Allegro) let the renderer hit-test and highlight the full pad area
   *  rather than just the pin sprite. */
  padBounds?: BBox;
  /** Pad shape — when set, the selection-highlight renderer draws the
   *  matching primitive (circle for 'round', rounded rect for 'roundrect'
   *  etc.) instead of the AABB rectangle. Mirrors `Pad.shape` and is
   *  populated by the same parser path; legacy parsers leave it undefined
   *  and the highlight falls back to drawing `padBounds` as a rectangle. */
  padShape?: PadShape;
  /** Original pre-rotation pad width/height in mils. Required for accurate
   *  drawing of rotated rects (where `padBounds` carries the rotated AABB,
   *  not the original dims). */
  padWidth?: number;
  padHeight?: number;
  padAngleDeg?: number;
  padCornerRadius?: number;
  /** Pre-translated polygon vertices in board coordinates for shape='poly'
   *  (chamfered / octagonal / freeform copper pads). Closed implicitly — the
   *  renderer connects the last vertex back to the first. When absent on a
   *  poly-shape pin, `drawPadShape` falls back to the rotated AABB rectangle. */
  padPolygon?: Point[];
  /** XZZ-baked per-pin diode-mode reference reading. Present only on boards
   *  that ship a diode-value channel (XZZ `.pcb` companion files). The OBD
   *  source is resolved separately, per-net, at display time — never stored
   *  here. See `store/diode-readings.ts`. */
  diode?: DiodeReading;
}

/** Where a diode-mode reading came from. `xzz-pcb` = baked into the XZZ
 *  companion file (per pin, millivolts). `obd` = OpenBoardData corpus
 *  (per net, volts), resolved via `pin.net` at display time. */
export type DiodeSource = 'xzz-pcb' | 'obd';

/** A single diode-mode multimeter reading, source-agnostic so one render /
 *  tooltip / panel path serves every source. */
export interface DiodeReading {
  /** Original token as stored: "359" (XZZ mV), "0.450" (OBD V), "OL", "0". */
  raw: string;
  /** value = a real reading; open = OL (infinite); none = 0 / no reading. */
  kind: 'value' | 'open' | 'none';
  /** Normalized millivolts when parseable (XZZ int; OBD volts×1000); else null. */
  mv: number | null;
  source: DiodeSource;
}

/** Descriptor for a board's XZZ-baked diode channel; presence on `BoardData`
 *  gates the XZZ source's UI. (The OBD source is gated independently by an OBD
 *  match existing for the board.) */
export interface DiodeReferenceChannel {
  source: 'xzz-pcb';
  units: 'mV';
  /** Histogram across all parsed records. */
  counts: { value: number; open: number; none: number };
  /** Records that joined to a pin / found no pin (diagnostics). */
  matched: number;
  unmatched: number;
}

export interface Part {
  name: string;
  side: 'top' | 'bottom' | 'both';
  type: 'smd' | 'throughhole';
  origin: Point;
  pins: Pin[];
  bounds: BBox;
  /** Layer index for multi-layer boards (0-based). Undefined = single-layer. */
  layer?: number;
  /** Present only on the `deriveBoardView()` output when a board-selection
   *  filter is active — marks parts outside the selected board so the
   *  renderer, hit-grid, net highlight, and label passes skip them. The array
   *  index is preserved so `selection.partIndex` stays consistent across
   *  filter changes. Never set by parsers. */
  hidden?: boolean;
  /** Auto-detected or user-marked "mechanical" parts (EMI shields, heatsink
   *  frames, opposite-side connector shadows). The scene builder skips the
   *  fill draw for these so the small components they overlap stay visible.
   *  Border + pins still render. Set by `flagMechanicalParts()` at scene
   *  build time when `renderSettings.autoMarkMechanical` is on; users can
   *  also force this via right-click. Never set by parsers. */
  mechanical?: boolean;
  /** Optional source-format metadata surfaced in the Component Info panel.
   *  Parsers populate whatever fields the format provides; consumers must
   *  treat every field as optional. Currently filled by TVW (Teboview);
   *  BVR/BDV/Allegro fill a subset where the same data exists. */
  meta?: PartMeta;
}

export interface PartMeta {
  /** BOM value, e.g. "100K", "10uF", "FCN-235P-G/0" */
  value?: string;
  /** Package / footprint name, e.g. "CHIP0603R", "QFN32" */
  package?: string;
  /** Human-readable part class, e.g. "IC", "Resistor", "Capacitor" */
  partType?: string;
  /** Manufacturer / part serial number */
  serial?: string;
  /** Component height in mils (Z-axis) */
  heightMils?: number;
  /** Rotation in degrees, if the source format records it */
  angleDeg?: number;
}

export interface Nail {
  position: Point;
  side: 'top' | 'bottom';
  net: string;
}

export interface Net {
  name: string;
  pinIndices: Array<{ partIndex: number; pinIndex: number }>;
}

export interface Trace {
  start: Point;
  end: Point;
  width: number;
  net: string;
  /** Layer index for multi-layer boards (0-based). Undefined = single-layer. */
  layer?: number;
}

/** Copper-fill polygon (ground plane, power pour, signal flood). Vertices are
 *  in board coordinates already pre-rotated/translated. `voids` carries
 *  cutouts (e.g. clearance gaps around through-hole pads). The renderer fills
 *  the outer polygon then punches out each void; nested voids aren't
 *  supported. */
export interface Surface {
  polygon: Point[];
  voids?: Point[][];
  net?: string;
  /** Layer index for multi-layer boards (0-based). Undefined → drawn on the
   *  TOP side container in single-layer mode. */
  layer?: number;
}

export interface Via {
  position: Point;
  /** Drill diameter in mils */
  diameter: number;
  net: string;
  /** Connected layer indices (0-based). Empty = through-hole (all layers). */
  layers: number[];
}

/** Per-component silkscreen / assembly drawing — open polyline (segments + arc samples)
 *  in board coordinates, already pre-rotated and pre-translated by the source format. */
export interface SilkscreenPath {
  points: Point[];
  side: 'top' | 'bottom';
}

/** Discriminator for the original copper-pad shape so the renderer can draw
 *  the right primitive. `bounds` always holds the axis-aligned envelope (used
 *  for hit-test and clipping); `shape` + `width`/`height`/`angleDeg`/
 *  `cornerRadius` describe the actual geometry. */
export type PadShape = 'round' | 'rect' | 'roundrect' | 'poly';

/** Copper pad — axis-aligned bounding rectangle in board coordinates,
 *  already pre-rotated and pre-translated. SMD pads have side='top'/'bottom';
 *  through-hole pads have side='both' and may carry a drill diameter. */
export interface Pad {
  bounds: BBox;
  side: 'top' | 'bottom' | 'both';
  net?: string;
  /** Drill diameter in mils — set for through-hole pads, omitted for SMD. */
  drill?: number;
  /** True when this pad sits under a component pin (real pin pad).
   *  False/undefined for standalone copper drops (GND stitching, power-rail
   *  tie pads, mounting-hole pads) that don't belong to any part. The
   *  renderer routes these to a separate, default-OFF visibility layer so
   *  the click-on-component view stays clean. Currently set by the TVW
   *  parser; other parsers can opt in later. */
  attached?: boolean;
  /** Original pad shape from the format. Undefined → renderer falls back to
   *  drawing `bounds` as a plain rectangle (legacy behaviour). */
  shape?: PadShape;
  /** Original pre-rotation width/height in mils — distinct from `bounds`,
   *  which carries the rotated AABB. Required for correct drawing of
   *  rotated rects/round-rects. */
  width?: number;
  height?: number;
  /** Rotation in degrees CCW around the pad centre. Multiples of 90 leave the
   *  AABB axis-aligned and are drawn directly with `gfx.rect`/`roundRect`;
   *  other angles fall back to a rotated polygon. */
  angleDeg?: number;
  /** RoundRect corner radius in mils. */
  cornerRadius?: number;
  /** Pre-translated polygon vertices in board coordinates for shape='poly'
   *  (chamfered / octagonal / freeform copper). Closed implicitly. When absent
   *  on a poly-shape pad, the renderer falls back to the rotated AABB rect. */
  polygon?: Point[];
}

export interface BoardData {
  format: string; // format ID from FormatDescriptor.id (e.g. 'BVR1', 'BVR3', 'BRD')
  /** Format-specific version extracted from file (e.g. "GENCAD 1.4", "17.2", "v7"). */
  formatVersion?: string;
  outline: Point[];
  parts: Part[];
  nails: Nail[];
  nets: Map<string, Net>;
  bounds: BBox;
  traces?: Trace[];
  /** Via/drill holes for multi-layer boards */
  vias?: Via[];
  /** Per-component silkscreen / assembly outline polylines, tagged by side. */
  silkscreen?: SilkscreenPath[];
  /** Copper pad rectangles, tagged by side ('both' = through-hole). */
  pads?: Pad[];
  /** Copper-fill polygons (ground planes, power pours). Per-layer for
   *  multi-layer boards. Voids inside each surface are punched out at render
   *  time. Only formats that expose copper geometry (TVW Surface blocks; for
   *  later: Allegro shapes, XZZ flood polygons) populate this; legacy
   *  formats leave it undefined and the surfaces layer renders empty. */
  surfaces?: Surface[];
  /** Layer names for multi-layer formats (e.g. TVW butterfly columns). Index = column. */
  layerNames?: string[];
  /** Butterfly fold axis in board coordinates — renderer mirrors this axis for the bottom half.
   *  When 'x', the board store also sets mirrorY on load to correct orientation.
   *  'x' = fold was vertical (left/right split), 'y' = fold was horizontal (top/bottom split). */
  butterflyFoldAxis?: 'x' | 'y';

  /** Pre-fold outline geometry. Present whenever the parser considered folding,
   *  regardless of whether it actually folded. Same NaN-break convention as
   *  `outline`. Absent for formats that never fold (e.g. BVR3, BRD). */
  rawOutline?: Point[];

  /** Outline-component bboxes from the clustering step, in pre-fold coords.
   *  Used by the fold-resolution UI to let the user see how the file's raw
   *  layout decomposed. */
  foldComponents?: Array<{ minX: number; minY: number; maxX: number; maxY: number; segCount: number }>;

  /** Describes the fold the parser applied, if any. Also carries a
   *  human-readable summary for UI display. `lowerIsBottom` records which
   *  half the parser mirrored (matches the parser's `FoldResult.lowerIsBottom`)
   *  so the renderer can reverse the mirror per trace-midpoint when
   *  re-unfolding for the "Show all sides" view. Absent when no fold was applied. */
  foldInfo?: {
    dim: 'x' | 'y';
    axis: number;
    lowerIsBottom: boolean;
    source: string;
    summary: string;
  };

  /** Outline components grouped into "boards" using an exact geometry match
   *  heuristic: two components with the same (width, height, segCount) are
   *  treated as top/bottom sides of one physical board. For each 2-component
   *  group we also compute a butterfly fold axis so the renderer can fold
   *  that individual board on demand. Absent when `foldComponents` is empty. */
  boardGroups?: Array<{
    components: number[];                 // indices into foldComponents
    fold?: {
      dim: 'x' | 'y';
      axis: number;                        // already normalised to the outline coord space
      lowerIsBottom: boolean;              // which half gets mirrored onto the other when folding
    };
    /** Optional human-readable name derived from the most common `groupName`
     *  among parts in the group. Examples: "RF Board", "AP", "SUB". Absent
     *  when the file doesn't tag parts or when dominant-name lookup failed. */
    name?: string;
  }>;

  /** Per-board flipY override. When set, takes precedence over the format descriptor's flipY. */
  flipY?: boolean;
  /** Per-board default flip axis for bottom-view rendering. 'x' = hinge on horizontal
   *  (Y-mirror on screen for rotation=0 boards), 'y' = hinge on vertical (X-mirror).
   *  When a vertical board is auto-rotated 270°, scene and screen axes swap, so the
   *  "intuitive" Y-mirror on screen requires flipAxis='y'. Used by CAD butterfly
   *  files where the exporter's butterfly layout + vertical auto-rotation would
   *  otherwise produce an X-mirrored bottom view. */
  flipAxis?: 'x' | 'y';
  /** Which part.side value the user perceives as "top" (CPU side). Defaults to 'top'.
   *  When 'bottom', the renderer swaps which scene layer each part goes into so that
   *  pressing "Top" shows parts whose parser-assigned side is 'bottom'. Set when the
   *  file's pin-majority lands on side='bottom' (e.g. Quanta Allegro files where the
   *  inst.layer byte convention is inverted relative to the label table). */
  primarySide?: 'top' | 'bottom';
  /** Multi-revision payload for files that accumulate prior revisions of the
   *  same board (e.g. some V382 .cad exports). When present and length > 1,
   *  the UI exposes a revision picker. The revision currently mirrored into
   *  the top-level parts/bounds/outline fields is identified by activeRevision. */
  revisions?: BoardRevision[];
  /** 1-based index into revisions[] of the currently rendered revision. */
  activeRevision?: number;
  /** Stale/ghost components that overlap with a "dominator" part on the same
   *  side AND whose net set is a subset of the dominator's. Likely leftover
   *  refdes from a prior revision that the source CAD tool failed to remove
   *  (e.g. J8 left in place after being upgraded to J4008). Surfaced in the
   *  UI so the user can verify against the physical board, never auto-pruned. */
  ghosts?: GhostComponent[];
  /** Mutually-exclusive BOM-alternate clusters: groups of overlapping
   *  same-role parts (R↔R, C↔C, L↔L) that share net connectivity. Only one
   *  member per cluster is actually fitted in any given BOM variant. */
  bomClusters?: BomAlternateCluster[];
  /** Human-readable notes about transformations the parser applied to the
   *  raw file data — e.g. "Un-mirrored X coords (v1 SERG_UKRAINE converter)".
   *  Surfaced to the user as an info toast on load so the fixup is not silent. */
  parserNotes?: string[];

  /** Present ⇒ this board ships XZZ-baked diode readings (gates the XZZ source
   *  of the diode-value channel). Absent ⇒ no baked readings. The OBD source
   *  is gated independently by an OBD match existing. See
   *  `store/diode-readings.ts` for the source-merging resolver. */
  diodeReference?: DiodeReferenceChannel;
}

export interface BomAlternateCluster {
  /** Indices into parts[] of all members at detection time. Stale after any
   *  step that filters the parts array (e.g. `buildRenderedBoard` hiding all
   *  but the selected primary); use `memberRefdes` for stable UI lookups. */
  memberIndices: number[];
  /** Member refdes parallel to `memberIndices`. Stable across filtering steps;
   *  use this to identify cluster members in the UI. */
  memberRefdes: string[];
  /** Index into parts[] of the auto-picked default primary (one of memberIndices).
   *  Same staleness caveat as `memberIndices`. */
  defaultPrimaryIndex: number;
  /** Refdes of the auto-picked default primary (one of `memberRefdes`). */
  defaultPrimaryRefdes: string;
  /** Why the primary was picked — surfaced in the UI. */
  reason: 'shape-named-device' | 'lowest-refdes' | 'largest-footprint';
}

/** Human-readable label for a BOM cluster's auto-pick reason. Single source
 *  of truth shared by every surface that renders a cluster (Info tab,
 *  Component Info panel, Revisions tab) so the wording can't drift. */
export function bomReasonLabel(reason: BomAlternateCluster['reason']): string {
  switch (reason) {
    case 'shape-named-device':
      return 'named device';
    case 'lowest-refdes':
      return 'lowest refdes';
    case 'largest-footprint':
      return 'largest footprint';
  }
}

export interface GhostComponent {
  /** Index into parts[] of the suspected stale component. */
  partIndex: number;
  /** Index into parts[] of the larger overlapping component that subsumes it. */
  dominatorIndex: number;
  /** Refdes of the suspected stale component (cached for UI display). */
  partName: string;
  /** Refdes of the dominator (cached for UI display). */
  dominatorName: string;
  /** Centre-to-centre distance in mils between the two parts. */
  distance: number;
}

export interface BoardRevision {
  /** 1-based index. */
  index: number;
  /** Human-readable label, e.g. "rev 1", "rev 3 (current)", "Board A". */
  label: string;
  /** Component count for this revision. */
  componentCount: number;
  /** Parts in this revision (with pins resolved against the shared shape table). */
  parts: Part[];
  /** Bounding box for this revision's parts + outline. */
  bounds: BBox;
  /** Outline for this revision (re-synthesised from this revision's pins). */
  outline: Point[];
  /** Net connectivity for this revision (refdes-keyed). */
  nets: Map<string, Net>;
  /** Suspected stale components for this revision (see BoardData.ghosts). */
  ghosts: GhostComponent[];
  /** Per-revision BOM-alternate clusters (see BoardData.bomClusters). */
  bomClusters?: BomAlternateCluster[];
  /** Per-revision traces (when traces differ between revisions). */
  traces?: Trace[];
  /** Per-revision vias. */
  vias?: Via[];
  /** Per-revision layer names. */
  layerNames?: string[];
}

/** Display ID for a pin: prefer name, then number, then 1-based index fallback. */
export function pinDisplayId(pin: Pin, index: number): string {
  return pin.name || pin.number || String(index + 1);
}

export function computeBBox(points: Point[]): BBox {
  if (points.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Compute part origin (center of pin bounds) and bounding box from pin positions.
 * If no pins, returns origin {0,0} with a small default bounding box.
 */
export function computePartGeometry(pins: Pin[]): { origin: Point; bounds: BBox } {
  if (pins.length > 0) {
    const bounds = computeBBox(pins.map(p => p.position));
    const origin: Point = {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2,
    };
    return { origin, bounds };
  }
  return {
    origin: { x: 0, y: 0 },
    bounds: { minX: -50, minY: -50, maxX: 50, maxY: 50 },
  };
}

/**
 * Compute a tight 4-corner polygon hugging the pins of a part. Returns the
 * AABB corners for axis-aligned chips (most parts) and a rotated rectangle
 * along the pins' principal axis for diagonally-placed parts (45°-rotated
 * BGAs, slanted connectors). Used by overlap-aware ghost detection so two
 * diagonal chips whose AABBs intersect but whose actual bodies don't are
 * not flagged as a stale-refdes pair.
 *
 * Self-contained PCA: no settings, no padding. Mirrors the chip-layout
 * guard + principal-axis logic in `store/render-settings.ts:computeDiagonalOBB`
 * but stripped to the geometry-only core for use during parse.
 */
export function computePartHullPolygon(part: Part): [number, number][] {
  const pins = part.pins;
  const aabbCorners = (): [number, number][] => [
    [part.bounds.minX, part.bounds.minY],
    [part.bounds.maxX, part.bounds.minY],
    [part.bounds.maxX, part.bounds.maxY],
    [part.bounds.minX, part.bounds.maxY],
  ];
  if (pins.length < 3) return aabbCorners();

  // Axis-aligned chip-layout guard — see render-settings for rationale.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const pin of pins) {
    if (pin.position.x < minX) minX = pin.position.x;
    if (pin.position.x > maxX) maxX = pin.position.x;
    if (pin.position.y < minY) minY = pin.position.y;
    if (pin.position.y > maxY) maxY = pin.position.y;
  }
  {
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
    if (hasH && hasV && onAny >= pins.length * 0.4) return aabbCorners();
  }

  // PCA on pin cloud
  let cx = 0, cy = 0;
  for (const pin of pins) { cx += pin.position.x; cy += pin.position.y; }
  cx /= pins.length; cy /= pins.length;
  let cxx = 0, cxy = 0, cyy = 0;
  for (const pin of pins) {
    const dx = pin.position.x - cx;
    const dy = pin.position.y - cy;
    cxx += dx * dx; cxy += dx * dy; cyy += dy * dy;
  }
  const trace = cxx + cyy;
  const det = cxx * cyy - cxy * cxy;
  const disc = Math.sqrt(Math.max(0, trace * trace / 4 - det));
  const lambda1 = trace / 2 + disc;
  const varAvg = (cxx + cyy) / 2;
  const isNearSquare = Math.abs(cxx - cyy) < varAvg * 0.01;
  const isDecorrelated = Math.abs(cxy) < varAvg * 0.01;
  let ux: number, uy: number;
  if (isNearSquare && isDecorrelated) {
    ux = Math.SQRT1_2; uy = Math.SQRT1_2;
  } else if (Math.abs(cxy) > 1e-6) {
    ux = lambda1 - cyy; uy = cxy;
  } else {
    return aabbCorners();
  }
  const len = Math.hypot(ux, uy);
  if (len < 1e-6) return aabbCorners();
  ux /= len; uy /= len;
  if (Math.abs(ux * uy) < 0.15) return aabbCorners();
  const vx = -uy, vy = ux;

  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
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
  const obbW = maxU - minU, obbH = maxV - minV;
  const aabbArea = (maxX - minX) * (maxY - minY);
  if (aabbArea < 1 || (obbW * obbH) / aabbArea > 0.7) return aabbCorners();

  return [
    [cx + minU * ux + minV * vx, cy + minU * uy + minV * vy],
    [cx + maxU * ux + minV * vx, cy + maxU * uy + minV * vy],
    [cx + maxU * ux + maxV * vx, cy + maxU * uy + maxV * vy],
    [cx + minU * ux + maxV * vx, cy + minU * uy + maxV * vy],
  ];
}

/**
 * Convex polygon overlap via Separating Axis Theorem. Returns true when the
 * two polygons intersect (touching counts). Both inputs must be convex and
 * supplied with consistent winding order.
 */
export function polygonsOverlap(a: [number, number][], b: [number, number][]): boolean {
  const polys = [a, b];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      const nx = y2 - y1, ny = -(x2 - x1);
      let aMin = Infinity, aMax = -Infinity, bMin = Infinity, bMax = -Infinity;
      for (const [px, py] of a) {
        const d = px * nx + py * ny;
        if (d < aMin) aMin = d;
        if (d > aMax) aMax = d;
      }
      for (const [px, py] of b) {
        const d = px * nx + py * ny;
        if (d < bMin) bMin = d;
        if (d > bMax) bMax = d;
      }
      if (aMax < bMin || bMax < aMin) return false;
    }
  }
  return true;
}

/**
 * Ground-rail nets only — GND and its aliases. Used by chain-adjacent net
 * highlighting to decide which nets to skip entirely (no propagation, no
 * highlight).
 */
export function isGroundRail(net: string): boolean {
  if (!net) return false;
  const upper = net.toUpperCase();
  return (
    upper === 'GND' ||
    upper === 'AGND' ||
    upper === 'DGND' ||
    upper === 'PGND' ||
    upper === 'EARTH' ||
    upper === 'CHASSIS' ||
    upper.startsWith('GND_')
  );
}

/**
 * Common power/ground rail-name patterns. Components that overlap with only
 * power-rail nets in common are usually heatsinks, EMI shields, or thermal
 * pads — physically valid stacks, not ghosts.
 */
export function isPowerRail(net: string): boolean {
  if (!net) return true;
  const upper = net.toUpperCase();
  return (
    upper === 'GND' ||
    upper === 'AGND' ||
    upper === 'DGND' ||
    upper === 'PGND' ||
    upper === 'EARTH' ||
    upper === 'CHASSIS' ||
    upper === 'VCC' ||
    upper === 'VDD' ||
    upper === 'VSS' ||
    upper === 'VEE' ||
    upper.startsWith('GND_') ||
    upper.startsWith('VCC_') ||
    upper.startsWith('VDD_') ||
    upper.startsWith('VSS_') ||
    /^[+-]\d/.test(upper)            // +12V, -5V, +3V3, +1V8, etc.
  );
}

/**
 * BFS over the connectivity graph induced by 2-pin components, starting from
 * `anchorNet`. Returns the set of adjacent net names reachable within
 * `depth` hops. The anchor itself is never included.
 *
 * Pruning rules per hop into a candidate net `N`:
 *   - If `isGroundRail(N)`: skip entirely (not added, not recursed).
 *   - If `isPowerRail(N)` (and not ground): add to result, but do not
 *     recurse from `N` (terminator).
 *   - Otherwise: add to result and recurse from `N` (subject to depth).
 *
 * If the anchor itself is a power rail (incl. ground), returns an empty
 * set — clicking GND or VCC must not produce a whole-board explosion.
 */
export function computeAdjacentNets(
  board: BoardData,
  anchorNet: string,
  depth: number,
  /** Optional predicate marking parts that bridge nets in the hierarchy even
   *  when they have more than 2 pins (e.g. 4-pin current-sense resistors,
   *  3-pin transistors). 2-pin parts always bridge regardless. When omitted
   *  only the universal 2-pin rule applies. */
  shouldBridge?: (part: Part, partIndex: number) => boolean,
): Set<string> {
  const result = new Set<string>();
  if (depth <= 0) return result;
  if (!anchorNet) return result;
  if (isPowerRail(anchorNet)) return result;
  if (!board.nets.has(anchorNet)) return result;

  // BFS frontier: nets to expand at the current depth level.
  let frontier: string[] = [anchorNet];
  const visited = new Set<string>([anchorNet]);

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const netName of frontier) {
      const net = board.nets.get(netName);
      if (!net) continue;
      // Walk every bridging part on this net; cross over to its other net(s).
      // A part bridges if it has exactly 2 pins (universal) or its type opted
      // in via shouldBridge. 2-pin parts cross to the single other pin's net;
      // multi-pin bridges cross to every other distinct net they touch.
      const seenParts = new Set<number>();
      for (const ref of net.pinIndices) {
        if (seenParts.has(ref.partIndex)) continue;
        seenParts.add(ref.partIndex);
        const part = board.parts[ref.partIndex];
        if (!part) continue;
        const bridges = part.pins.length === 2 || (shouldBridge?.(part, ref.partIndex) ?? false);
        if (!bridges) continue;
        for (const pin of part.pins) {
          const otherNet = pin.net;
          if (!otherNet || otherNet === netName || visited.has(otherNet)) continue;
          if (isGroundRail(otherNet)) continue;          // skip entirely
          visited.add(otherNet);
          result.add(otherNet);
          if (!isPowerRail(otherNet)) next.push(otherNet); // recurse only signals
        }
      }
    }
    frontier = next;
  }

  return result;
}

/**
 * Detect "ghost" components — overlapping pairs on the same side where one
 * part's net set is a subset of the other's AND the shared connectivity goes
 * beyond power/ground rails (so heatsinks and EMI shields don't trip the
 * detector). Strong indicator that a refdes was left in the source design
 * after being replaced by a different one in a later revision (e.g. J8 left
 * in place after J4008 was added). Pure detection; the caller decides
 * whether to display, hide, or remove.
 */
export function detectGhostComponents(parts: Part[]): GhostComponent[] {
  const ghosts: GhostComponent[] = [];

  // Per-part net set (drop empty nets — they don't constrain anything).
  const netSets: Set<string>[] = parts.map(p => {
    const s = new Set<string>();
    for (const pin of p.pins) if (pin.net) s.add(pin.net);
    return s;
  });
  // Per-part: does the part have any non-power signal? Heatsinks and EMI
  // shields connect only to GND/power, so they can't be ghost candidates.
  const hasSignal: boolean[] = netSets.map(s => {
    for (const n of s) if (!isPowerRail(n)) return true;
    return false;
  });

  // Bucket parts by side so we don't compare top-vs-bottom (no physical conflict).
  // "both" parts (through-hole connectors etc.) are checked against parts on
  // either side because they physically occupy both layers.
  const topIdx: number[] = [];
  const botIdx: number[] = [];
  parts.forEach((p, i) => {
    if (p.side === 'bottom') botIdx.push(i);
    else if (p.side === 'top') topIdx.push(i);
    else { topIdx.push(i); botIdx.push(i); }
  });

  function bboxOverlap(a: BBox, b: BBox): boolean {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  }
  // Pre-compute per-part hull polygons (OBB for diagonal parts, AABB
  // otherwise). The AABB pre-check stays as a cheap reject; the SAT step
  // then catches the diagonal-AABB-overlap-but-actually-separate case.
  const partPolys: [number, number][][] = parts.map(p => computePartHullPolygon(p));
  function isSubset(small: Set<string>, large: Set<string>): boolean {
    if (small.size === 0 || small.size > large.size) return false;
    for (const n of small) if (!large.has(n)) return false;
    return true;
  }

  // Track flagged ghost-pair signatures so a "both"-side part doesn't get
  // listed twice (once via topIdx and once via botIdx).
  const flagged = new Set<string>();
  for (const side of [topIdx, botIdx]) {
    for (let i = 0; i < side.length; i++) {
      const ai = side[i];
      const a = parts[ai];
      const aBB = a.bounds;
      const aNets = netSets[ai];
      for (let j = i + 1; j < side.length; j++) {
        const bi = side[j];
        const b = parts[bi];
        if (!bboxOverlap(aBB, b.bounds)) continue;
        if (!polygonsOverlap(partPolys[ai], partPolys[bi])) continue;
        const bNets = netSets[bi];

        // Determine dominator: the part with strictly more pins. If both have
        // identical pin counts but one's nets strictly subsume the other's,
        // still flag — they cannot physically coexist on the same side.
        let dominator: number, ghost: number;
        if (a.pins.length > b.pins.length) { dominator = ai; ghost = bi; }
        else if (b.pins.length > a.pins.length) { dominator = bi; ghost = ai; }
        else continue; // equal pin counts: ambiguous — skip

        const small = parts[ghost].pins.length === a.pins.length ? aNets : bNets;
        const large = parts[dominator].pins.length === b.pins.length ? bNets : aNets;
        if (!isSubset(small, large)) continue;

        // The smaller part must have at least one non-power signal —
        // otherwise it's likely a heatsink / EMI shield / thermal pad
        // overlapping a real chip on shared GND.
        if (!hasSignal[ghost]) continue;

        const sig = ghost < dominator ? `${ghost}-${dominator}` : `${dominator}-${ghost}`;
        if (flagged.has(sig)) continue;
        flagged.add(sig);
        const dx = a.origin.x - b.origin.x;
        const dy = a.origin.y - b.origin.y;
        ghosts.push({
          partIndex:      ghost,
          dominatorIndex: dominator,
          partName:       parts[ghost].name,
          dominatorName:  parts[dominator].name,
          distance:       Math.sqrt(dx * dx + dy * dy),
        });
      }
    }
  }
  return ghosts;
}

/**
 * Detect mutually-exclusive BOM-alternate clusters: groups of overlapping
 * same-role components that all serve the same circuit position and are
 * therefore alternative fitments (only one member is actually populated per
 * BOM variant). Common pattern in CAD/CAMCAD exports of boards with
 * multi-source vendor support or value-fit alternates ("0.22µH OR 0.33µH",
 * "1× tantalum OR 4× 0805 in parallel").
 *
 * Distinct from `detectGhostComponents`, which handles unequal-pin-count
 * leftover-refdes pairs. This pass targets equal-pin-count alternates that
 * the ghost detector skips as "ambiguous".
 *
 * Pair criteria (must all hold):
 *   1. Same side (top vs bottom).
 *   2. Equal pin count (unequal-count overlaps are handled by ghost detection).
 *   3. Same refdes prefix family (R↔R, C↔C, L↔L; differing prefixes are
 *      different roles, never alternates).
 *   4. AABB AND polygon-hull overlap — so the "1 large + N small" pattern is
 *      caught via overlap of the large with each small (the small parts need
 *      not pairwise overlap each other).
 *   5. Net subset/equality (when both have nets) — alternates serve the same
 *      circuit role so connectivity must agree. Skipped if either side has
 *      no nets at all.
 *   6. DEVICE value or footprint differs between members — proves a real
 *      alternate (different package/value/vendor). Pure-duplicate refdes
 *      with identical DEVICE+SHAPE is not a BOM alternate; it's parser
 *      duplication and should be filtered earlier.
 *
 * Pairs are merged transitively (union-find). Default primary per cluster
 * is picked using a tiered heuristic (~88% empirical accuracy across CAD
 * samples — see project_bom_clusters memory):
 *   T1. Member with a shape-suffixed device value (e.g.
 *       `0.22uh_IND_NONRKO_TH_100X072_B`) — these survive from the original
 *       CAD-tool-generated names; bare values like `0.22uh` typically mark
 *       later-added alternates.
 *   T2. Member with the lowest numeric refdes — the schematic "COMMON"
 *       mark in observed boards lands on the lowest refdes in 88% of clusters.
 *   T3. Member with the largest footprint area — handles "1 tantalum + N
 *       small 0805s" where the design-intent primary is the larger part.
 *
 * Pure detection; the caller decides whether to hide secondaries by default.
 */
/**
 * Flag "mechanical-like" parts in place — EMI shielding frames, heatsink
 * clips, opposite-side connector shadows. These visually cover real
 * components when their fill is drawn, so the scene builder uses
 * `part.mechanical` to skip the fill draw (border + pins still render).
 *
 * Three orthogonal signals; each flips the flag on independently:
 *   S1. PART description carries a mechanical keyword
 *       (SHIELD / SHIELDING / HEATSINK / FRAME / NUT). High precision —
 *       these are explicitly labelled in the source (CAD/BDV/Allegro).
 *   S2. Trailing-dot refdes whose stripped base exists as another part
 *       at the same origin. GenCAD convention for "opposite-side body
 *       shadow of a through-hole connector" (J1601./U5201./J6801. in the
 *       ASUS ASUS_B7402FEA fixture). Exact-origin match only — no
 *       similarity threshold, so false-positive risk is zero.
 *   S3. Containment count — the part's bounding box contains the
 *       origins of at least `minContains` other parts on the same side.
 *       Catches frames generically when neither S1 nor S2 fires.
 *
 * Mutates `parts[i].mechanical`; never sets it to false (leaves prior
 * value alone so user overrides survive).
 */
const MECHANICAL_KEYWORDS = [
  'SHIELD', 'SHIELDING', 'HEATSINK', 'HEAT SINK', 'HEAT-SINK',
  'FRAME', 'CAN CLIP', 'EMI', 'BRACKET',
];

export function flagMechanicalParts(parts: Part[], minContains = 5): void {
  let s1 = 0, s2 = 0, s3 = 0;

  // S1 — keyword match on PART description (meta.value).
  for (const p of parts) {
    const desc = (p.meta?.value ?? '').toUpperCase();
    if (!desc) continue;
    for (const kw of MECHANICAL_KEYWORDS) {
      if (desc.includes(kw)) {
        if (!p.mechanical) s1++;
        p.mechanical = true;
        break;
      }
    }
  }

  // S2 — trailing-dot duplicate of another part. GenCAD/CAMCAD writes the
  // opposite-side / mechanical body of a connector as a sibling component
  // with a `.`-suffixed refdes (J1601/J1601., U5201/U5201., J6801/J6801.).
  // The shadow often has very different pin geometry from its sibling — the
  // J1601. body in ASUS_B7402FEA has only 2 mounting-tab pins on TOP while
  // J1601 carries the full 262-pin DIMM footprint on BOTTOM, so origins
  // diverge by ~150 mils. The trailing-dot+base-exists pattern itself is the
  // signal; positional matching is too strict.
  const namesPresent = new Set<string>();
  for (const p of parts) namesPresent.add(p.name);
  for (const p of parts) {
    if (!p.name.endsWith('.')) continue;
    const base = p.name.slice(0, -1);
    if (!base) continue;
    if (namesPresent.has(base)) {
      if (!p.mechanical) s2++;
      p.mechanical = true;
    }
  }

  // S3 — containment count. For each part, count how many OTHER parts on
  // the same side have their origin strictly inside this part's bbox.
  // Build a per-side origin grid first so this is O(n * k) instead of O(n²).
  const cellSize = 500; // mils — coarser than typical pad spacing, fine
  type GridEntry = { idx: number; x: number; y: number };
  const grids: Record<string, Map<string, GridEntry[]>> = {
    top: new Map(), bottom: new Map(), both: new Map(),
  };
  parts.forEach((p, i) => {
    const cx = Math.floor(p.origin.x / cellSize);
    const cy = Math.floor(p.origin.y / cellSize);
    const k = `${cx},${cy}`;
    const g = grids[p.side];
    let arr = g.get(k);
    if (!arr) { arr = []; g.set(k, arr); }
    arr.push({ idx: i, x: p.origin.x, y: p.origin.y });
  });
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.mechanical) continue; // already flagged by S1/S2 — skip the work
    const { minX, minY, maxX, maxY } = p.bounds;
    const w = maxX - minX, h = maxY - minY;
    if (w <= 0 || h <= 0) continue;
    // Walk cells overlapping the bbox on this side AND on 'both' (a "both"
    // part physically sits on both layers, so it counts for either side).
    const c0x = Math.floor(minX / cellSize);
    const c1x = Math.floor(maxX / cellSize);
    const c0y = Math.floor(minY / cellSize);
    const c1y = Math.floor(maxY / cellSize);
    let count = 0;
    const sides = p.side === 'both' ? ['top', 'bottom', 'both'] : [p.side, 'both'];
    outer: for (const s of sides) {
      const g = grids[s];
      for (let cx = c0x; cx <= c1x; cx++) {
        for (let cy = c0y; cy <= c1y; cy++) {
          const arr = g.get(`${cx},${cy}`);
          if (!arr) continue;
          for (const e of arr) {
            if (e.idx === i) continue;
            if (e.x < minX || e.x > maxX || e.y < minY || e.y > maxY) continue;
            count++;
            if (count >= minContains) {
              if (!p.mechanical) s3++;
              p.mechanical = true;
              break outer;
            }
          }
        }
      }
    }
  }

  const total = s1 + s2 + s3;
  if (total > 0) {
    // Per-side counts help diagnose side-flip / mirror confusion.
    let topF = 0, botF = 0, bothF = 0;
    for (const p of parts) {
      if (!p.mechanical) continue;
      if (p.side === 'top') topF++;
      else if (p.side === 'bottom') botF++;
      else bothF++;
    }
    log.parser.log(
      `flagMechanicalParts: ${total} flagged (S1 keyword=${s1}, S2 dotted-shadow=${s2}, ` +
      `S3 contains-≥${minContains}=${s3}); by side top=${topF} bottom=${botF} both=${bothF}`,
    );
  }
}

export function detectBomAlternateClusters(parts: Part[]): BomAlternateCluster[] {
  if (parts.length < 2) return [];

  const netSets: Set<string>[] = parts.map(p => {
    const s = new Set<string>();
    for (const pin of p.pins) if (pin.net) s.add(pin.net);
    return s;
  });
  const polys: [number, number][][] = parts.map(p => computePartHullPolygon(p));

  const refdesPrefix = (name: string): string => {
    const m = name.match(/^([A-Za-z]+)/);
    return m ? m[1].toUpperCase() : '';
  };
  const refdesNum = (name: string): number => {
    const m = name.match(/^[A-Za-z]+(\d+)/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  // "Shape-suffixed" = device value carries the original CAD-tool footprint
  // name appended after the bare value (e.g. `0.22uh_IND_NONRKO_TH_100X072_B`).
  // Bare values like `0.22uh` are the alternate-added-later signal.
  const isShapeNamed = (val: string): boolean => {
    if (!val) return false;
    if (val.length < 8) return false;
    if (!val.includes('_')) return false;
    return /[A-Z]/.test(val);
  };
  const footprintArea = (p: Part): number => {
    const w = p.bounds.maxX - p.bounds.minX;
    const h = p.bounds.maxY - p.bounds.minY;
    return Math.max(0, w) * Math.max(0, h);
  };
  // True iff the small set is a subset of the large set, allowing equality.
  const isSubsetOrEqual = (small: Set<string>, large: Set<string>): boolean => {
    if (small.size > large.size) return false;
    for (const n of small) if (!large.has(n)) return false;
    return true;
  };

  function bboxOverlap(a: BBox, b: BBox): boolean {
    return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
  }

  // Bucket parts by side so we don't compare top-vs-bottom (no physical conflict).
  // "both"-side parts (through-hole connectors etc.) are checked against parts
  // on either side because they physically occupy both layers.
  const topIdx: number[] = [];
  const botIdx: number[] = [];
  parts.forEach((p, i) => {
    if (p.side === 'bottom') botIdx.push(i);
    else if (p.side === 'top') topIdx.push(i);
    else { topIdx.push(i); botIdx.push(i); }
  });

  // Union-find for transitive merging — handles "1 large + N small" where the
  // small parts pairwise overlap the large but not each other.
  const parent: number[] = parts.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Track which (i,j) pairs were unioned across both side passes so a
  // "both"-side part doesn't trigger duplicate work.
  const seenPair = new Set<string>();

  for (const side of [topIdx, botIdx]) {
    for (let i = 0; i < side.length; i++) {
      const ai = side[i];
      const a = parts[ai];
      const aPrefix = refdesPrefix(a.name);
      if (!aPrefix) continue;
      const aPinCount = a.pins.length;
      const aValue = a.meta?.value ?? '';
      const aPackage = a.meta?.package ?? '';
      for (let j = i + 1; j < side.length; j++) {
        const bi = side[j];
        const pairKey = ai < bi ? `${ai}-${bi}` : `${bi}-${ai}`;
        if (seenPair.has(pairKey)) continue;

        const b = parts[bi];
        if (b.pins.length !== aPinCount) continue;
        if (refdesPrefix(b.name) !== aPrefix) continue;
        if (!bboxOverlap(a.bounds, b.bounds)) continue;
        if (!polygonsOverlap(polys[ai], polys[bi])) continue;

        // Net check: when either side has nets, require subset/equality.
        const aNets = netSets[ai];
        const bNets = netSets[bi];
        if (aNets.size > 0 && bNets.size > 0) {
          const ok = aNets.size <= bNets.size
            ? isSubsetOrEqual(aNets, bNets)
            : isSubsetOrEqual(bNets, aNets);
          if (!ok) continue;
        }

        // Differ in DEVICE value or footprint package — proves alternate, not
        // pure duplicate. If neither metadata is present we can't tell, so
        // skip rather than over-flag.
        const bValue = b.meta?.value ?? '';
        const bPackage = b.meta?.package ?? '';
        const valueDiffers = aValue !== bValue;
        const packageDiffers = aPackage !== bPackage;
        if (!valueDiffers && !packageDiffers) {
          if (!aValue && !bValue && !aPackage && !bPackage) continue; // no metadata to compare
          if (aValue === bValue && aPackage === bPackage) continue;   // genuine duplicate
        }

        seenPair.add(pairKey);
        union(ai, bi);
      }
    }
  }

  // Group merged indices into clusters by union-find root.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < parts.length; i++) {
    const root = find(i);
    let arr = groups.get(root);
    if (!arr) { arr = []; groups.set(root, arr); }
    arr.push(i);
  }

  const clusters: BomAlternateCluster[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a - b);

    // Pick the default primary using the tiered heuristic.
    let primaryIndex = members[0];
    let reason: BomAlternateCluster['reason'] = 'lowest-refdes';

    // T1: shape-suffixed device value — strongest signal.
    const shapeNamed = members.filter(idx => isShapeNamed(parts[idx].meta?.value ?? ''));
    if (shapeNamed.length > 0) {
      // If multiple are shape-named, pick the lowest-refdes one for stability.
      shapeNamed.sort((a, b) => refdesNum(parts[a].name) - refdesNum(parts[b].name));
      primaryIndex = shapeNamed[0];
      reason = 'shape-named-device';
    } else {
      // T2: lowest refdes.
      let minNum = Infinity;
      for (const idx of members) {
        const n = refdesNum(parts[idx].name);
        if (n < minNum) { minNum = n; primaryIndex = idx; }
      }
      // T3: if every member has the same refdes number (rare — all have no
      // numeric suffix), fall through to largest footprint as final tiebreak.
      if (!isFinite(minNum)) {
        let maxArea = -1;
        for (const idx of members) {
          const a = footprintArea(parts[idx]);
          if (a > maxArea) { maxArea = a; primaryIndex = idx; }
        }
        reason = 'largest-footprint';
      }
    }

    clusters.push({
      memberIndices: members,
      memberRefdes: members.map(i => parts[i].name),
      defaultPrimaryIndex: primaryIndex,
      defaultPrimaryRefdes: parts[primaryIndex].name,
      reason,
    });
  }
  return clusters;
}

/**
 * Generate a rectangular outline from a set of points with an optional margin.
 * Returns an empty array if no points are provided.
 */
export function generateSyntheticOutline(points: Point[], margin = 20): Point[] {
  if (points.length === 0) return [];
  const b = computeBBox(points);
  return [
    { x: b.minX - margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.minY - margin },
    { x: b.maxX + margin, y: b.maxY + margin },
    { x: b.minX - margin, y: b.maxY + margin },
  ];
}

/**
 * Greedy nearest-neighbor chain: connect line segments into a single ordered polygon.
 * Each segment is a pair of points [start, end]. The algorithm picks the closest
 * unvisited segment endpoint to the current chain tail and appends the far endpoint.
 */
export function chainSegments(segments: Array<[Point, Point]>): Point[] {
  if (segments.length === 0) return [];

  const used = new Uint8Array(segments.length);
  const chain: Point[] = [];

  // Start with segment 0: push both endpoints
  chain.push(segments[0][0], segments[0][1]);
  used[0] = 1;

  for (let step = 1; step < segments.length; step++) {
    const last = chain[chain.length - 1];
    let bestIdx = -1;
    let bestDist = Infinity;
    let bestFlip = false;

    for (let j = 0; j < segments.length; j++) {
      if (used[j]) continue;
      const d0 = Math.hypot(last.x - segments[j][0].x, last.y - segments[j][0].y);
      const d1 = Math.hypot(last.x - segments[j][1].x, last.y - segments[j][1].y);
      if (d0 < bestDist) { bestDist = d0; bestIdx = j; bestFlip = false; }
      if (d1 < bestDist) { bestDist = d1; bestIdx = j; bestFlip = true; }
    }

    if (bestIdx < 0) break;
    used[bestIdx] = 1;
    // Append the far endpoint (near endpoint ≈ current chain tail)
    chain.push(bestFlip ? segments[bestIdx][0] : segments[bestIdx][1]);
  }

  return chain;
}

export function buildNets(parts: Part[]): Map<string, Net> {
  const nets = new Map<string, Net>();
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    for (let pni = 0; pni < part.pins.length; pni++) {
      const pin = part.pins[pni];
      if (!pin.net || pin.net === '(null)' || pin.net === '') continue;
      let net = nets.get(pin.net);
      if (!net) {
        net = { name: pin.net, pinIndices: [] };
        nets.set(pin.net, net);
      }
      net.pinIndices.push({ partIndex: pi, pinIndex: pni });
    }
  }
  return nets;
}
