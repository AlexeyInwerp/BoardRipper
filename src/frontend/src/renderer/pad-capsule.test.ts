import { describe, it, expect } from 'vitest';
import { capsuleParams, capsulePolygon, isOblongRoundPad, capsuleGrowForRadius } from './pad-capsule';

describe('capsuleParams (oblong round-pad stadium geometry)', () => {
  it('returns null for square round pads (circle path)', () => {
    expect(capsuleParams(10, 20, 15, 15, 0, 0)).toBeNull();
  });

  it('vertical capsule at angle 0 when h > w', () => {
    const c = capsuleParams(100, 200, 15, 60, 0, 0)!;
    expect(c).not.toBeNull();
    expect(c.r).toBeCloseTo(7.5);
    // long axis = +Y; cap centres at cy ± (30 − 7.5)
    expect(c.c1x).toBeCloseTo(100);
    expect(c.c2x).toBeCloseTo(100);
    expect(Math.abs(c.c1y - 200)).toBeCloseTo(22.5);
    expect(Math.abs(c.c2y - 200)).toBeCloseTo(22.5);
    expect(c.c1y).not.toBeCloseTo(c.c2y);
  });

  it('rotating 90° turns the capsule horizontal (EC1 lead)', () => {
    const c = capsuleParams(100, 200, 15, 60, 90, 0)!;
    expect(c.r).toBeCloseTo(7.5);
    expect(c.c1y).toBeCloseTo(200);
    expect(c.c2y).toBeCloseTo(200);
    expect(Math.abs(c.c1x - 100)).toBeCloseTo(22.5);
    expect(Math.abs(c.c2x - 100)).toBeCloseTo(22.5);
  });

  it('w > h lies along X at angle 0', () => {
    const c = capsuleParams(0, 0, 60, 15, 0, 0)!;
    expect(c.r).toBeCloseTo(7.5);
    expect(c.c1y).toBeCloseTo(0);
    expect(c.c2y).toBeCloseTo(0);
    expect(Math.abs(c.c1x)).toBeCloseTo(22.5);
  });

  it('grow expands both radius and length', () => {
    const c = capsuleParams(0, 0, 15, 60, 0, 2)!;
    expect(c.r).toBeCloseTo(9.5);
    // half-length = (60/2 + 2) − 9.5 = 22.5
    expect(Math.abs(c.c1y)).toBeCloseTo(22.5);
  });

  it('degenerates to null when grow shrinks the capsule below a circle', () => {
    // negative grow can make the long dim shorter than the diameter
    expect(capsuleParams(0, 0, 15, 16, 0, -8)).toBeNull();
  });
});

describe('isOblongRoundPad', () => {
  it('is true for a stadium on either axis', () => {
    expect(isOblongRoundPad({ padShape: 'round', padWidth: 71, padHeight: 20 })).toBe(true);
    expect(isOblongRoundPad({ padShape: 'round', padWidth: 20, padHeight: 71 })).toBe(true);
  });

  it('is false for a square round pad — that is a circle', () => {
    expect(isOblongRoundPad({ padShape: 'round', padWidth: 28, padHeight: 28 })).toBe(false);
  });

  it('is false for every non-round shape and for missing or non-positive dims', () => {
    expect(isOblongRoundPad({ padShape: 'rect', padWidth: 71, padHeight: 20 })).toBe(false);
    expect(isOblongRoundPad({ padShape: 'roundrect', padWidth: 71, padHeight: 20 })).toBe(false);
    expect(isOblongRoundPad({ padShape: 'poly', padWidth: 71, padHeight: 20 })).toBe(false);
    expect(isOblongRoundPad({ padShape: 'round', padHeight: 20 })).toBe(false);
    expect(isOblongRoundPad({ padShape: 'round', padWidth: 0, padHeight: 20 })).toBe(false);
    expect(isOblongRoundPad({ padShape: 'round', padWidth: 71, padHeight: -3 })).toBe(false);
    expect(isOblongRoundPad({})).toBe(false);
  });
});

