import { describe, it, expect } from 'vitest';
import { normalizeOblongPads, type OblongPinLike } from './xzz-parser';

/** Helper: build a pin record with defaults. */
function pin(over: Partial<OblongPinLike>): OblongPinLike {
  return { x: 0, y: 0, padW: 15, padH: 15, padAngleDeg: 0, padShape: 'round', ...over };
}

describe('normalizeOblongPads (XZZ oblong-pad plausibility guard)', () => {
  it('keeps plausible QFP leads (EC1 left column: 15×60 @ 270°, 16-mil vertical pitch)', () => {
    // Left edge of an LQFP: pins stacked vertically, leads extend horizontally.
    const pins = [0, 16, 32, 48, 64].map(y =>
      pin({ x: 8464, y: 1847 - y, padH: 60, padAngleDeg: 270 }));
    normalizeOblongPads(pins);
    for (const p of pins) {
      expect(p.padH).toBe(60);
      expect(p.padAngleDeg).toBe(270);
    }
  });

  it('rescues QFP leads whose declared angle is wrong by 90° (EC1 top row: 16-mil horizontal pitch, ang=270)', () => {
    // The exporter stamps ONE angle on all 128 pins of the QFP; the top/
    // bottom rows' leads are physically perpendicular to it. Horizontal
    // 60-mil leads at 16-mil horizontal pitch would short — but rotated
    // +90° they are exactly the vendor-drawn vertical leads. The guard must
    // rotate, not collapse.
    const pins = [0, 16, 32, 48, 64].map(x =>
      pin({ x: 8000 + x, y: 1900, padH: 60, padAngleDeg: 270 }));
    normalizeOblongPads(pins);
    for (const p of pins) {
      expect(p.padH).toBe(60);
      expect(p.padAngleDeg).toBe(0); // 270 + 90 (mod 360)
    }
  });

  it('drops implausible BGA perimeter stubs (CPU1 pattern: 15×300 @ 90° over a staggered 25-mil grid)', () => {
    // Two staggered ball rows 12 mil apart. A 300-mil stub overlaps
    // neighbouring ball copper horizontally AND (rotated 90°) vertically —
    // not real pad geometry at either orientation.
    const row1 = [0, 25, 50, 75, 100].map(x =>
      pin({ x: 6722 + x, y: 3026, padH: 300, padAngleDeg: 90 }));
    const row2 = [0, 25, 50, 75, 100].map(x =>
      pin({ x: 6722 + 12.5 + x, y: 3014, padH: 300, padAngleDeg: 90 }));
    const pins = [...row1, ...row2];
    normalizeOblongPads(pins);
    for (const p of pins) {
      expect(p.padH).toBe(15);      // collapsed to a 15-mil round dot
      expect(p.padW).toBe(15);
      expect(p.padAngleDeg).toBe(0);
    }
  });

  it('collapses a same-size sibling that threads a grid gap when the group majority is implausible (CPU1 W1)', () => {
    // 295 of CPU1's 296 15×300 stubs overlap ball copper at both
    // orientations; one corner pin's stub happens to thread a gap in the
    // staggered grid. The exporter wrote one length for the whole ring —
    // if it is bogus for the majority, it is bogus for the outlier too.
    const row1 = [0, 25, 50, 75, 100].map(x =>
      pin({ x: 6722 + x, y: 3026, padH: 300, padAngleDeg: 90 }));
    const row2 = [0, 25, 50, 75, 100].map(x =>
      pin({ x: 6722 + 12.5 + x, y: 3014, padH: 300, padAngleDeg: 90 }));
    const loner = pin({ x: 9000, y: 5000, padH: 300, padAngleDeg: 90 }); // nothing near it
    const pins = [...row1, ...row2, loner];
    normalizeOblongPads(pins);
    expect(loner.padH).toBe(15);
    expect(loner.padAngleDeg).toBe(0);
  });

  it('keeps two-pin chip pads that point at each other without touching (15×20 @ 90°, 40-mil pitch)', () => {
    const pins = [pin({ x: 0, padH: 20, padAngleDeg: 90 }), pin({ x: 40, padH: 20, padAngleDeg: 90 })];
    normalizeOblongPads(pins);
    expect(pins[0].padH).toBe(20);
    expect(pins[1].padH).toBe(20);
  });

  it('collapses degenerate stroke lengths (h ≤ w, e.g. 15×1) to a pen-width dot', () => {
    const pins = [pin({ padH: 1 }), pin({ x: 100, padH: 8 })];
    normalizeOblongPads(pins);
    expect(pins[0].padH).toBe(15);
    expect(pins[0].padW).toBe(15);
    expect(pins[1].padH).toBe(15);
  });

  it('ignores rect pads and square round pads', () => {
    const pins = [
      pin({ padShape: 'rect', padH: 300, padAngleDeg: 90 }),
      pin({ x: 25, padShape: 'rect', padH: 300, padAngleDeg: 90 }),
      pin({ x: 50, padH: 15 }),
    ];
    normalizeOblongPads(pins);
    expect(pins[0].padH).toBe(300);
    expect(pins[1].padH).toBe(300);
    expect(pins[2].padH).toBe(15);
  });

  it('does not treat a duplicate pin record at the same position as an overlap victim', () => {
    const pins = [pin({ padH: 60, padAngleDeg: 270 }), pin({ padH: 60, padAngleDeg: 270 })];
    normalizeOblongPads(pins);
    expect(pins[0].padH).toBe(60);
    expect(pins[1].padH).toBe(60);
  });
});
