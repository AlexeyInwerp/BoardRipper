import { describe, it, expect } from 'vitest';
import { pushLabel, sortLabelModel, type LabelModel } from './label-model';

describe('label-model', () => {
  it('pushLabel returns false with no model (BitmapText path)', () => {
    expect(pushLabel(null, 'top', { x: 0, y: 0, text: 'R1', fontSize: 8, color: 0xffffff, kind: 'part', partIndex: 0, anchorX: 0.5, anchorY: 0.5 })).toBe(false);
  });
  it('pushLabel routes by side and returns true', () => {
    const m: LabelModel = { top: [], bottom: [] };
    expect(pushLabel(m, 'bottom', { x: 1, y: 2, text: '5', fontSize: 4, color: 0xcccccc, kind: 'pinNum', partIndex: 3, anchorX: 0.5, anchorY: 0.5 })).toBe(true);
    expect(m.bottom).toHaveLength(1);
    expect(m.top).toHaveLength(0);
  });
  it('pushLabel passes anchor values through unchanged', () => {
    const m: LabelModel = { top: [], bottom: [] };
    pushLabel(m, 'top', { x: 0, y: 0, text: 'NET', fontSize: 6, color: 0, kind: 'circleNet', partIndex: 7, anchorX: 0.5, anchorY: 0.05 });
    pushLabel(m, 'top', { x: 0, y: 0, text: 'D1', fontSize: 5, color: 0xffffff, kind: 'diode', partIndex: 8, anchorX: 0.5, anchorY: 1.1 });
    expect(m.top.map(r => [r.anchorX, r.anchorY])).toEqual([[0.5, 0.05], [0.5, 1.1]]);
  });
  it('sortLabelModel groups by kind then size desc', () => {
    const m: LabelModel = {
      top: [
        { x: 0, y: 0, text: 'a', fontSize: 4, color: 0, kind: 'pinNum', partIndex: 0, anchorX: 0.5, anchorY: 0.5 },
        { x: 0, y: 0, text: 'b', fontSize: 9, color: 0, kind: 'part', partIndex: 1, anchorX: 0.5, anchorY: 0.5 },
        { x: 0, y: 0, text: 'c', fontSize: 8, color: 0, kind: 'pinNum', partIndex: 0, anchorX: 0.5, anchorY: 0.5 },
      ], bottom: [],
    };
    sortLabelModel(m);
    // 'part' (b) sorts before 'pinNum' by kind; within 'pinNum', fontSize
    // DESCENDING (the test title + sort rationale: "big labels first") puts
    // c (fontSize 8) before a (fontSize 4).
    expect(m.top.map(r => r.text)).toEqual(['b', 'c', 'a']);
  });
});
