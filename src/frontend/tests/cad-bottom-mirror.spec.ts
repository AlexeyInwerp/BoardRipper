import { test, expect } from '@playwright/test';

/**
 * Regression: Allegro2CAD v0.2 GenCAD exports place bottom-side components
 * with a `SHAPE <name> MIRRORY FLIP` flag and shape pins in shape-LOCAL
 * coordinates. The placement transform is: mirror (in shape-local space) →
 * rotate (ROTATION) → translate (PLACE). The parser previously dropped the
 * MIRRORY token, so every bottom-side footprint was X-flipped about its
 * placement origin — pins landed on the wrong side and asymmetric parts
 * (origin ≠ footprint centre) shifted bodily to the wrong spot.
 *
 * Ground truth here is taken from an independent world-coordinate CAD export
 * of the *same* board (Dell XPS 9560 LA-E331P R10): top component UE2 matches
 * a plain rotate+translate (no mirror), while bottom components QE5 (rot 0)
 * and PR310 (rot 270) match ONLY when MIRRORY (negate local X) is applied
 * before rotation. All coordinates below are the verified world positions.
 */
const CAD = `$HEADER
GENCAD 1.4
USER "Allegro2CAD v0.2"
UNITS USER 1000
ORIGIN 0 0
$ENDHEADER
$BOARD
$ENDBOARD
$SHAPES
SHAPE UE2
PIN 1 O31X49 0.0 0.0 TOP 0.000 0
PIN 2 O31X49 -37.4 -104.48 TOP 0.000 0
PIN 3 O31X49 37.4 -104.48 TOP 0.000 0
INSERT SMD
SHAPE QE5
PIN 1 O24X41 -0.0 0.0 TOP 0.000 0
PIN 2 O24X41 -25.59 -72.99 TOP 0.000 0
PIN 3 O24X41 25.59 -72.99 TOP 0.000 0
INSERT SMD
SHAPE PR310
PIN 1 R83X98 -0.0 0.0 TOP 0.000 0
PIN 2 R41X98 73.82 -0.0 TOP 0.000 0
PIN 3 R41X98 -20.67 -169.29 TOP 0.000 0
PIN 4 R83X98 53.15 -169.29 TOP 0.000 0
INSERT SMD
$ENDSHAPES
$COMPONENTS
COMPONENT UE2
PLACE 3986.16 50.50
LAYER TOP
ROTATION 90.000
SHAPE UE2 0 0
DEVICE UE2
COMPONENT QE5
PLACE -2850.40 40.71
LAYER BOTTOM
ROTATION 0.000
SHAPE QE5 MIRRORY FLIP
DEVICE QE5
COMPONENT PR310
PLACE -8175.85 -3758.87
LAYER BOTTOM
ROTATION 270.000
SHAPE PR310 MIRRORY FLIP
DEVICE PR310
$ENDCOMPONENTS
$SIGNALS
$ENDSIGNALS
`;

/** World-coordinate ground truth (refdes → pin number → [x, y]). */
const EXPECTED: Record<string, Record<string, [number, number]>> = {
  // Top, rotation 90 — control: already correct before the fix.
  UE2: {
    '1': [3986.16, 50.50],
    '2': [4090.64, 13.10],
    '3': [4090.64, 87.90],
  },
  // Bottom, rotation 0, MIRRORY.
  QE5: {
    '1': [-2850.40, 40.71],
    '2': [-2824.81, -32.28],
    '3': [-2875.99, -32.28],
  },
  // Bottom, rotation 270, MIRRORY.
  PR310: {
    '1': [-8175.85, -3758.87],
    '2': [-8175.85, -3685.05],
    '3': [-8345.14, -3779.54],
    '4': [-8345.14, -3705.72],
  },
};

/**
 * Companion regression for the same investigation: an Allegro2CAD file whose
 * pin majority sits on the declared 'bottom' side must flag
 * primarySide='bottom' so the renderer swaps sides — otherwise the .cad
 * renders top/bottom swapped relative to its source Allegro .brd.
 */
const CAD_PRIMARY = `$HEADER
GENCAD 1.4
UNITS USER 1000
$ENDHEADER
$SHAPES
SHAPE BIGBOT
PIN 1 P 0 0 BOTTOM 0.000 0
PIN 2 P 10 0 BOTTOM 0.000 0
PIN 3 P 20 0 BOTTOM 0.000 0
PIN 4 P 30 0 BOTTOM 0.000 0
PIN 5 P 40 0 BOTTOM 0.000 0
PIN 6 P 50 0 BOTTOM 0.000 0
PIN 7 P 60 0 BOTTOM 0.000 0
PIN 8 P 70 0 BOTTOM 0.000 0
PIN 9 P 80 0 BOTTOM 0.000 0
PIN 10 P 90 0 BOTTOM 0.000 0
INSERT SMD
SHAPE SMALLTOP
PIN 1 P 0 0 TOP 0.000 0
PIN 2 P 10 0 TOP 0.000 0
INSERT SMD
$ENDSHAPES
$COMPONENTS
COMPONENT U1
PLACE 500 500
LAYER BOTTOM
ROTATION 0.000
SHAPE BIGBOT MIRRORY FLIP
DEVICE U1
COMPONENT R1
PLACE 200 200
LAYER TOP
ROTATION 0.000
SHAPE SMALLTOP 0 0
DEVICE R1
$ENDCOMPONENTS
$SIGNALS
$ENDSIGNALS
`;

test.describe('CAD bottom-side mirror (Allegro2CAD MIRRORY)', () => {
  test('primarySide pin-majority flips IC-heavy bottom boards', async () => {
    const { parseCAD } = await import('../src/parsers/cad-parser');
    const board = parseCAD(new TextEncoder().encode(CAD_PRIMARY).buffer as ArrayBuffer);

    // 10 bottom pins vs 2 top pins => IC-heavy side is 'bottom'.
    expect(board.primarySide).toBe('bottom');
  });

  test('bottom components apply MIRRORY before rotation/translation', async () => {
    const { parseCAD } = await import('../src/parsers/cad-parser');
    const buf = new TextEncoder().encode(CAD).buffer;
    const board = parseCAD(buf as ArrayBuffer);

    const byName = new Map(board.parts.map(p => [p.name, p]));
    for (const [refdes, pins] of Object.entries(EXPECTED)) {
      const part = byName.get(refdes);
      expect(part, `part ${refdes} should exist`).toBeTruthy();
      const pinByNum = new Map(part!.pins.map(p => [p.number, p.position]));
      for (const [num, [ex, ey]] of Object.entries(pins)) {
        const pos = pinByNum.get(num);
        expect(pos, `${refdes}.${num} should exist`).toBeTruthy();
        expect(pos!.x, `${refdes}.${num} X`).toBeCloseTo(ex, 1);
        expect(pos!.y, `${refdes}.${num} Y`).toBeCloseTo(ey, 1);
      }
    }
  });
});
