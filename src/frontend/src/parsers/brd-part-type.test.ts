import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseBRD } from './brd-parser';

/** Apple BRD part flags: bits 0x4 / 0x8 = SMD top / bottom, 1 / 2 = through-hole. */
const DIR = path.resolve(__dirname, '../../../../samples/incoming/apple-brd');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter(f => /\.brd$/i.test(f)) : [];

describe('Apple BRD part type (local samples)', () => {
  it.skipIf(files.length === 0)('types every part, nearly all SMD', () => {
    for (const f of files) {
      const b = fs.readFileSync(path.join(DIR, f));
      const board = parseBRD(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
      const smd = board.parts.filter(p => p.type === 'smd').length;
      const th = board.parts.filter(p => p.type === 'throughhole').length;
      expect(smd + th, f).toBe(board.parts.length);
      expect(th, f).toBeLessThan(board.parts.length * 0.05);
    }
  });
});
