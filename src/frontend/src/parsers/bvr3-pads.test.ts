import { describe, it, expect } from 'vitest';
import { parseBVR3, parsePinRadius, parsePinOutline } from './bvr3-parser';

describe('BVR3 PIN_RADIUS', () => {
  it('reads plain mils', () => expect(parsePinRadius('9.268')).toBe(9.268));
  it('reads the tuple form as a diameter in inches (Switch Lite)', () => {
    expect(parsePinRadius('(0.0175, 3)')).toBeCloseTo(8.75);
    expect(parsePinRadius('(0.05, 3)')).toBeCloseTo(25);
  });
  it('gives nothing for junk', () => expect(parsePinRadius('(x, 3)')).toBeUndefined());
});

describe('BVR3 PIN_OUTLINE_RELATIVE', () => {
  it('offsets the corners by the pin origin', () => {
    expect(parsePinOutline('-6.89 3.937 -6.89 -3.937 6.89 -3.937 6.89 3.937', { x: 100, y: 200 }))
      .toEqual([{ x: 93.11, y: 203.937 }, { x: 93.11, y: 196.063 }, { x: 106.89, y: 196.063 }, { x: 106.89, y: 203.937 }]);
  });

  const board = (outline1: string, outline2: string) => parseBVR3([
    'BVRAW_FORMAT_3', '',
    'PART_NAME C1', '\tPART_SIDE T', '\tPART_ORIGIN 0 0', '\tPART_MOUNT SMD', '',
    '\tPIN_ID C1-1', '\t\tPIN_NUMBER 1', '\t\tPIN_NAME 1', '\t\tPIN_SIDE T', '\t\tPIN_ORIGIN 100 100', '\t\tPIN_NET A',
    `\t\tPIN_OUTLINE_RELATIVE ${outline1}`, '\tPIN_END', '',
    '\tPIN_ID C1-2', '\t\tPIN_NUMBER 2', '\t\tPIN_NAME 2', '\t\tPIN_SIDE T', '\t\tPIN_ORIGIN 100 120', '\t\tPIN_NET B',
    `\t\tPIN_OUTLINE_RELATIVE ${outline2}`, '\tPIN_END', '',
    'PART_END', '',
  ].join('\n'));

  it('turns a pad around its pin into pin pad fields and a Pad', () => {
    const b = board('-5 -4 5 -4 5 4 -5 4', '-5 -4 5 -4 5 4 -5 4');
    const pin = b.parts[0].pins[0];
    expect(pin).toMatchObject({ padShape: 'rect', padWidth: 10, padHeight: 8, radius: 4 });
    expect(pin.padBounds).toEqual({ minX: 95, minY: 96, maxX: 105, maxY: 104 });
    expect(b.pads).toHaveLength(2);
    expect(b.pads![0]).toMatchObject({ net: 'A', attached: true, shape: 'rect' });
  });

  it('ignores outlines that put every pin on a pad edge (820-02016)', () => {
    const b = board('5.5 -5.5 -5.5 -5.5 -5.5 0 5.5 0', '5.5 0 -5.5 0 -5.5 5.5 5.5 5.5');
    expect(b.pads).toBeUndefined();
    expect(b.parts[0].pins[0].padBounds).toBeUndefined();
  });
});
