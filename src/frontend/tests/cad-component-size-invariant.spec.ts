import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * "Test criteria on parser update" — a machine-checkable guard for the class of
 * regression that data-only checks (part counts, no-OOM) miss: a multi-pin
 * component that renders far larger than physically possible because the parser
 * mangled its coordinates.
 *
 * Two real bugs this guards (both in the ASUS TESTCAD/IMPACT .cad exports —
 * FA506QR, X415JA, G513IM):
 *   1. Shape RE-CENTERING applied to world-coordinate-shape files. Those files
 *      encode each part's true position in its SHAPE pins and use PLACE only as
 *      a tiny nudge; recentering subtracted each shape's centroid and collapsed
 *      every part onto PLACE, crushing the board to a fraction of its size and
 *      leaving components 5–50× oversized (VU1_B = 54% of the board vs 3% real,
 *      cross-checked against the FZ export of the same chassis).
 *   2. The N² pin explosion (see cad-duplicate-component-collapse.spec.ts).
 *
 * Invariant: NO part with >= MIN_PINS pins may have a bbox larger than
 * MAX_BODY_PCT of the board area. Real multi-pin parts top out near 8%; the
 * pin floor exempts legitimately board-spanning ZERO-pin mechanicals
 * (heatsink / shield frames, e.g. MEC2 at 87%).
 *
 * The synthetic cases run everywhere; the optional sweep over samples/cad
 * (gitignored) runs only when populated, matching tvw-parser / allegro specs.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/cad');

const MAX_BODY_PCT = 25;
const MIN_PINS = 30;

function partBboxPct(p: { bounds: { minX: number; minY: number; maxX: number; maxY: number } }, boardArea: number): number {
  const w = p.bounds.maxX - p.bounds.minX;
  const h = p.bounds.maxY - p.bounds.minY;
  return (w * h) / boardArea * 100;
}

function oversizedMultiPinParts(board: { parts: any[]; bounds: any }): string[] {
  const bb = board.bounds;
  const boardArea = (bb.maxX - bb.minX) * (bb.maxY - bb.minY) || 1;
  return board.parts
    .filter(p => p.pins.length >= MIN_PINS && partBboxPct(p, boardArea) > MAX_BODY_PCT)
    .map(p => `${p.name} ${partBboxPct(p, boardArea).toFixed(0)}% (pins=${p.pins.length})`);
}

/**
 * Reproduce the world-coordinate-shape pathology: shapes hold ABSOLUTE board
 * positions, PLACE is a tiny nudge. A compact 100-pin BGA sits at world
 * (10000, 6000); passives spread the board out to ~20000×12000. If the parser
 * wrongly recenters, the BGA collapses onto PLACE while the board collapses to
 * the (tiny) PLACE spread — making the BGA a board-spanning giant. Correct
 * handling keeps the BGA at ~1% of the board.
 */
function worldCoordCad(): string {
  const shapes: string[] = [];
  const comps: string[] = [];
  // Compact 10×10 BGA at world (10000, 6000), 40-mil pitch → 360×360 mils.
  const bgaPins: string[] = [];
  for (let r = 0; r < 10; r++)
    for (let c = 0; c < 10; c++)
      bgaPins.push(`PIN ${r}_${c} PAD ${10000 + c * 40} ${6000 + r * 40} BOTTOM 0.000 0`);
  shapes.push(`SHAPE BGA\n${bgaPins.join('\n')}\nINSERT SMD`);
  comps.push(`COMPONENT U1\nPLACE 3 3\nLAYER BOTTOM\nROTATION 0.000\nSHAPE BGA 0 0\nDEVICE U1`);
  // 60 passives whose 2-pin shapes carry their own world positions, spreading
  // the board across 0..20000 × 0..12000.
  for (let i = 0; i < 60; i++) {
    const x = (i * 331) % 20000;
    const y = (i * 211) % 12000;
    shapes.push(`SHAPE R${i}\nPIN 1 PAD ${x} ${y} BOTTOM 0.000 0\nPIN 2 PAD ${x + 30} ${y} BOTTOM 0.000 0\nINSERT SMD`);
    comps.push(`COMPONENT R${i}\nPLACE 2 2\nLAYER BOTTOM\nROTATION 0.000\nSHAPE R${i} 0 0\nDEVICE R${i}`);
  }
  return (
    `$HEADER\nGENCAD 1.4\nUNITS USER 1000\n$ENDHEADER\n` +
    `$SHAPES\n${shapes.join('\n')}\n$ENDSHAPES\n` +
    `$COMPONENTS\n${comps.join('\n')}\n$ENDCOMPONENTS\n$SIGNALS\n$ENDSIGNALS\n`
  );
}

test.describe('CAD component-size invariant (no impossibly-large components)', () => {
  test('world-coordinate-shape files are NOT recentered into giant parts', async () => {
    const { parseCAD } = await import('../src/parsers/cad-parser');
    const board = parseCAD(new TextEncoder().encode(worldCoordCad()).buffer as ArrayBuffer);

    // Board must span the world coordinates (~20000×12000), not collapse to the
    // tiny PLACE spread.
    expect(board.bounds.maxX - board.bounds.minX, 'board width').toBeGreaterThan(15000);

    // The 100-pin BGA must be a small fraction of the board, not board-spanning.
    expect(oversizedMultiPinParts(board), 'oversized multi-pin parts').toEqual([]);
    const u1 = board.parts.find(p => p.name === 'U1')!;
    const boardArea = (board.bounds.maxX - board.bounds.minX) * (board.bounds.maxY - board.bounds.minY);
    expect(partBboxPct(u1, boardArea), 'U1 bbox % of board').toBeLessThan(5);
  });

  test('real CAD samples: no impossibly-large multi-pin component', async () => {
    test.skip(!fs.existsSync(SAMPLES_DIR), 'samples/cad not present');
    const entries = fs.readdirSync(SAMPLES_DIR).filter(f => f.toLowerCase().endsWith('.cad'));
    test.skip(entries.length === 0, 'samples/cad empty');

    const { parseCAD } = await import('../src/parsers/cad-parser');
    const offenders: string[] = [];
    for (const f of entries) {
      const buf = fs.readFileSync(path.join(SAMPLES_DIR, f));
      try {
        const board = parseCAD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
        for (const o of oversizedMultiPinParts(board)) offenders.push(`${f}: ${o}`);
      } catch (e) {
        offenders.push(`${f}: parse threw ${(e as Error).message.slice(0, 60)}`);
      }
    }
    expect(offenders, 'impossibly-large multi-pin components').toEqual([]);
  });
});
