import { describe, it, expect } from 'vitest';
import { detectAbsolutePinCoords } from './bvr3-parser';

const part = (ox: number, oy: number, px: number, py: number) => [
  `PART_NAME P`, `PART_ORIGIN ${ox} ${oy}`, `PIN_ID P-1`, `PIN_ORIGIN ${px} ${py}`, `PART_END`,
];

describe('detectAbsolutePinCoords', () => {
  it('absolute when pin 1 sits on the part origin (Apple exports)', () => {
    expect(detectAbsolutePinCoords([...part(1000, 2000, 1000, 2000), ...part(3000, 500, 3000, 500)])).toBe(true);
  });

  it('absolute when pins sit near their part but not on its origin (Switch Lite)', () => {
    const lines = [
      ...part(646, 2190, 674, 2166),
      ...part(1200, 900, 1215, 880),
      ...part(3000, 400, 3000, 400),
    ];
    expect(detectAbsolutePinCoords(lines)).toBe(true);
  });

  it('relative when pins are small offsets from a distant origin', () => {
    expect(detectAbsolutePinCoords([...part(1000, 2000, 12, -8), ...part(3000, 500, -20, 4)])).toBe(false);
  });

  it('relative when no part has a non-zero origin', () => {
    expect(detectAbsolutePinCoords([...part(0, 0, 500, 500)])).toBe(false);
  });
});
