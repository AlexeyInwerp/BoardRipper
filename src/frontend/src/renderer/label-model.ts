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
 * See docs/research/renderer-research-2026-07-19.md.
 */

export type LabelKind = 'part' | 'pinNum' | 'pinNet' | 'circleNum' | 'circleNet' | 'twoPinNet' | 'diode';

export interface LabelRecord {
  x: number; y: number;          // board/scene coords (same space BitmapText.x/y used)
  text: string;
  fontSize: number;              // same pre-quantization size the BitmapText would get
  color: number;                 // 0xRRGGBB
  kind: LabelKind;
  partIndex: number;             // -1 for labels with no owning part (via labels excluded from v1)
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

/** Sort in place so the overlay can batch ctx.font changes: kind, then
 *  fontSize descending (big labels first also gives painter's-order priority
 *  when a draw budget truncates). */
export function sortLabelModel(m: LabelModel): void {
  const cmp = (a: LabelRecord, b: LabelRecord) =>
    a.kind === b.kind ? b.fontSize - a.fontSize : a.kind.localeCompare(b.kind);
  m.top.sort(cmp);
  m.bottom.sort(cmp);
}
