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
  /** True when the BitmapText path would draw a translucent background plate
   *  behind this label (the net-label wrapper Graphics — 2-pin `twoPinNetLabelBg`
   *  or circle-net `pinNetLabelBg`). The overlay paints the equivalent backing
   *  rect so fast-mode net labels keep their plate. All non-net labels: false. */
  bg: boolean;
}

export interface LabelModel { top: LabelRecord[]; bottom: LabelRecord[]; }

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
