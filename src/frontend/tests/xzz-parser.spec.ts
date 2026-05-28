import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Parser-level coverage for the XZZ PCB format (XZZ / "YiDianTong" Apple repair
// boardview, DES-encrypted, butterfly-folded, occasionally multi-board). XZZ is
// the largest and most complex parser in the suite — DES block decrypt, segment
// chaining, butterfly fold-axis detection, and multi-board outline splitting —
// yet it shipped with ZERO dedicated parser tests. A regression in the decrypt
// or fold path would only surface when a user opened a board and saw garbage or
// a blank canvas. These tests assert on parser invariants (format, finite
// non-degenerate bounds, non-empty geometry, every coordinate finite,
// deterministic re-parse) rather than exact counts, so future parser
// improvements that change part/pin totals don't break the test.
//
// Fixtures live under the gitignored, proprietary "XZZ PCB SAMPLES/" tree, so
// the whole spec skips gracefully when they're absent — same fixture-guard
// idiom as ci-smoke.spec.ts / tvw-parser.spec.ts (samples/BROKEN/ guard).

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Smallest XZZ fixture in the corpus (~113 KB) for a fast deterministic
// double-parse; a larger MacBook mainboard exercises the heavier multi-board /
// butterfly path.
const XZZ_SAMPLES = path.resolve(__dirname, '../../../samples/XZZ PCB SAMPLES');
const SMALL = path.resolve(XZZ_SAMPLES, 'A26xx/A2681 820-02862 M2/A2681 KB 820-02862-02 boardview.pcb');
const LARGE = path.resolve(XZZ_SAMPLES, 'A23xx/A2337_820-02016 MacBook Air M1/Schematic and boardview/820-02016-07_MacBook Air (M1, A2337).pcb');

function loadSample(filePath: string): ArrayBuffer {
  const buf = fs.readFileSync(filePath);
  // Slice into a clean ArrayBuffer (Node Buffers share memory with their
  // underlying pool which can confuse Uint8Array-based parsers).
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const haveSmall = fs.existsSync(SMALL);
const haveLarge = fs.existsSync(LARGE);

test.describe('XZZ parser', () => {
  test('parses a small XZZ board: format, bounds, parts, pins, nets populated', async () => {
    test.skip(!haveSmall, 'XZZ sample (A2681 KB 820-02862-02) not present (proprietary fixture)');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(loadSample(SMALL));

    expect(board.format).toBe('XZZ');

    // Bounds finite and non-degenerate — a decrypt regression typically
    // collapses or NaNs these.
    expect(Number.isFinite(board.bounds.minX)).toBe(true);
    expect(Number.isFinite(board.bounds.minY)).toBe(true);
    expect(Number.isFinite(board.bounds.maxX)).toBe(true);
    expect(Number.isFinite(board.bounds.maxY)).toBe(true);
    expect(board.bounds.maxX).toBeGreaterThan(board.bounds.minX);
    expect(board.bounds.maxY).toBeGreaterThan(board.bounds.minY);

    // Geometry present. Conservative "at least one of each" so a future
    // parser improvement that changes counts doesn't break the test.
    expect(board.parts.length).toBeGreaterThan(0);
    expect(board.nets.size).toBeGreaterThan(0);

    const totalPins = board.parts.reduce((acc, p) => acc + p.pins.length, 0);
    expect(totalPins).toBeGreaterThan(0);

    // Every part origin and every pin position must be finite — the core
    // deobfuscation-regression guard. A bad DES key, misaligned block, or
    // broken butterfly fold would leak NaN/Infinity here long before the
    // renderer noticed.
    for (const part of board.parts) {
      expect(Number.isFinite(part.origin.x)).toBe(true);
      expect(Number.isFinite(part.origin.y)).toBe(true);
      for (const pin of part.pins) {
        expect(Number.isFinite(pin.position.x)).toBe(true);
        expect(Number.isFinite(pin.position.y)).toBe(true);
      }
    }
  });

  test('every pin carries a string net name', async () => {
    test.skip(!haveSmall, 'XZZ sample (A2681 KB 820-02862-02) not present (proprietary fixture)');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(loadSample(SMALL));
    for (const part of board.parts) {
      for (const pin of part.pins) {
        // XZZ pin nets are strings; a non-string would indicate a
        // decode/section-length bug.
        expect(typeof pin.net).toBe('string');
      }
    }
  });

  test('parsing the same buffer twice yields identical counts (deterministic)', async () => {
    test.skip(!haveSmall, 'XZZ sample (A2681 KB 820-02862-02) not present (proprietary fixture)');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const a = parseXZZ(loadSample(SMALL));
    const b = parseXZZ(loadSample(SMALL));
    expect(a.parts.length).toBe(b.parts.length);
    expect(a.outline.length).toBe(b.outline.length);
    expect(a.nets.size).toBe(b.nets.size);
    const pinsA = a.parts.reduce((acc, p) => acc + p.pins.length, 0);
    const pinsB = b.parts.reduce((acc, p) => acc + p.pins.length, 0);
    expect(pinsA).toBe(pinsB);
  });

  test('parses a full MacBook mainboard (butterfly / multi-board path) with finite coords', async () => {
    test.skip(!haveLarge, 'XZZ sample (820-02016-07 MacBook Air M1) not present (proprietary fixture)');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(loadSample(LARGE));

    expect(board.format).toBe('XZZ');
    expect(board.parts.length).toBeGreaterThan(100);
    expect(board.nets.size).toBeGreaterThan(100);

    expect(board.bounds.maxX).toBeGreaterThan(board.bounds.minX);
    expect(board.bounds.maxY).toBeGreaterThan(board.bounds.minY);

    // Every recovered coordinate must be finite — including whatever the
    // butterfly fold / multi-board split produced.
    for (const part of board.parts) {
      expect(Number.isFinite(part.origin.x)).toBe(true);
      expect(Number.isFinite(part.origin.y)).toBe(true);
      for (const pin of part.pins) {
        expect(Number.isFinite(pin.position.x)).toBe(true);
        expect(Number.isFinite(pin.position.y)).toBe(true);
      }
    }

    // If the parser detected a butterfly fold axis it must be a known value;
    // if it grouped the outline into multiple boards each group must be sane.
    if (board.butterflyFoldAxis !== undefined) {
      expect(['x', 'y']).toContain(board.butterflyFoldAxis);
    }
    if (board.boardGroups) {
      for (const g of board.boardGroups) {
        expect(g.components.length).toBeGreaterThan(0);
        if (g.fold) expect(['x', 'y']).toContain(g.fold.dim);
      }
    }
  });
});
