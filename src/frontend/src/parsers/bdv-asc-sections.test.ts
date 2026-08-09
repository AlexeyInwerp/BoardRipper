import { describe, it, expect } from 'vitest';
import { parseBDVAsc, bundleAscFiles, identifyAscSection } from './bdv-asc-parser';

/** Trimmed-down copies of the five files of a real Tebo-ICT delivery
 *  (ASUS X555LD R36, 2015) — same headers, same column layout. */
const FORMAT = ` X555LD R36        Tebo-ICT,  license #Style

 Board Outline Contour             INCH units               21-May-2015 17:23

      X           Y         Radius

   -0.907      -4.241       0.000
    4.530      -4.241       0.000
    4.530       5.139       0.000
   -0.907       5.139       0.000
   -0.907      -4.241       0.000
`;

const PINS = ` X555LD R36        Tebo-ICT,  license #Style

 Part Pins List          1986/1986  Selected Parts             21-May-2015 17:23

Part        T/B
Pin   Name      X         Y     Layer  Net               Nail(s)

Part PR6001 (T)

   1    1    4.3967   -1.1463     1    SMB0_DAT_BAT_CON  1226
   2    2    4.3967   -1.1103     1    SMB0_DAT          1180

Part U4501 (B)

   1    1   -0.4025   -0.0706     1    3D VISION         1041
   2    2   -0.2126    0.1551     1    GND
`;

const PARTS = ` X555LD R36        Tebo-ICT,  license #Style

 Parts List              1986/1986  Selected Parts             21-May-2015 17:23
                                                           INCH units

Part             X         Y     Rot  Grid  T/B  'Device', 'Outline'

PR6001        4.3967   -1.1283  270.0  C3   (T)  'NBS_R0402_H16_000S_B', 'NBS_R0402_H16_000S_B'
U4501        -0.3075    0.0422  150.0  A3   (B)  'QFN32', 'QFN32'
PU9999        1.0000    1.0000    0.0  A1   (T)  'BGA100', 'BGA100'
`;

const NETS = ` X555LD R36        Tebo-ICT,  license #Style

 Net Listing            1993  Nets                       21-May-2015 17:23

#1    (S)  3D VISION
 U4501.1

#2    (S)  GND
 U4501.2

#3    (S)  NC_1999
`;

const NAILS = ` X555LD R36        Tebo-ICT,  license #Style

 Test Fixture Nails     1255/1255  Selected Drills           21-May-2015 17:23
                        1255 Nails,  1993 Nets               INCH units

Nail         X         Y   Type Grid T/B  Net   Net Name   Virtual Pin/Via

$1        2.4767   -1.9513   1  B4   (B)  #2    GND              T PIN TB_TP933.1
$2       -0.3823   -0.0463   1  A3   (T)  #788  3D VISION        T PIN TB_TP227.1
`;

const buf = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const parse = (files: Array<{ name: string; text: string }>) =>
  parseBDVAsc(buf(files.length === 1 ? files[0].text : bundleAscFiles(files)));

describe('identifyAscSection — the two sections the .bdv bundle never carries', () => {
  it('names the placement list and the net listing', () => {
    expect(identifyAscSection(PARTS)).toBe('parts.asc');
    expect(identifyAscSection(NETS)).toBe('nets.asc');
  });

  it('does not mistake the pins header for the parts header', () => {
    expect(identifyAscSection(PINS)).toBe('pins.asc');
  });

  it('still identifies a header-stripped file by row shape', () => {
    const strip = (t: string) => t.split('\n').slice(6).join('\n');
    expect(identifyAscSection(strip(PARTS))).toBe('parts.asc');
    expect(identifyAscSection(strip(NETS))).toBe('nets.asc');
  });
});

