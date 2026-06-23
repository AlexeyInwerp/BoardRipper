import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * "Test criteria on parser update" — a machine-checkable guard for the class of
 * regression that data-only checks (part counts, no-OOM) miss: a part that
 * renders as a GIANT solid box covering much of the board.
 *
 * Real components never exceed ~13% of board area (largest seen: heatsinks).
 * The TESTCAD/IMPACT ASUS exports bundle scattered pads/vias into aggregate
 * pseudo-components (e.g. FA506QR `VU1_B` = 2714 pins over 72 mm, 54% of the
 * board). Those MUST be flagged `mechanical` so the scene builder skips their
 * fill + border (FlexBV treatment) instead of painting a board-spanning box.
 *
 * Invariant: after flagMechanicalParts(), NO part whose bbox exceeds
 * MAX_BODY_PCT of the board area may remain unflagged. A parser change that
 * reintroduces a giant solid component fails here.
 *
 * The synthetic case below runs everywhere (no fixtures). The optional sweep
 * over real CAD samples runs only when samples/cad/ is populated (gitignored),
 * matching the skip idiom used by tvw-parser.spec.ts / allegro specs.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/cad');

/** A part bbox larger than this fraction of the board area must be flagged. */
const MAX_BODY_PCT = 20;

function partBboxPct(p: { bounds: { minX: number; minY: number; maxX: number; maxY: number } }, boardArea: number): number {
  const w = p.bounds.maxX - p.bounds.minX;
  const h = p.bounds.maxY - p.bounds.minY;
  return (w * h) / boardArea * 100;
}

/** Build a degenerate .cad mirroring the real FA506QR/X415JA pathology: one
 *  shape whose pins are scattered across a board-spanning region, listed once
 *  per pin — and (as on a real board) a scatter of normal small parts sitting
 *  WITHIN that region, so the containment signal can recognise the aggregate. */
function aggregateCad(): string {
  const pins: string[] = [];
  const comps: string[] = [];
  // 300 pins scattered over a ~10000×6000 mil region (an aggregate, not a chip).
  for (let i = 0; i < 300; i++) {
    const x = 2000 + (i * 331) % 10000;
    const y = 2000 + (i * 211) % 6000;
    pins.push(`PIN P${i} PAD ${x} ${y} BOTTOM 0.000 0`);
    comps.push(`COMPONENT AGG1\nPLACE 0 0\nLAYER BOTTOM\nROTATION 0.000\nSHAPE AGG1 0 0\nDEVICE AGG1_${i}`);
  }
  // Normal small parts dotted across the same area (the real components the
  // aggregate visually covers) + corner parts to give the board a margin.
  const small: [number, number][] = [
    [3000, 3000], [5000, 4000], [7000, 5000], [9000, 3500], [11000, 6000],
    [4000, 6500], [13000, 9000], [500, 500],
  ];
  small.forEach(([bx, by], r) => {
    comps.push(`COMPONENT R${r}\nPLACE ${bx} ${by}\nLAYER BOTTOM\nROTATION 0.000\nSHAPE RES 0 0\nDEVICE R${r}`);
  });
  return (
    `$HEADER\nGENCAD 1.4\nUNITS USER 1000\n$ENDHEADER\n` +
    `$SHAPES\nSHAPE AGG1\n${pins.join('\n')}\nINSERT SMD\n` +
    `SHAPE RES\nPIN 1 PAD 0 0 BOTTOM 0.000 0\nPIN 2 PAD 20 0 BOTTOM 0.000 0\nINSERT SMD\n$ENDSHAPES\n` +
    `$COMPONENTS\n${comps.join('\n')}\n$ENDCOMPONENTS\n$SIGNALS\n$ENDSIGNALS\n`
  );
}

test.describe('CAD component-size invariant (no giant solid components)', () => {
  test('aggregate pseudo-components are flagged mechanical (synthetic)', async () => {
    const { parseCAD } = await import('../src/parsers/cad-parser');
    const { flagMechanicalParts } = await import('../src/parsers/types');
    const board = parseCAD(new TextEncoder().encode(aggregateCad()).buffer as ArrayBuffer);
    flagMechanicalParts(board.parts);

    const bb = board.bounds;
    const boardArea = (bb.maxX - bb.minX) * (bb.maxY - bb.minY) || 1;

    const giantUnflagged = board.parts.filter(
      p => !p.mechanical && partBboxPct(p, boardArea) > MAX_BODY_PCT,
    );
    expect(
      giantUnflagged.map(p => `${p.name} ${partBboxPct(p, boardArea).toFixed(0)}%`),
      'parts larger than MAX_BODY_PCT of the board must be flagged mechanical',
    ).toEqual([]);

    // And the aggregate must actually exist + be the flagged one (guards against
    // a future "collapse" that silently drops it).
    const agg = board.parts.find(p => p.name === 'AGG1');
    expect(agg, 'aggregate part AGG1 should survive parsing').toBeTruthy();
    expect(agg!.mechanical, 'AGG1 should be flagged mechanical').toBe(true);
  });

  test('real CAD samples: no unflagged board-spanning component', async () => {
    test.skip(!fs.existsSync(SAMPLES_DIR), 'samples/cad not present');
    const entries = fs.readdirSync(SAMPLES_DIR).filter(f => f.toLowerCase().endsWith('.cad'));
    test.skip(entries.length === 0, 'samples/cad empty');

    const { parseCAD } = await import('../src/parsers/cad-parser');
    const { flagMechanicalParts } = await import('../src/parsers/types');

    const offenders: string[] = [];
    for (const f of entries) {
      const buf = fs.readFileSync(path.join(SAMPLES_DIR, f));
      let board;
      try {
        board = parseCAD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
      } catch (e) {
        offenders.push(`${f}: parse threw ${(e as Error).message.slice(0, 60)}`);
        continue;
      }
      flagMechanicalParts(board.parts);
      const bb = board.bounds;
      const boardArea = (bb.maxX - bb.minX) * (bb.maxY - bb.minY) || 1;
      for (const p of board.parts) {
        if (!p.mechanical && partBboxPct(p, boardArea) > MAX_BODY_PCT) {
          offenders.push(`${f}: ${p.name} = ${partBboxPct(p, boardArea).toFixed(0)}% (pins=${p.pins.length})`);
        }
      }
    }
    expect(offenders, 'unflagged board-spanning components').toEqual([]);
  });
});
