/**
 * LabelModel — Canvas2D-overlay label records emitted by `buildBoardScene`
 * when `RenderSettings.textFastMode` is enabled ("Text fast mode").
 *
 * Instead of constructing a PixiJS `BitmapText` per part/pin/circle/two-pin/
 * diode label (thousands of scene objects on dense boards), each such site
 * pushes a plain data record here. A Canvas2D overlay (added in a later task)
 * paints the records above the WebGL canvas. Via labels stay `BitmapText`
 * (small count, multi-layer boards only) and are excluded from v1.
 *
 */

export type LabelKind = 'part' | 'pinNum' | 'pinNet' | 'circleNum' | 'circleNet' | 'twoPinNet' | 'diode';

export interface LabelRecord {
  x: number; y: number;          // board/scene coords (same space BitmapText.x/y used)
  text: string;
  fontSize: number;              // same pre-quantization size the BitmapText would get
  color: number;                 // 0xRRGGBB
  kind: LabelKind;
  /** Palette schemes: an outline of this colour drawn under the text, so a
   *  name reads across body, pads and board alike. Absent = no halo (Default). */
  halo?: number;
  /** Palette schemes: the backing box colour and opacity when `bg` is set.
   *  Absent = black at 0.55, as Default has always drawn it. */
  bgColor?: number;
  bgAlpha?: number;
  /** Light schemes: the colour this pin label takes while its pin is filled
   *  with the scheme's ink (`lightSelectionStyle` 'ink' / 'inkHighlighter'),
   *  chosen against the ink, not the pin. Absent = the label does not sit on
   *  the pin (backed net names) or the scheme has no ink style. */
  inkColor?: number;
  partIndex: number;             // -1 for labels with no owning part (via labels excluded from v1)
  /** Index into `part.pins` for pin-attached labels (pin number, net name,
   *  diode reading); absent for part names. Lets the overlay single out the
   *  selected and the hovered pin's labels for the full size bump while the
   *  rest of a selected part's labels stay at `selectedLabelOtherScale`. */
  pinIndex?: number;
  /** Pin numbers only: the centred placement used while the pin's net name is
   *  below its appear-floor. The record's own x/y/anchorY is the SHIFTED
   *  position (above/below centre, BGA-alternating) that makes room for the
   *  net name; until that name is visible there is nothing to make room for,
   *  so the number sits in the middle of its pin, where it cannot overlap. */
  alt?: { x: number; y: number; anchorY: number };
  /** Pin numbers only: the sibling net label's fontSize, so the overlay can
   *  apply the net label's own appear-rule and pick `alt` vs shifted. */
  pairFontSize?: number;
  /** Pin-attached labels on multi-pin parts: the part's minimum pin-centre
   *  spacing (world units). The overlay caps the drawn size so the label fits
   *  between pin centres — the largest font at which nothing on the part can
   *  overlap — instead of testing labels against each other. */
  pitch?: number;
  /** True when this pin shows a number above AND a name below, so the height
   *  budget per label is half a pitch rather than a whole one. */
  stacked?: boolean;
  /** Anchor fractions matching PixiJS `BitmapText.anchor` exactly: the point of
   *  the text's bounding box that sits AT (x, y). 0/0 = top-left, 0.5/0.5 =
   *  centered, 1/1 = bottom-right. The Task 6 overlay compensates at draw time
   *  (measureText → shift by anchor·[width, height]) so records reproduce the
   *  BitmapText path's placement pixel-for-pixel, including per-pin variants
   *  (BGA alternating, diode 0.5/1.1, 2-pin net anchorY parity). */
  anchorX: number; anchorY: number;
  /** Staggered (BGA-alternating) pin numbers and net names: where the label
   *  goes under each view rotation. Which board axis reads as a screen row
   *  flips at 90°/270°, so the column parity, the offset axis and its sign all
   *  change with the turn; `applyRotationLayout` rewrites x/y/anchorY from
   *  this instead of rebuilding the whole scene. */
  rot?: RotLayout;
  /** True when the BitmapText path would draw a translucent background plate
   *  behind this label (the net-label wrapper Graphics — 2-pin `twoPinNetLabelBg`
   *  or circle-net `pinNetLabelBg`). The overlay paints the equivalent backing
   *  rect so fast-mode net labels keep their plate. All non-net labels: false. */
  bg: boolean;
}

