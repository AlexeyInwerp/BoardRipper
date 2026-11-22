import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { parseAltiumPcb } from './altium/altium-pcb-parser';

/** Altium BOM data: the comment text (Texts6, the value), SOURCEDESCRIPTION,
 *  SOURCELIBREFERENCE, SOURCEHIERARCHICALPATH and HEIGHT. Samples are KiCad's
 *  own QA boards (qa/data/pcbnew/plugins/altium), local only. */
const DIR = path.resolve(__dirname, '../../../../samples/incoming/altium');
const load = (n: string) => {
  const b = fs.readFileSync(path.join(DIR, n));
  return parseAltiumPcb(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
};
const has = (n: string) => fs.existsSync(path.join(DIR, n));

describe('Altium part meta (local samples)', () => {
  it.skipIf(!has('eDP_adapter_dvt1.PcbDoc'))('eDP adapter: value from the comment text', () => {
    const c10c = load('eDP_adapter_dvt1.PcbDoc').parts.find(p => p.name === 'C10C');
    expect(c10c?.meta).toMatchObject({ value: '0.1uF, 25V, X5R', description: 'Capacitor (Semiconductor SIM Model)', sheet: 'it6251_core' });
    expect(c10c?.meta?.heightMils).toBeCloseTo(23.622);
  });

  it.skipIf(!has('Fastino_Ground_Isolator.PcbDoc'))('Fastino: parses, and keeps the ± of the Unicode description', () => {
    const board = load('Fastino_Ground_Isolator.PcbDoc');
    const c266 = board.parts.find(p => p.name === 'C266');
    expect(c266?.meta).toMatchObject({ value: '47n', serial: 'TDK_C0510X7R1E473M030BA', sheet: 'Power' });
    expect(c266?.meta?.description).toContain('±20%');
  });
});
