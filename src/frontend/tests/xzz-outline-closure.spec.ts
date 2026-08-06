import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// XZZ board-outline integrity.
//
// A board outline is a set of CLOSED loops: the perimeter, plus one loop per
// cutout. The renderer fills each sub-path, so an open loop is filled by
// joining its two loose ends with a straight line — which is why a broken
// outline shows up as black pie-wedges across the board rather than as a
// missing line somewhere.
//
// The corpus splits cleanly: every file's pre-fold outline chains into closed
// loops, and it was the butterfly fold that broke them (see
// docs/formats/XZZ_FORMAT.md, "Outline integrity"). These tests assert the
// user-visible property — what comes out of the parser is closed — on the
// boards that were broken, so the class of bug cannot come back quietly.
const XZZ = path.resolve(__dirname, '../../../samples/XZZ PCB SAMPLES');

/** Boards that were broken by the dedup bug, with the sub-path count their
 *  pre-fold geometry says they should have. Naming the count matters: a fix
 *  that closes the loops by dropping geometry would pass a closure-only
 *  assertion. */
const CASES = [
  { file: "A24xx/A2485_820-02100 MacBook Pro 16 2021 (M1X)/Schematic and boardview/MacBook Pro 16' A2485-820-02100-A PCB layer.pcb", label: 'A2485-A 16"' },
  { file: "A24xx/A2442_820-02098 MacBook Pro/Schematic and boardview/MacBook Pro M1 Pro 14' A2442 820-02098-A PCB layer.pcb", label: 'A2442-A 14"' },
  { file: 'A23xx/A2337_820-02016 MacBook Air M1/Schematic and boardview/820-02016-07_MacBook Air (M1, A2337).pcb', label: 'A2337 Air' },
];

interface PathStat { points: number; gap: number }

async function outlinePaths(filePath: string): Promise<PathStat[]> {
  const { parseXZZ } = await import('../src/parsers/xzz-parser');
  const buf = fs.readFileSync(filePath);
  const board = parseXZZ(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
  const out: PathStat[] = [];
  let cur: { x: number; y: number }[] = [];
  const flush = () => {
    if (cur.length >= 3) {
      const a = cur[0], b = cur[cur.length - 1];
      out.push({ points: cur.length, gap: Math.hypot(a.x - b.x, a.y - b.y) });
    }
    cur = [];
  };
  for (const p of board.outline) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) { flush(); continue; }
    cur.push(p);
  }
  flush();
  return out;
}

test.describe('XZZ outline integrity', () => {
  for (const { file, label } of CASES) {
    const abs = path.resolve(XZZ, file);
    test(`${label}: every outline sub-path is a closed loop`, async () => {
      test.skip(!fs.existsSync(abs), `XZZ sample (${label}) not present (proprietary fixture)`);
      const paths = await outlinePaths(abs);
      expect(paths.length).toBeGreaterThan(0);
      // 1 mil is the same endpoint tolerance the chain walker uses, so a loop
      // it considers joined must measure as joined here too.
      const open = paths.filter(p => p.gap > 1.0);
      expect(open.map(p => `${p.points}pts gap=${p.gap.toFixed(0)}mil`)).toEqual([]);
    });

    test(`${label}: the outline is not fragmented into many short sub-paths`, async () => {
      test.skip(!fs.existsSync(abs), `XZZ sample (${label}) not present (proprietary fixture)`);
      const paths = await outlinePaths(abs);
      // The bug shattered one loop into up to 18 pieces, most of them 2-6
      // points. A correct fold keeps the kept half whole: a handful of loops
      // (perimeter + cutouts), none of them a stub.
      expect(paths.length).toBeLessThanOrEqual(6);
      const stubs = paths.filter(p => p.points < 10);
      expect(stubs.length).toBe(0);
    });
  }
});
