import { describe, it, expect } from 'vitest';
import { selectedFloorPx, pinNumberPlacement, pitchCapPx, labelFadeAlpha, selectVisibleLabels, type OverlayViewState, type OverlayThresholds } from './label-overlay';
import type { LabelRecord } from './label-model';

const ident = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const view = (scale: number): OverlayViewState => ({
  topMatrix: ident, bottomMatrix: ident, scale, width: 800, height: 600,
  showTop: true, showBottom: true, selectedPartIndex: null, dimActive: false, litParts: null,
});
const th: OverlayThresholds = { labelMinScreenPx: 3, circleLabelMinScreenPx: 3, twoPinLabelMinScreenPx: 6, labelZoomHide: 0, selectedLabelMinPx: 11, selectedLabelLodRelax: 0.75 };
const rec = (x: number, y: number, fontSize: number, kind: LabelRecord['kind'] = 'part'): LabelRecord =>
  ({ x, y, text: 'X', fontSize, color: 0xffffff, kind, partIndex: 0, anchorX: 0.5, anchorY: 0.5, bg: false });

describe('selectVisibleLabels', () => {
  it('culls off-screen records', () => {
    const out = selectVisibleLabels([rec(400, 300, 10), rec(5000, 300, 10)], ident, view(1), th);
    expect(out).toHaveLength(1);
  });
  it('culls below the per-kind min screen px', () => {
    // part: 10px*0.2=2 < 3 hidden; 10px*0.5=5 >= 3 visible
    expect(selectVisibleLabels([rec(400, 300, 10)], ident, view(0.2), th)).toHaveLength(0);
    expect(selectVisibleLabels([rec(400, 300, 10)], ident, view(0.5), th)).toHaveLength(1);
  });
  it('twoPinNet uses its own threshold', () => {
    // 10px*0.5=5 < 6 → hidden for twoPinNet, visible for part
    expect(selectVisibleLabels([rec(400, 300, 10, 'twoPinNet')], ident, view(0.5), th)).toHaveLength(0);
  });
  it('selected part NAME bypasses LoD entirely (identity marker)', () => {
    const v = { ...view(0.1), selectedPartIndex: 0 };
    expect(selectVisibleLabels([rec(400, 300, 10, 'part')], ident, v, th)).toHaveLength(1);
  });
  it('selected pin/net labels get relaxed LoD, not a bypass', () => {
    const v05 = { ...view(0.5), selectedPartIndex: 0 };
    // circleNet threshold 3: unselected needs 3px; selected needs 3*0.75=2.25px.
    // fontSize 5 @ 0.5 = 2.5px → hidden unselected, visible selected (sticky).
    expect(selectVisibleLabels([rec(400, 300, 5, 'circleNet')], ident, view(0.5), th)).toHaveLength(0);
    expect(selectVisibleLabels([rec(400, 300, 5, 'circleNet')], ident, v05, th)).toHaveLength(1);
    // fontSize 5 @ 0.1 = 0.5px < 2.25 → gone even when selected (deep unzoom).
    const v01 = { ...view(0.1), selectedPartIndex: 0 };
    expect(selectVisibleLabels([rec(400, 300, 5, 'circleNet')], ident, v01, th)).toHaveLength(0);
  });
  it('selected pin/net labels still respect labelZoomHide', () => {
    const v = { ...view(0.5), selectedPartIndex: 0 };
    const out = selectVisibleLabels([rec(400, 300, 100, 'circleNet')], ident, v, { ...th, labelZoomHide: 1 });
    expect(out).toHaveLength(0);
  });
  it('labelZoomHide hides everything below the zoom floor', () => {
    const out = selectVisibleLabels([rec(400, 300, 100)], ident, view(0.5), { ...th, labelZoomHide: 1 });
    expect(out).toHaveLength(0);
  });
});


describe('selectedFloorPx', () => {
  const th = {
    labelMinScreenPx: 6, circleLabelMinScreenPx: 6, twoPinLabelMinScreenPx: 6, labelZoomHide: 0,
    selectedLabelMinPx: 10, selectedLabelLodRelax: 0.75, selectedLabelOtherScale: 0.8,
  };
  it('gives the focused pin and the part name the full floor', () => {
    expect(selectedFloorPx('pinNet', true, th)).toBe(10);
    expect(selectedFloorPx('circleNet', true, th)).toBe(10);
    expect(selectedFloorPx('part', false, th)).toBe(10);
  });
  it('gives the selected part\'s other pin labels the reduced floor', () => {
    expect(selectedFloorPx('pinNet', false, th)).toBeCloseTo(8);
    expect(selectedFloorPx('circleNum', false, th)).toBeCloseTo(8);
    expect(selectedFloorPx('diode', false, th)).toBeCloseTo(8);
  });
  it('defaults the other-pin scale to 0.8 and honours 0 = no floor', () => {
    expect(selectedFloorPx('pinNet', false, { ...th, selectedLabelOtherScale: undefined })).toBeCloseTo(8);
    expect(selectedFloorPx('pinNet', true, { ...th, selectedLabelMinPx: 0 })).toBe(0);
  });
});


