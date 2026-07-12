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

  // Regression for "2-pin cap/coil pads suddenly tiny" — newer XZZ exports
  // (M2-era boards, ~half the corpus) write a uniform placeholder pad
  // geometry (12×12 mil round, angle 0) on EVERY pin instead of real pad
  // shapes. Trusting it shrinks a 125-mil coil pad to a 12-mil dot. The
  // parser must detect the placeholder (single distinct size/shape/angle
  // across the whole file) and drop the geometry, so the renderer falls
  // back to the classic synthesized FlexBV pads.
  test('drops uniform placeholder pad geometry (12×12 round on every pin)', async () => {
    test.skip(!haveSmall, 'XZZ sample (A2681 KB 820-02862-02) not present (proprietary fixture)');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(loadSample(SMALL));
    for (const part of board.parts) {
      for (const pin of part.pins) {
        expect(pin.padBounds).toBeUndefined();
        expect(pin.padWidth).toBeUndefined();
        expect(pin.padHeight).toBeUndefined();
        expect(pin.padShape).toBeUndefined();
        // Classic no-geometry dot radius, not half the 12-mil placeholder.
        expect(pin.radius).toBe(8);
      }
    }
    // No copper-pad overlay entries either — they'd draw the same 12-mil dots.
    expect(board.pads ?? []).toHaveLength(0);
  });

  test('keeps real pad geometry on files with varied pad sizes', async () => {
    test.skip(!haveLarge, 'XZZ sample (820-02016-07 MacBook Air M1) not present (proprietary fixture)');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const board = parseXZZ(loadSample(LARGE));
    // L5820 is a power coil whose real pads are ~125×142 mil — the
    // placeholder guard must not flag this varied-geometry file.
    const coil = board.parts.find(p => p.name === 'L5820');
    expect(coil).toBeDefined();
    for (const pin of coil!.pins) {
      expect(pin.padBounds).toBeDefined();
      expect(Math.min(pin.padWidth!, pin.padHeight!)).toBeGreaterThan(50);
    }
    expect((board.pads ?? []).length).toBeGreaterThan(1000);
  });

  // Regression for "rotated chip drawn with axis-aligned outline" — the
  // parser must resolve a single part.angleDeg from the per-pad rotations
  // so the renderer's drawPartOutline picks the OBB branch instead of the
  // AABB fallback. N3842 on the A2442 board is a 19-pin IC rotated 45°
  // where every pad's angleDeg lands in {45, 135, 315}.
  const A2442 = path.resolve(XZZ_SAMPLES, "A24xx/A2442_820-02098 MacBook Pro/Schematic and boardview/MacBook Pro M1 Pro 14' A2442 820-02098-A PCB layer.pcb");
  const haveA2442 = fs.existsSync(A2442);
  test('resolves per-part angleDeg from pad rotations on 45°-tilted chips', async () => {
    test.skip(!haveA2442, 'XZZ sample (A2442 820-02098-A) not present (proprietary fixture)');
    const { parseXZZ } = await import('../src/parsers/xzz-parser');
    const { computePartRenderPoly, DEFAULTS } = await import('../src/store/render-settings');
    const board = parseXZZ(loadSample(A2442));
    const part = board.parts.find(p => p.name === 'N3842');
    expect(part).toBeDefined();
    expect(part!.angleDeg).toBe(45);
    const poly = computePartRenderPoly(part!, DEFAULTS);
    expect(poly).not.toBeNull();
    expect(poly!.length).toBe(4);
    // OBB centred near the part origin
    const cx = poly!.reduce((a, c) => a + c[0], 0) / 4;
    const cy = poly!.reduce((a, c) => a + c[1], 0) / 4;
    expect(Math.abs(cx - part!.origin.x)).toBeLessThan(50);
    expect(Math.abs(cy - part!.origin.y)).toBeLessThan(50);
    // First edge vector must be near 45° (cos45 ≈ sin45 ≈ 0.707)
    const ex = poly![1][0] - poly![0][0];
    const ey = poly![1][1] - poly![0][1];
    const len = Math.hypot(ex, ey);
    expect(len).toBeGreaterThan(50);
    expect(Math.abs(Math.abs(ex / len) - Math.SQRT1_2)).toBeLessThan(0.05);
    expect(Math.abs(Math.abs(ey / len) - Math.SQRT1_2)).toBeLessThan(0.05);
  });
});
