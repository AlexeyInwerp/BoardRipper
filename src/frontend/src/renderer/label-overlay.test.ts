import { describe, it, expect } from 'vitest';
import { selectVisibleLabels, type OverlayViewState, type OverlayThresholds } from './label-overlay';
import type { LabelRecord } from './label-model';

const ident = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const view = (scale: number): OverlayViewState => ({
  topMatrix: ident, bottomMatrix: ident, scale, width: 800, height: 600,
  showTop: true, showBottom: true, selectedPartIndex: null, dimActive: false, litParts: null,
});
const th: OverlayThresholds = { labelMinScreenPx: 3, circleLabelMinScreenPx: 3, twoPinLabelMinScreenPx: 6, labelZoomHide: 0 };
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
  it('selected part bypasses LoD', () => {
    const v = { ...view(0.1), selectedPartIndex: 0 };
    expect(selectVisibleLabels([rec(400, 300, 10)], ident, v, th)).toHaveLength(1);
  });
  it('labelZoomHide hides everything below the zoom floor', () => {
    const out = selectVisibleLabels([rec(400, 300, 100)], ident, view(0.5), { ...th, labelZoomHide: 1 });
    expect(out).toHaveLength(0);
  });
});
