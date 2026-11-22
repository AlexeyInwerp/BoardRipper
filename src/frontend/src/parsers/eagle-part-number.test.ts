import { describe, it, expect } from 'vitest';
import { parseEagleXml, elementPartNumber } from './eagle-parser';

const el = (attrs: string) => parseEagleXml(`<element name="R1" package="0402">${attrs}</element>`).children[0];

describe('EAGLE element part number', () => {
  it('puts the manufacturer in front of the MPN', () => {
    expect(elementPartNumber(el('<attribute name="MFR" value="Panasonic"/><attribute name="MPN" value="ERJ-2RKF1002X"/>')))
      .toEqual({ serial: 'Panasonic ERJ-2RKF1002X' });
  });
  it('reads long-form and LCSC names, case-insensitively', () => {
    expect(elementPartNumber(el('<attribute name="manufacturer_part_number" value="drv8312"/>'))).toEqual({ serial: 'drv8312' });
    expect(elementPartNumber(el('<attribute name="LCSC" value="C47647"/>'))).toEqual({ serial: 'C47647' });
  });
  it('gives nothing without a part number', () => {
    expect(elementPartNumber(el('<attribute name="MFR" value="Panasonic"/><attribute name="NAME"/>'))).toEqual({});
  });
});