describe('parts.asc', () => {
  it('adds rotation and package to the parts pins.asc placed', () => {
    const board = parse([
      { name: 'Pins.asc', text: PINS },
      { name: 'Parts.asc', text: PARTS },
    ]);
    const pr = board.parts.find(p => p.name === 'PR6001')!;
    expect(pr.angleDeg).toBe(270);
    expect(pr.meta?.package).toBe('NBS_R0402_H16_000S_B');
    // Geometry stays pin-derived — the placement origin is not used here.
    expect(pr.origin.y).toBeCloseTo(-1128.3, 1);
    expect(pr.pins).toHaveLength(2);
  });

  it('emits parts that pins.asc never mentions', () => {
    const board = parse([
      { name: 'Pins.asc', text: PINS },
      { name: 'Parts.asc', text: PARTS },
    ]);
    const only = board.parts.find(p => p.name === 'PU9999')!;
    expect(only.pins).toHaveLength(0);
    expect(only.origin).toEqual({ x: 1000, y: 1000 });
    expect(only.side).toBe('top');
  });

  it('opens on its own as placed markers', () => {
    const board = parse([{ name: 'Parts.asc', text: PARTS }]);
    expect(board.parts.map(p => p.name)).toEqual(['PR6001', 'U4501', 'PU9999']);
    expect(board.bounds.maxX).toBeGreaterThan(board.bounds.minX);
  });
});

describe('nets.asc', () => {
  it('says what it is instead of failing as unreadable', () => {
    expect(() => parse([{ name: 'Nets.asc', text: NETS }]))
      .toThrow(/net listing section of a multi-file ASC export/);
  });

  it('fills a net for a pin whose net column was blank', () => {
    const pinsNC = PINS.replace('   2    2   -0.2126    0.1551     1    GND',
                                '   2    2   -0.2126    0.1551     1    (NC)');
    const board = parse([
      { name: 'Pins.asc', text: pinsNC },
      { name: 'Nets.asc', text: NETS },
    ]);
    expect(board.nets.get('GND')?.pinIndices).toHaveLength(1);
    expect(board.parts.find(p => p.name === 'U4501')!.pins[1].net).toBe('GND');
  });

  it('drops listed nets that no pin resolves to', () => {
    const board = parse([
      { name: 'Pins.asc', text: PINS },
      { name: 'Nets.asc', text: NETS },
    ]);
    expect(board.nets.has('NC_1999')).toBe(false);
  });
});

describe('net names containing spaces', () => {
  it('keeps the whole name on a pin, without the nail id', () => {
    const board = parse([{ name: 'Pins.asc', text: PINS }]);
    const u = board.parts.find(p => p.name === 'U4501')!;
    expect(u.pins[0].net).toBe('3D VISION');
    expect(board.nets.has('3D VISION')).toBe(true);
  });

  it('keeps the whole name on a nail, without the pin/via columns', () => {
    const board = parse([{ name: 'Nails.asc', text: NAILS }]);
    expect(board.nails.map(n => n.net)).toEqual(['GND', '3D VISION']);
  });
});

describe('a lone section still renders', () => {
  it('gives nails.asc a real extent instead of an empty screen', () => {
    const board = parse([{ name: 'Nails.asc', text: NAILS }]);
    expect(board.nails).toHaveLength(2);
    expect(board.bounds.maxX - board.bounds.minX).toBeGreaterThan(0);
    expect(board.bounds.maxY - board.bounds.minY).toBeGreaterThan(0);
  });

  it('opens the five-file delivery as one board', () => {
    const board = parse([
      { name: 'Format.asc', text: FORMAT },
      { name: 'Nails.asc', text: NAILS },
      { name: 'Pins.asc', text: PINS },
      { name: 'Parts.asc', text: PARTS },
      { name: 'Nets.asc', text: NETS },
    ]);
    expect(board.outline.length).toBe(5);
    expect(board.nails).toHaveLength(2);
    expect(board.parts).toHaveLength(3);
    expect(board.parts.find(p => p.name === 'U4501')!.angleDeg).toBe(150);
  });
});