export interface LabelModel { top: LabelRecord[]; bottom: LabelRecord[]; }

/** Both placements of a staggered label, around the pin centre (cx, cy).
 *  Unturned (0°/180°): y = cy + nUp, anchorY = nA.
 *  Turned (90°/270°): x = cx + sUp · sign, anchorY = sA, with sign −1 at 90°
 *  and +1 at 270° (board +X points down the screen at 90°, up at 270°). */
export interface RotLayout { cx: number; cy: number; nUp: number; nA: number; sUp: number; sA: number }

/** Relative luminance of a 0xRRGGBB colour (WCAG). */
export function lumOf(c: number): number {
  const ch = (v: number) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch((c >> 16) & 255) + 0.7152 * ch((c >> 8) & 255) + 0.0722 * ch(c & 255);
}
/** WCAG contrast ratio of two 0xRRGGBB colours. */
export function contrastOf(a: number, b: number): number {
  const x = lumOf(a), y = lumOf(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** The halo under a label of colour `ink`: the opposite pole. */
export function haloFor(ink: number): number {
  return lumOf(ink) < 0.18 ? 0xffffff : 0x000000;
}
/** Text colour for a label drawn on `bg`: the scheme's own when it reads
 *  (≥ 4.5:1), otherwise black or white, whichever reads better. A light
 *  scheme's dark ink on a dark pin, or a dark scheme's light ink on a pale
 *  pin, would otherwise vanish. Palette schemes only — Default is unchanged. */
export function inkOn(bg: number, preferred: number): number {
  if (contrastOf(preferred, bg) >= 4.5) return preferred;
  return contrastOf(0x000000, bg) >= contrastOf(0xffffff, bg) ? 0x000000 : 0xffffff;
}

/** 0 = unturned, 1 = 90°, 3 = 270° (180° lays out like 0°). */
export function rotLayoutKey(rotationDeg: number): 0 | 1 | 3 {
  const q = ((Math.round(rotationDeg / 90) % 4) + 4) % 4;
  return q === 1 ? 1 : q === 3 ? 3 : 0;
}

/** Moves every staggered label to its placement for `key`. Returns how many
 *  records changed. */
export function applyRotationLayout(m: LabelModel, key: 0 | 1 | 3): number {
  let n = 0;
  for (const list of [m.top, m.bottom]) {
    for (const r of list) {
      const l = r.rot;
      if (!l) continue;
      if (key === 0) { r.x = l.cx; r.y = l.cy + l.nUp; r.anchorY = l.nA; }
      else { r.x = l.cx + l.sUp * (key === 1 ? -1 : 1); r.y = l.cy; r.anchorY = l.sA; }
      n++;
    }
  }
  return n;
}

/**
 * Route a label record into the model, or signal the caller to take the
 * BitmapText path. Returns `false` (with no side effect) when `model` is null
 * — i.e. Text fast mode is off — so call sites read as:
 *
 *   if (!pushLabel(labelModel, side, rec)) { ...construct BitmapText... }
 */
export function pushLabel(model: LabelModel | null, side: 'top' | 'bottom', rec: LabelRecord): boolean {
  if (!model) return false;         // caller creates BitmapText as before
  (side === 'top' ? model.top : model.bottom).push(rec);
  return true;
}

/** Painter's order by kind. Diode readings last: they are the one label a
 *  technician is reading off the pin, and nothing — designator, number, net
 *  name — may paint over them. The rest keeps the old alphabetical order
 *  (pin numbers under net names under part names) so nothing else moves. */
const KIND_ORDER: Record<LabelKind, number> = {
  circleNet: 0, circleNum: 1, part: 2, pinNet: 3, pinNum: 4, twoPinNet: 5, diode: 9,
};

/** Sort in place so the overlay can batch ctx.font changes: kind, then
 *  fontSize descending (big labels first also gives painter's-order priority
 *  when a draw budget truncates). */
export function sortLabelModel(m: LabelModel): void {
  const cmp = (a: LabelRecord, b: LabelRecord) =>
    a.kind === b.kind ? b.fontSize - a.fontSize : KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  m.top.sort(cmp);
  m.bottom.sort(cmp);
}
