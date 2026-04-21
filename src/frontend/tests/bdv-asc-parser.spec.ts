import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/BROKEN/BDV');

const CASES = [
  { file: 'LA-L031P_r1A_GH53Z.bdv',                    minParts: 4000, minPins: 10000, minNails: 1000 },
  { file: 'LA-L181P_r1A_GH51G_GH71G_GH53G_GH57G.bdv',  minParts: 2500, minPins: 10000, minNails: 1500 },
  { file: 'LA-L191P_r1A_GH53G.bdv',                    minParts: 4500, minPins: 14000, minNails: 1500 },
];

test.describe('BDV ASC (Honhan / Tebo-ICT) Parser', () => {
  test('detects by obfuscated signature and rejects plain-text BDV', async () => {
    const { BDVAscFormat } = await import('../src/parsers/bdv-asc-format');
    const sig = new TextEncoder().encode('dd:1.3?,r?-=bb\r\n');
    expect(BDVAscFormat.detect(sig)).toBe(true);

    const plainBdv = new TextEncoder().encode('Creator\r\nBRDOUT: 0 0 0\r\n');
    expect(BDVAscFormat.detect(plainBdv)).toBe(false);

    const shortBuf = new Uint8Array(4);
    expect(BDVAscFormat.detect(shortBuf)).toBe(false);
  });

  for (const c of CASES) {
    test(`parses ${c.file}`, async () => {
      const { parseBDVAsc } = await import('../src/parsers/bdv-asc-parser');
      const buf = fs.readFileSync(path.resolve(SAMPLES_DIR, c.file));
      const board = parseBDVAsc(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

      expect(board.format).toBe('BDV_ASC');
      expect(board.parts.length).toBeGreaterThanOrEqual(c.minParts);
      expect(board.outline.length).toBeGreaterThan(100);
      expect(board.nails.length).toBeGreaterThanOrEqual(c.minNails);

      const totalPins = board.parts.reduce((n, p) => n + p.pins.length, 0);
      expect(totalPins).toBeGreaterThanOrEqual(c.minPins);

      // Bounds must be finite and non-degenerate.
      expect(Number.isFinite(board.bounds.minX)).toBe(true);
      expect(Number.isFinite(board.bounds.maxY)).toBe(true);
      expect(board.bounds.maxX - board.bounds.minX).toBeGreaterThan(1000);
      expect(board.bounds.maxY - board.bounds.minY).toBeGreaterThan(1000);

      // Every pin must have finite coords and a valid side.
      for (const part of board.parts) {
        for (const pin of part.pins) {
          expect(Number.isFinite(pin.position.x)).toBe(true);
          expect(Number.isFinite(pin.position.y)).toBe(true);
          expect(['top', 'bottom']).toContain(pin.side);
        }
      }

      // Most pins should carry a net name (the format has many (NC) pins, so
      // don't demand 100%, but at least a quarter must have nets).
      const pinsWithNet = board.parts.flatMap(p => p.pins).filter(p => p.net);
      expect(pinsWithNet.length).toBeGreaterThan(totalPins / 4);
      expect(board.nets.size).toBeGreaterThan(1000);
    });
  }
});
