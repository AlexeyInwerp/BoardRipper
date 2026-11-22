import { describe, it, expect } from 'vitest';
import { splitPartMeta } from './part-meta-rows';

describe('splitPartMeta', () => {
  it('shows value, part number and description; the rest goes under More', () => {
    const r = splitPartMeta({ name: 'U11P', angleDeg: 180, meta: {
      value: 'MIC5319-1.8YML', serial: 'MIC5319-XXYML', description: '500 mA LDO',
      package: 'MICREL_MLF2x2_6', sheet: 'power', heightMils: 33.465, angleDeg: 180,
    } });
    expect(r.main).toEqual([['Value', 'MIC5319-1.8YML'], ['Part number', 'MIC5319-XXYML'], ['Description', '500 mA LDO']]);
    expect(r.more.map(([k]) => k)).toEqual(['Package', 'Sheet', 'Height', 'Rotation']);
  });

  it('moves a value that only repeats the refdes or the package, and placeholders', () => {
    expect(splitPartMeta({ name: 'R0500', meta: { value: 'R0500' } }).main).toEqual([]);
    expect(splitPartMeta({ name: 'L60', meta: { value: 'HCM1012GH900BP_4P', package: 'HCM1012GH900BP-4P' } }).main).toEqual([]);
    const ph = splitPartMeta({ name: 'R303', meta: { value: 'Device1' } });
    expect(ph.main).toEqual([]);
    expect(ph.more).toEqual([['Value', 'Device1']]);
  });

  it('does not repeat a part number equal to the value', () => {
    const r = splitPartMeta({ name: 'U301', meta: { value: 'RP2040', serial: 'RP2040' } });
    expect(r.main).toEqual([['Value', 'RP2040']]);
    expect(r.more).toEqual([['Part number', 'RP2040']]);
  });

  it('keeps rotation from the part when meta has none', () => {
    expect(splitPartMeta({ name: 'C1', angleDeg: 90, meta: {} }).more).toEqual([['Rotation', '90°']]);
  });
});