describe('grow is a geometric offset, not a scale', () => {
  // The property the whole slot + halo scheme rests on: growing or shrinking
  // a capsule slides its edges without moving its skeleton, because `g`
  // cancels out of half = (max − min) / 2.
  it('leaves the centreline invariant under any grow', () => {
    const base = capsuleParams(100, 200, 71, 20, 90, 0)!;
    for (const g of [-4, -1, 0, 3, 17.5]) {
      const c = capsuleParams(100, 200, 71, 20, 90, g)!;
      expect(c.c1x).toBeCloseTo(base.c1x, 9);
      expect(c.c1y).toBeCloseTo(base.c1y, 9);
      expect(c.c2x).toBeCloseTo(base.c2x, 9);
      expect(c.c2y).toBeCloseTo(base.c2y, 9);
      expect(c.axisRad).toBeCloseTo(base.axisRad, 9);
      expect(c.r).toBeCloseTo(base.r + g, 9);
    }
  });

  it('picks the long axis from the pad, not from a fixed field (71×20 @ 90°)', () => {
    const c = capsuleParams(0, 0, 71, 20, 90, 0)!;
    expect(c.r).toBeCloseTo(10, 9);
    expect(Math.hypot(c.c2x - c.c1x, c.c2y - c.c1y)).toBeCloseTo(51, 9);
    expect(Math.abs(c.c1x)).toBeLessThan(1e-9);   // vertical centreline
    expect(Math.abs(c.c1y)).toBeCloseTo(25.5, 9);
  });
});

describe('drill slot geometry (the negative-grow rule)', () => {
  // A slot is the SAME capsule at a smaller radius. Shrinking by
  // −(short − drill)/2 lands the cap radius exactly on drill/2, and the
  // copper ring is uniform by construction since both share one centreline.
  const cases = [
    { w: 71, h: 20, drill: 12, ring: 4.0, slotLen: 63 },
    { w: 80, h: 30, drill: 16, ring: 7.0, slotLen: 66 },
    { w: 26, h: 53, drill: 15, ring: 5.5, slotLen: 42 },
  ];
  for (const { w, h, drill, ring, slotLen } of cases) {
    it(`${w}×${h} drill ${drill} → ${drill}×${slotLen} slot with a ${ring} mil ring`, () => {
      const short = Math.min(w, h);
      const shrink = -(short - drill) / 2;
      const pad = capsuleParams(0, 0, w, h, 0, 0)!;
      const slot = capsuleParams(0, 0, w, h, 0, shrink)!;
      expect(slot.r).toBeCloseTo(drill / 2, 9);
      expect(pad.r - slot.r).toBeCloseTo(ring, 9);
      const centre = Math.hypot(slot.c2x - slot.c1x, slot.c2y - slot.c1y);
      expect(centre + drill).toBeCloseTo(slotLen, 9);
      expect(slot.c1x).toBeCloseTo(pad.c1x, 9);
      expect(slot.c1y).toBeCloseTo(pad.c1y, 9);
    });
  }

  it('a square pad degenerates to exactly the drill circle', () => {
    // 58×58 drill 33 and 28×28 drill 15: capsuleParams returns null on its own
    // guard and drawPadShape's fallback draws circle(max(gW, gH) / 2) — which
    // IS drill / 2. No caller-side branch needed.
    for (const [side, drill] of [[58, 33], [28, 15]] as const) {
      const shrink = -(side - drill) / 2;
      expect(capsuleParams(0, 0, side, side, 0, shrink)).toBeNull();
      expect(side + shrink * 2).toBeCloseTo(drill, 9);
    }
  });
});

describe('capsuleGrowForRadius — pin-size settings reach the capsule', () => {
  it('sets the pen to exactly 2·radius while pinning the skeleton', () => {
    const pin = { padShape: 'round', padWidth: 71, padHeight: 20, padAngleDeg: 90 };
    for (const r of [10, 6, 3, 1.5]) {
      const c = capsuleParams(0, 0, 71, 20, 90, capsuleGrowForRadius(pin, r))!;
      expect(c.r).toBeCloseTo(r, 9);
      expect(Math.hypot(c.c2x - c.c1x, c.c2y - c.c1y)).toBeCloseTo(51, 9);
    }
  });
});

describe('capsulePolygon', () => {
  it('samples a closed loop whose every vertex is exactly r from the centreline', () => {
    const pts = capsulePolygon(0, 0, 71, 20, 90, 0, 12)!;
    expect(pts.length).toBe(26); // (12 + 1) per cap
    const c = capsuleParams(0, 0, 71, 20, 90, 0)!;
    for (const [x, y] of pts) {
      const dx = c.c2x - c.c1x, dy = c.c2y - c.c1y;
      const len2 = dx * dx + dy * dy;
      let t = ((x - c.c1x) * dx + (y - c.c1y) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const px = c.c1x + t * dx, py = c.c1y + t * dy;
      expect(Math.hypot(x - px, y - py)).toBeCloseTo(c.r, 6);
    }
  });

  it('returns null when the shape has degenerated to a circle', () => {
    expect(capsulePolygon(0, 0, 40, 40, 0, 0)).toBeNull();
  });
});
