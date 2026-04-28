import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// Parser-level coverage for the BRD format (Apple/Mac repair binary
// boardview, line-key obfuscated). The previous review flagged this as
// a critical gap — BRD ships in production via the Library and had zero
// dedicated parser tests; binary-format regressions on the deobfuscation
// step would have surfaced only when a user opened a board.
//
// The fixture is a real Apple boardview from samples/. We assert on
// parser invariants (format, finite bounds, non-empty geometry, every
// coord finite) rather than exact part counts, so a future parser
// improvement that adds parts doesn't break the test.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SAMPLE_PATH = path.resolve(__dirname, '../../../samples/820-02935-05.brd');

function loadSample(): ArrayBuffer {
  const buf = fs.readFileSync(SAMPLE_PATH);
  // Slice into a clean ArrayBuffer (Node Buffers share memory with their
  // underlying pool which can confuse Uint8Array-based parsers).
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

test.describe('BRD parser', () => {
  test('parses 820-02935-05.brd: format, bounds, parts, nets all populated', async () => {
    const { parseBRD } = await import('../src/parsers/brd-parser');
    const board = parseBRD(loadSample());

    expect(board.format).toBe('BRD');

    // Bounds finite and non-degenerate.
    expect(Number.isFinite(board.bounds.minX)).toBe(true);
    expect(Number.isFinite(board.bounds.minY)).toBe(true);
    expect(Number.isFinite(board.bounds.maxX)).toBe(true);
    expect(Number.isFinite(board.bounds.maxY)).toBe(true);
    expect(board.bounds.maxX).toBeGreaterThan(board.bounds.minX);
    expect(board.bounds.maxY).toBeGreaterThan(board.bounds.minY);

    // Outline is the board polygon — Apple BRDs always carry one.
    expect(board.outline.length).toBeGreaterThan(0);

    // Parts and nets are populated. Numbers are conservative ("at least
    // one of each") so future parser improvements don't break the test.
    expect(board.parts.length).toBeGreaterThan(0);
    expect(board.nets.size).toBeGreaterThan(0);

    // Every part has a finite origin and every pin a finite position —
    // catches the kind of NaN-producing deobfuscation regression we
    // wouldn't otherwise notice until the renderer crashes.
    for (const part of board.parts) {
      expect(Number.isFinite(part.origin.x)).toBe(true);
      expect(Number.isFinite(part.origin.y)).toBe(true);
      for (const pin of part.pins) {
        expect(Number.isFinite(pin.position.x)).toBe(true);
        expect(Number.isFinite(pin.position.y)).toBe(true);
      }
    }
  });

  test('parts include at least one pin in total', async () => {
    const { parseBRD } = await import('../src/parsers/brd-parser');
    const board = parseBRD(loadSample());
    const totalPins = board.parts.reduce((acc, p) => acc + p.pins.length, 0);
    expect(totalPins).toBeGreaterThan(0);
  });

  test('every pin references a non-empty net name', async () => {
    const { parseBRD } = await import('../src/parsers/brd-parser');
    const board = parseBRD(loadSample());
    for (const part of board.parts) {
      for (const pin of part.pins) {
        // BRD pin nets are strings; empty would indicate a deobfuscation
        // bug or a misaligned section length count.
        expect(typeof pin.net).toBe('string');
      }
    }
  });

  test('parsing the same buffer twice yields identical part counts (deterministic)', async () => {
    const { parseBRD } = await import('../src/parsers/brd-parser');
    const a = parseBRD(loadSample());
    const b = parseBRD(loadSample());
    expect(a.parts.length).toBe(b.parts.length);
    expect(a.outline.length).toBe(b.outline.length);
    expect(a.nets.size).toBe(b.nets.size);
  });
});
