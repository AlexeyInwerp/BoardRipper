import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLES = path.resolve(__dirname, '../../../samples');

async function parseFile(rel: string) {
  const { parseBDV } = await import('../src/parsers/bdv-parser');
  const buf = fs.readFileSync(path.resolve(SAMPLES, rel));
  return parseBDV(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

test.describe('BDV plain-text parser — correction heuristics', () => {
  test('Compal 7-digit-ID writer: X-mirror normalization fires when BRDOUT is a proper rectangle', async () => {
    const board = await parseFile('BROKEN/BRD/LA-L978P_r1A_IH50A.brd');
    expect(board.format).toBe('BDV');
    expect(board.parserNotes?.some(n => /un-mirrored/i.test(n))).toBe(true);
    // UC1 is now in negative-X space (raw X=5394 → -5394 after flip)
    const uc1 = board.parts.find(p => p.name === 'UC1');
    expect(uc1).toBeTruthy();
    expect(uc1!.origin.x).toBeLessThan(0);
  });

  test('Same writer with all-zero BRDOUT (DAG3BEMBCD0): synthetic outline, no mirror', async () => {
    const board = await parseFile('HP 17-an100 Quanta G3BE DAG3BEMBCD0 Rev D.brd');
    expect(board.format).toBe('BDV');
    expect(board.parserNotes?.some(n => /synthetic/i.test(n))).toBe(true);
    expect(board.parserNotes?.some(n => /un-mirrored/i.test(n))).toBe(false);
    // Synthetic outline is a rectangle large enough to frame the parts —
    // without the fallback the outline would be 5 coincident (0,0) vertices
    // from the file's `BRDOUT: 5 0 0`.
    expect(board.outline.length).toBeGreaterThanOrEqual(4);
    const xs = board.outline.map(p => p.x);
    const ys = board.outline.map(p => p.y);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(1000);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(1000);
  });

  test('OpenBoardView-style writer (WISTRON) keeps coords intact, gets primarySide swap when file labels are inverted', async () => {
    const board = await parseFile('WISTRON WOODY_KBL 16924-2 (BDV).brd');
    expect(board.format).toBe('BDV');
    expect((board.parserNotes ?? []).some(n => /un-mirrored/i.test(n))).toBe(false);
    // File labels CPU1 (1356-pin BGA) on 'bottom' — heuristic recognises
    // that the component side is where the IC-heavy parts are and flags
    // primarySide='bottom' so the renderer opens showing them.
    const cpu1 = board.parts.find(p => p.name === 'CPU1');
    expect(cpu1?.side).toBe('bottom');
    expect(board.primarySide).toBe('bottom');
  });

  test('Side=0 through-hole pins use BRDOUT height as mirror axis', async () => {
    const board = await parseFile('BROKEN/BRD/LA-L978P_r1A_IH50A.brd');
    // Mounting hole H2: file stores part at Y=166 (top) with side=0 pin at
    // Y=7166. With BRDOUT height 7333 the un-mirrored pin Y should be 167
    // (within 1 mil of the part centre). The old max-part-Y axis (7252)
    // would land at Y=86 — ~80 mil away.
    const h2 = board.parts.find(p => p.name === 'H2');
    expect(h2).toBeTruthy();
    expect(h2!.pins.length).toBe(1);
    const pin = h2!.pins[0];
    // Top-parent through-hole pin: mapped to bottom side, Y un-mirrored.
    expect(pin.side).toBe('bottom');
    expect(Math.abs(pin.position.y - 167)).toBeLessThan(2);
  });
});
