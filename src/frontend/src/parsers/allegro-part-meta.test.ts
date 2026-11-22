import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { AllegroDb } from './allegro/allegro-db';
import { assembleBoard, partMeta } from './allegro/allegro-assembler';

/**
 * Allegro BOM data. A BLK_0x06 component's BLK_0x03 fields carry its VALUE
 * (field id 2) and, on some boards, the part number (id 5); before, only the
 * footprint name reached Part.meta and Allegro boards showed no value at all.
 */
describe('partMeta', () => {
  it('takes the VALUE field, the part number and the rotation', () => {
    expect(partMeta('RES_0402', { value: '100K', partNumber: 'X802226-001', deviceType: 'RESN_402' }, 270000))
      .toEqual({ package: 'RES_0402', value: '100K', serial: 'X802226-001', angleDeg: 270 });
  });

  it('falls back to the device type when the component has no VALUE', () => {
    expect(partMeta('SOT23', { deviceType: 'AP2337SA-7_SOT23-3' }, 0))
      .toEqual({ package: 'SOT23', value: 'AP2337SA-7_SOT23-3' });
  });

  it('normalises a rotation past a full turn', () => {
    expect(partMeta('', undefined, -90000)).toEqual({ angleDeg: 270 });
    expect(partMeta('', undefined, 360000)).toBeUndefined();
  });
});

const SAMPLES = path.resolve(__dirname, '../../../../samples');
const sample = (rel: string) => path.join(SAMPLES, rel);
function load(file: string) {
  const b = fs.readFileSync(file);
  return assembleBoard(new AllegroDb(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer));
}

describe('Allegro samples (local only)', () => {
  const kronos = sample('incoming/uncategorized/Jasper_Kronos_v17.brd');
  it.skipIf(!fs.existsSync(kronos))('Jasper Kronos v17: value and part number on every part', () => {
    const board = load(kronos);
    expect(board.parts.every(p => p.meta?.value && p.meta?.serial)).toBe(true);
    expect(board.parts.find(p => p.name === 'R1V2')?.meta).toMatchObject({ value: '20', serial: 'X801322-001' });
  });

  const c361 = sample('allegroBRD/PC Laptop/Dell XPS 15 9550 Compal LA-C361P AAM00 Rev 1.0 (A00) BoardView/Compal LA-C361P AAM00 Rev 1.0_A00 BoardView.brd');
  it.skipIf(!fs.existsSync(c361))('LA-C361P: a BOM value on every part', () => {
    const board = load(c361);
    expect(board.parts.filter(p => p.meta?.value).length).toBe(board.parts.length);
    expect(board.parts.some(p => p.meta?.value === '22U_0805_16V6M')).toBe(true);
  });
});
