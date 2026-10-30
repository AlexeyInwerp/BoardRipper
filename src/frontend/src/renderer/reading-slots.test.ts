import { describe, it, expect } from 'vitest';
import { clearOfReading, labelSizePx, pitchCapPx, readingSlots, type OverlayViewState, type OverlayThresholds } from './label-overlay';
import type { LabelRecord } from './label-model';

const ident = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
const view = (scale: number): OverlayViewState => ({
  topMatrix: ident, bottomMatrix: ident, scale, width: 800, height: 600,
  showTop: true, showBottom: true, selectedPartIndex: null, dimActive: false, litParts: null,
});
const th: OverlayThresholds = { labelMinScreenPx: 3, circleLabelMinScreenPx: 8, twoPinLabelMinScreenPx: 6, labelZoomHide: 0, selectedLabelMinPx: 11, selectedLabelLodRelax: 0.75 };
const reading = (fontSize: number, pitch = 40): LabelRecord => ({
  x: 100, y: 200, text: '0.335', fontSize, color: 0xffff00, kind: 'diode', partIndex: 3, pinIndex: 7,
  anchorX: 0.5, anchorY: 0.5, bg: true, slot: 'centre', pitch,
});

describe('pitchCapPx rows', () => {
  it('shares the pitch height between the labels on a pin', () => {
    const r = { ...reading(10), text: 'A1' };
    expect(pitchCapPx(r, 1)).toBeCloseTo(20);        // one label: bound by width (0.9 × 40 / 1.8)
    expect(pitchCapPx(r, 1, 2)).toBeCloseTo(18);     // number + name: half the height
    expect(pitchCapPx(r, 1, 3)).toBeCloseTo(12);     // number, reading, name: a third each
  });
});

describe('labelSizePx for a slotted reading', () => {
  it('takes the net names\' floor, not the 3 px one', () => {
    // 6 px fits the pitch, so nothing caps it; the floor is the cull's job.
    expect(labelSizePx(reading(6), view(1), th, false, false, 3)!.floorPx).toBe(8);
  });
  it('is hidden rather than shrunk below its floor by the pitch', () => {
    // 20 px wanted, a 20-mil pitch caps it at 0.3 × 20 = 6 px < 8.
    expect(labelSizePx(reading(20, 20), view(1), th, false, false, 3)).toBeNull();
    // A 40-mil pitch leaves 12 px: drawn, capped.
    expect(labelSizePx(reading(20, 40), view(1), th, false, false, 3)!.px).toBeCloseTo(12);
  });
});

describe('readingSlots', () => {
  it('records the band of each reading that will be drawn, keyed by pin', () => {
    const m = readingSlots([[[reading(10, 60)], ident]], view(1), th);
    expect([...m.values()]).toEqual([{ cy: 200, half: 6.5 }]);
  });
  it('leaves out readings too small to draw, and readings without a slot', () => {
    expect(readingSlots([[[reading(20, 20)], ident]], view(1), th).size).toBe(0);
    expect(readingSlots([[[{ ...reading(10, 60), slot: undefined }], ident]], view(1), th).size).toBe(0);
  });
});

describe('clearOfReading', () => {
  const slot = { cy: 100, half: 6.5 };
  it('keeps a label above the centre above the band, a label below it below', () => {
    expect(clearOfReading(98, 8, slot, 'circleNum')).toBeLessThanOrEqual(100 - 6.5 - 1 - 4);
    expect(clearOfReading(103, 8, slot, 'circleNet')).toBeGreaterThanOrEqual(100 + 6.5 + 1 + 4);
  });
  it('sends a centred number up and a centred name down', () => {
    expect(clearOfReading(100, 8, slot, 'circleNum')).toBeLessThan(100);
    expect(clearOfReading(100, 8, slot, 'circleNet')).toBeGreaterThan(100);
  });
  it('leaves a label that is already clear where it is', () => {
    expect(clearOfReading(60, 8, slot, 'circleNum')).toBe(60);
    expect(clearOfReading(140, 8, slot, 'circleNet')).toBe(140);
  });
});
