import { describe, it, expect } from 'vitest';
import { parseCAD } from './cad-parser';

const enc = new TextEncoder();
const buf = (s: string) => enc.encode(s).buffer as ArrayBuffer;

/**
 * Build a minimal GenCAD file whose $PADS entries carry `padGeom`, referenced
 * through $PADSTACKS by the two pins of a single 2-pin part.
 *
 * `units` is inserted verbatim into $HEADER (empty string = no UNITS record,
 * which is what the TESTCAD/IMPACT-family ASUS exports do).
 */
function makeCad(padGeom: string, units = 'UNITS USER 1000'): ArrayBuffer {
  return buf(
`$HEADER
GENCAD 1.4
${units}
$ENDHEADER
$PADS
PAD P1 RECTANGULAR -1
${padGeom}
$ENDPADS
$PADSTACKS
PADSTACK PS1 0
PAD P1 TOP 0 0
$ENDPADSTACKS
$SHAPES
INSERT SMD
SHAPE R1_T
PIN 1  PS1 0 0 TOP 0 0
PIN 2  PS1 100 0 TOP 0 0
$ENDSHAPES
$COMPONENTS
COMPONENT R1
PLACE 0 0
LAYER TOP
ROTATION 0
SHAPE R1_T 0 0
DEVICE R1
$ENDCOMPONENTS
$SIGNALS
SIGNAL NET1
NODE R1 1
$ENDSIGNALS
`);
}

const radii = (b: ArrayBuffer) => parseCAD(b).parts[0].pins.map(p => p.radius);

describe('CAD pad-derived pin radius', () => {
  it('derives the radius from a RECTANGLE pad instead of the 6-mil constant', () => {
    // RECTANGLE <x> <y> <w> <h> — a 30x30 pad is a 15-unit radius.
    expect(radii(makeCad('RECTANGLE 0 0 30 30'))).toEqual([15, 15]);
  });

  it('uses the inscribed radius for an oblong RECTANGLE pad', () => {
    expect(radii(makeCad('RECTANGLE -40 -80 80 160'))).toEqual([40, 40]);
  });

  it('derives the radius from a CIRCLE pad', () => {
    // CIRCLE <x> <y> <r>
    expect(radii(makeCad('CIRCLE 0.000 0.000 6.000'))).toEqual([6, 6]);
  });

  it('derives the radius from a LINE/ARC FINGER pad outline', () => {
    // Oblong finger: 14 wide x 66 tall -> inscribed radius 7.
    expect(radii(makeCad(
      'LINE 7.000 -33.000 7.000 33.000\n' +
      'ARC 7.000 33.000 -7.000 33.000 0.000 33.000\n' +
      'LINE -7.000 33.000 -7.000 -33.000\n' +
      'ARC -7.000 -33.000 7.000 -33.000 0.000 -33.000',
    ))).toEqual([7, 7]);
  });

  it('scales the pad radius by the UNITS factor, like every other coordinate', () => {
    // UNITS INCH -> 1000 mils per unit. A 0.03 x 0.03 inch pad is 15 mils.
    const b = makeCad('RECTANGLE 0 0 0.03 0.03', 'UNITS INCH');
    expect(radii(b)).toEqual([15, 15]);
  });

  it('keeps the 6-mil fallback when the pad cannot be resolved', () => {
    // Padstack references a pad name that $PADS never defines.
    const b = buf(
`$HEADER
GENCAD 1.4
UNITS USER 1000
$ENDHEADER
$PADSTACKS
PADSTACK PS1 0
PAD MISSING TOP 0 0
$ENDPADSTACKS
$SHAPES
INSERT SMD
SHAPE R1_T
PIN 1  PS1 0 0 TOP 0 0
PIN 2  PS1 100 0 TOP 0 0
$ENDSHAPES
$COMPONENTS
COMPONENT R1
PLACE 0 0
LAYER TOP
ROTATION 0
SHAPE R1_T 0 0
DEVICE R1
$ENDCOMPONENTS
$SIGNALS
SIGNAL NET1
NODE R1 1
$ENDSIGNALS
`);
    expect(radii(b)).toEqual([6, 6]);
  });

  it('ignores a degenerate zero-size pad and falls back', () => {
    expect(radii(makeCad('RECTANGLE 0 0 0 0'))).toEqual([6, 6]);
  });
});

/** Same skeleton, but the padstack body is supplied verbatim. */
function makeStackCad(padsBody: string, stackBody: string): ArrayBuffer {
  return buf(
`$HEADER
GENCAD 1.4
UNITS USER 1000
$ENDHEADER
$PADS
${padsBody}
$ENDPADS
$PADSTACKS
PADSTACK PS1 0
${stackBody}
$ENDPADSTACKS
$SHAPES
INSERT SMD
SHAPE R1_T
PIN 1  PS1 0 0 TOP 0 0
PIN 2  PS1 100 0 TOP 0 0
$ENDSHAPES
$COMPONENTS
COMPONENT R1
PLACE 0 0
LAYER TOP
ROTATION 0
SHAPE R1_T 0 0
DEVICE R1
$ENDCOMPONENTS
$SIGNALS
SIGNAL NET1
NODE R1 1
$ENDSIGNALS
`);
}

const SMALL = 'PAD SMALL RECTANGULAR -1\nRECTANGLE -6 -12.5 12 25';
const BIG   = 'PAD BIG RECTANGULAR -1\nRECTANGLE -112 -111 224 222';

describe('CAD padstack layer/size selection', () => {
  it('picks the smallest copper pad when a stack leaks an oversized residue entry', () => {
    // Real shape of 7523v10's PAD_SMD12X25: a 224x222 residue listed on TOP
    // alongside the real 12x25 pad. The small one is the true pad.
    expect(radii(makeStackCad(
      `${SMALL}\n${BIG}`,
      'PAD BIG TOP 0 0\nPAD SMALL TOP 0 0',
    ))).toEqual([6, 6]);
  });

  it('ignores SOLDERMASK / SOLDERPASTE entries when copper is present', () => {
    // Mask aperture is smaller than copper here — taking it would undersize.
    expect(radii(makeStackCad(
      `${BIG}\n${SMALL}`,
      'PAD BIG TOP 0 0\nPAD SMALL SOLDERMASK_TOP 0 0\nPAD SMALL SOLDERPASTE_TOP 0 0',
    ))).toEqual([111, 111]);
  });

  it('ignores INNER antipad entries when an outer copper layer exists', () => {
    expect(radii(makeStackCad(
      `${BIG}\n${SMALL}`,
      'PAD BIG TOP 0 0\nPAD SMALL INNER 0 0',
    ))).toEqual([111, 111]);
  });

  it('falls back to a non-copper-named layer when the stack has no TOP/BOTTOM/ALL', () => {
    expect(radii(makeStackCad(SMALL, 'PAD SMALL INNER 0 0'))).toEqual([6, 6]);
  });
});
