import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test.describe('BVR1 Parser', () => {
  test('parses space-delimited BVR1 file (820-01700) with non-empty outline and parts', async () => {
    const { parseBVR1 } = await import('../src/parsers/bvr1-parser');
    const file = path.resolve(__dirname, '../../../samples/820-01700/820-01700.bvr');
    const text = fs.readFileSync(file, 'utf8');
    const board = parseBVR1(text);

    expect(board.format).toBe('BVR1');
    expect(board.outline.length).toBeGreaterThan(100);
    expect(board.parts.length).toBeGreaterThan(100);

    const totalPins = board.parts.reduce((acc, p) => acc + p.pins.length, 0);
    expect(totalPins).toBeGreaterThan(1000);

    for (const p of board.parts) {
      expect(Number.isFinite(p.origin.x)).toBe(true);
      expect(Number.isFinite(p.origin.y)).toBe(true);
      for (const pin of p.pins) {
        expect(Number.isFinite(pin.position.x)).toBe(true);
        expect(Number.isFinite(pin.position.y)).toBe(true);
      }
    }
  });

  test('parses tab-delimited BVR1 fixture (spec example)', async () => {
    const { parseBVR1 } = await import('../src/parsers/bvr1-parser');
    const text = [
      'BVRAW_FORMAT_1',
      '<<Layout>>',
      'LOC_X\tLOC_Y',
      '0.000\t0.000',
      '6.800\t0.000',
      '6.800\t4.200',
      '0.000\t4.200',
      '<<Pin>>',
      'PART_NAME\tLOC\tPIN_ID\tPIN_NAME\tLOC_X\tLOC_Y\tLAYER\tNET_NAME',
      'U1900\t(T)\t1\tA1\t1.234\t2.345\t1\tPP3V3_S5',
      'U1900\t(T)\t2\tA2\t1.234\t2.395\t1\tPP5V_S3',
      'R5201\t(B)\t1\t1\t0.500\t1.000\t2\tGND',
      'R5201\t(B)\t2\t2\t0.550\t1.000\t2\tPP1V8_S3',
      '<<Nail>>',
      'PROBE\tLOC_X\tLOC_Y\tTYPE\tGRID\tLOC\tNET_ID\tNET_NAME',
      '1\t1.234\t2.345\t1\tA1\t(T)\t100\tPP3V3_S5',
      '2\t0.500\t1.000\t2\tB3\t(B)\t200\tGND',
    ].join('\n');

    const board = parseBVR1(text);

    expect(board.format).toBe('BVR1');
    expect(board.outline.length).toBe(4);
    expect(board.parts.length).toBe(2);
    expect(board.parts[0].name).toBe('U1900');
    expect(board.parts[0].pins.length).toBe(2);
    expect(board.parts[1].name).toBe('R5201');
    expect(board.parts[1].pins.length).toBe(2);
    expect(board.nails.length).toBe(2);

    expect(board.parts[0].pins[0].position.x).toBeCloseTo(1234);
    expect(board.parts[0].pins[0].position.y).toBeCloseTo(2345);
    expect(board.parts[0].pins[0].net).toBe('PP3V3_S5');
    // BVR (T) location maps to bottom side in the renderer (see parser comment)
    expect(board.parts[0].pins[0].side).toBe('bottom');
    expect(board.parts[1].pins[0].side).toBe('top');
  });
});
