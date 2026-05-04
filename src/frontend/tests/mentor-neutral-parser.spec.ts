import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const SAMPLES = path.resolve(__dirname, '../../../samples');

async function parseFile(rel: string) {
  const { parseMentorNeutral } = await import('../src/parsers/mentor-neutral-parser');
  const buf = fs.readFileSync(path.resolve(SAMPLES, rel));
  return parseMentorNeutral(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

async function detectFormat(rel: string) {
  const { MentorNeutralFormat } = await import('../src/parsers/mentor-neutral-format');
  const { CADFormat }           = await import('../src/parsers/cad-format');
  const buf = fs.readFileSync(path.resolve(SAMPLES, rel));
  const header = new Uint8Array(buf.buffer, buf.byteOffset, Math.min(512, buf.byteLength));
  return {
    mentor: MentorNeutralFormat.detect(header),
    cad:    CADFormat.detect(header),
  };
}

const RV415 = 'BROKEN/new batch/RV415 BA41-01533A BA41-01534A AMD MP1.cad';

test.describe('Mentor Boardstation Neutral parser — RV415 BA41-01533A AMD MP1', () => {
  test('content sniff: Mentor matches, GenCAD does not', async () => {
    const r = await detectFormat(RV415);
    expect(r.mentor).toBe(true);
    expect(r.cad).toBe(false);
  });

  test('parses ~1791 components and ~1771 nets', async () => {
    const board = await parseFile(RV415);
    expect(board.format).toBe('MENTOR');
    // Sample stats from the file's record counts. Allow a small margin in case
    // the parser drops malformed records, but flag a real regression.
    expect(board.parts.length).toBeGreaterThanOrEqual(1750);
    expect(board.parts.length).toBeLessThanOrEqual(1800);
    expect(board.nets.size).toBeGreaterThanOrEqual(1700);
    expect(board.nets.size).toBeLessThanOrEqual(1800);
  });

  test('B1 (bead_core) lands at expected world coords with 2 pins', async () => {
    const board = await parseFile(RV415);
    const b1 = board.parts.find(p => p.name === 'B1');
    expect(b1).toBeTruthy();
    expect(b1!.side).toBe('bottom');         // COMP layer = 2
    expect(b1!.pins.length).toBe(2);
    // Origin is in mils (inches × 1000); placement was 4.984 7.084.
    expect(b1!.origin.x).toBeCloseTo(4984, 0);
    expect(b1!.origin.y).toBeCloseTo(7084, 0);
    // Pin 1 net = SPK5_L_P (leading slash stripped to match other formats).
    const pin1 = b1!.pins.find(p => p.name === '1');
    expect(pin1?.net).toBe('SPK5_L_P');
    // Meta carries the package and the device.
    expect(b1!.meta?.package).toBe('b1608');
    expect(b1!.meta?.value).toBe('bead_core');
  });

  test('non-default $NONE$ net folds to empty string (D11-2)', async () => {
    const board = await parseFile(RV415);
    const d11 = board.parts.find(p => p.name === 'D11');
    expect(d11).toBeTruthy();
    const pin2 = d11!.pins.find(p => p.name === '2');
    expect(pin2).toBeTruthy();
    expect(pin2!.net).toBe('');
  });

  test('vias are surfaced with their net names', async () => {
    const board = await parseFile(RV415);
    expect(board.vias).toBeTruthy();
    expect(board.vias!.length).toBeGreaterThan(4000);
    // First N_VIA in the file lives under NET /ADT3_ICM
    const adt3 = board.vias!.find(v => v.net === 'ADT3_ICM');
    expect(adt3).toBeTruthy();
  });

  test('parserNotes flag this as a Mentor neutral file', async () => {
    const board = await parseFile(RV415);
    expect(board.parserNotes?.some(n => /Mentor Boardstation/i.test(n))).toBe(true);
  });

  test('outline and bounds frame the parts (non-degenerate)', async () => {
    const board = await parseFile(RV415);
    const w = board.bounds.maxX - board.bounds.minX;
    const h = board.bounds.maxY - board.bounds.minY;
    // 9-inch board → 9000 mils; sanity floor of 5000 catches accidental
    // inches-not-converted regressions (would be ~9 instead of 9000).
    expect(w).toBeGreaterThan(5000);
    expect(h).toBeGreaterThan(5000);
    expect(board.outline.length).toBeGreaterThanOrEqual(4);
  });
});
