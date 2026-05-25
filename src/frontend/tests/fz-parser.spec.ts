import { test, expect } from '@playwright/test';
import { deflate } from 'pako';

// Parser-level coverage for the FZ format's coordinate-unit handling.
//
// Regression context: some ASUS exporters stamp `UNIT:millimeters` onto files
// whose coordinates are nonetheless stored in mils (the same board ships
// elsewhere with no directive and byte-identical mil values). The parser used
// to trust the directive and multiply every coordinate by 25.4, inflating the
// board ~25× past the mil range the renderer's absolute pin-radius cap assumes.
// Result: the board opened but every pin and net line rendered sub-pixel —
// "no pins and nets". See X551MA_1.1_60NB0480-MB1310.fz.
//
// These fixtures are synthetic *unencrypted* FZ files (raw zlib, no RC6 key
// required) built in-memory, so the test is self-contained and key-free.

const MM_TO_MILS = 1000 / 25.4; // 39.3701

/**
 * Assemble a minimal valid unencrypted .fz buffer from `!`-delimited content
 * text. Layout: [4-byte header][zlib(content)][zlib(descr)][uint32 LE descrSize].
 * Bytes 4–5 are the zlib signature, so the parser takes the no-key path.
 */
function buildFz(contentText: string): ArrayBuffer {
  const zContent = deflate(contentText);
  const zDescr = deflate(''); // DESCR section is ignored by the parser
  const descrSize = zDescr.length + 4;
  const total = 4 + zContent.length + zDescr.length + 4;
  const out = new Uint8Array(total);
  out.set(zContent, 4);
  out.set(zDescr, 4 + zContent.length);
  new DataView(out.buffer).setUint32(total - 4, descrSize, true);
  return out.buffer;
}

const REFDES_HEADER = 'A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!';
const NET_HEADER = 'A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!';

/** Build content with the two-pin part U1 at the given coordinates. */
function content(opts: { unit?: string; p1: [number, number]; p2: [number, number] }): string {
  const lines: string[] = [];
  if (opts.unit) lines.push(`UNIT:${opts.unit}`);
  lines.push(REFDES_HEADER, 'S!U1!1!QFP!YES!0!');
  lines.push(NET_HEADER);
  lines.push(`S!GND!U1!1!VSS!${opts.p1[0]}!${opts.p1[1]}!!8!`);
  lines.push(`S!VCC!U1!2!VDD!${opts.p2[0]}!${opts.p2[1]}!!8!`);
  return lines.join('\n');
}

function pinXs(board: { parts: { pins: { position: { x: number } }[] }[] }): number[] {
  return board.parts.flatMap(p => p.pins.map(pin => pin.position.x));
}

test.describe('FZ parser — coordinate units', () => {
  test('UNIT:millimeters with mil-scale coords is treated as mils (the X551MA bug)', async () => {
    const { parseFZ } = await import('../src/parsers/fz-parser');
    // Span 4000 in both axes — clearly a mil board, not 4000 mm.
    const board = await parseFZ(buildFz(content({ unit: 'millimeters', p1: [1000, 2000], p2: [5000, 6000] })));

    expect(board.format).toBe('FZ');
    expect(board.parts.length).toBe(1);
    expect(board.nets.size).toBeGreaterThan(0);

    // Coordinates must NOT be inflated. ×25.4 or ×39.37 would push max X to
    // 127k / 197k; the board must stay in its native mil range.
    const xs = pinXs(board);
    expect(Math.max(...xs)).toBeCloseTo(5000, 1);
    expect(Math.min(...xs)).toBeCloseTo(1000, 1);
    const spanX = board.bounds.maxX - board.bounds.minX;
    expect(spanX).toBeLessThan(20000);
    expect(spanX).toBeGreaterThan(1000);
  });

  test('UNIT:millimeters with genuinely mm-scale coords is converted to mils', async () => {
    const { parseFZ } = await import('../src/parsers/fz-parser');
    // Span ~140 — a real millimetre board; convert mm → mils (×39.37).
    const board = await parseFZ(buildFz(content({ unit: 'millimeters', p1: [10, 20], p2: [150, 120] })));

    const xs = pinXs(board);
    expect(Math.max(...xs)).toBeCloseTo(150 * MM_TO_MILS, 0); // ≈ 5905.5
    expect(Math.min(...xs)).toBeCloseTo(10 * MM_TO_MILS, 0);  // ≈ 393.7
    // And definitely not the raw mm values nor the wrong ×25.4 factor.
    expect(Math.max(...xs)).not.toBeCloseTo(150, 0);
    expect(Math.max(...xs)).not.toBeCloseTo(150 * 25.4, 0);
  });

  test('no UNIT directive leaves mil coordinates untouched', async () => {
    const { parseFZ } = await import('../src/parsers/fz-parser');
    const board = await parseFZ(buildFz(content({ p1: [1000, 2000], p2: [5000, 6000] })));
    const xs = pinXs(board);
    expect(Math.max(...xs)).toBeCloseTo(5000, 1);
    expect(Math.min(...xs)).toBeCloseTo(1000, 1);
  });
});