describe('pinNumberPlacement', () => {
  const th: OverlayThresholds = {
    labelMinScreenPx: 3, circleLabelMinScreenPx: 8, pinNumberMinScreenPx: 5, twoPinLabelMinScreenPx: 6, labelZoomHide: 0,
    selectedLabelMinPx: 11, selectedLabelLodRelax: 0.75,
  };
  const view = { scale: 1 } as OverlayViewState;
  const rec: LabelRecord = {
    x: 100, y: 90, text: 'A1', fontSize: 6, color: 0, kind: 'circleNum', partIndex: 0, pinIndex: 0,
    anchorX: 0.5, anchorY: 1, bg: false, alt: { x: 100, y: 100, anchorY: 0.5 }, pairFontSize: 6,
  };
  it('sits centred in the pin while the net name is below its floor', () => {
    expect(pinNumberPlacement(rec, { ...view, scale: 1 }, th, false)).toEqual({ x: 100, y: 100, anchorY: 0.5 });
  });
  it('moves to the shifted position once the net name shows', () => {
    expect(pinNumberPlacement(rec, { ...view, scale: 1.5 }, th, false)).toEqual({ x: 100, y: 90, anchorY: 1 });
  });
  it('follows the selected part\'s relaxed net floor', () => {
    // 6 * 1.1 = 6.6 ≥ 8 * 0.75 = 6 → visible when selected, hidden otherwise
    expect(pinNumberPlacement(rec, { ...view, scale: 1.1 }, th, true).y).toBe(90);
    expect(pinNumberPlacement(rec, { ...view, scale: 1.1 }, th, false).y).toBe(100);
  });
  it('is a no-op for numbers with no shifted position or no net name', () => {
    expect(pinNumberPlacement({ ...rec, alt: undefined }, view, th, false).y).toBe(90);
    expect(pinNumberPlacement({ ...rec, pairFontSize: undefined }, view, th, false).y).toBe(90);
  });
});


describe('pitchCapPx', () => {
  const base: LabelRecord = {
    x: 0, y: 0, text: 'PPBUS', fontSize: 6, color: 0, kind: 'circleNet', partIndex: 0, pinIndex: 0,
    anchorX: 0.5, anchorY: 0.5, bg: false, pitch: 16,
  };
  it('is unbounded without a pitch', () => {
    expect(pitchCapPx({ ...base, pitch: undefined }, 1)).toBe(Infinity);
  });
  it('fits the text between pin centres: 5 chars at 16 px pitch → 4.8 px', () => {
    expect(pitchCapPx(base, 1)).toBeCloseTo((16 * 0.9) / (5 * 0.6));
  });
  it('scales with zoom and never exceeds the height budget', () => {
    expect(pitchCapPx({ ...base, text: 'A1' }, 2)).toBeCloseTo((32 * 0.9) / (3 * 0.6)); // short text: width rule, 3-char minimum
    expect(pitchCapPx({ ...base, text: 'A1', stacked: true }, 2)).toBeCloseTo(32 * 0.45); // stacked: height rule binds
  });
});


describe('labelFadeAlpha', () => {
  it('is faint at the floor, solid past floor × (1 + range), monotonic between', () => {
    expect(labelFadeAlpha(8, 8, 0.5)).toBeCloseTo(0.18);
    expect(labelFadeAlpha(12, 8, 0.5)).toBe(1);
    expect(labelFadeAlpha(20, 8, 0.5)).toBe(1);
    const a = labelFadeAlpha(9, 8, 0.5), b = labelFadeAlpha(10, 8, 0.5), c = labelFadeAlpha(11, 8, 0.5);
    expect(a).toBeLessThan(b); expect(b).toBeLessThan(c); expect(c).toBeLessThan(1);
  });
  it('is off with range 0 or no floor', () => {
    expect(labelFadeAlpha(8, 8, 0)).toBe(1);
    expect(labelFadeAlpha(1, 0, 0.5)).toBe(1);
  });
});
