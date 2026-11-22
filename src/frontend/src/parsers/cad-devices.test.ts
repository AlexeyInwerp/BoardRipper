import { describe, it, expect } from 'vitest';
import { parseDevices } from './cad-parser';

describe('GenCAD $DEVICES', () => {
  it('strips a refdes appended to the PART value (Lenovo Legion Pro 5)', () => {
    const m = parseDevices(['DEVICE CA1', 'PART 2.2U_0402_6.3V6M CA1']);
    expect(m.get('CA1')).toEqual({ part: '2.2U_0402_6.3V6M' });
  });

  it('drops DeviceNNNN placeholders (ASUS TUF-RTX3080)', () => {
    expect(parseDevices(['DEVICE Device2949', 'PART Device2949']).get('Device2949')?.part).toBeUndefined();
  });

  it('reads TOL before or after PART (NVIDIA 4090)', () => {
    const m = parseDevices(['DEVICE 1uF', 'TOL 10', 'PART 1uF', 'DEVICE 0.1uF', 'PART 4171010400G', 'TOL 10']);
    expect(m.get('1uF')).toEqual({ part: '1uF', tol: '10' });
    expect(m.get('0.1uF')).toEqual({ part: '4171010400G', tol: '10' });
  });

  it('keeps a description that merely contains the device name', () => {
    expect(parseDevices(['DEVICE R5', 'PART RES 200K OHM 1/20W (0201) 5%//TA-I/RM02JTN204']).get('R5')?.part)
      .toBe('RES 200K OHM 1/20W (0201) 5%//TA-I/RM02JTN204');
  });
});

describe('GenCAD $BOARD', () => {
  it('takes edge primitives and cutouts, never ARTWORK blocks', async () => {
    const { parseBoardOutline } = await import('./cad-parser');
    const polys = parseBoardOutline([
      'LINE 0 0 100 0', 'LINE 100 0 100 50',
      'ARTWORK artwork1 TOP', 'LINE 10 10 20 10', 'ARC 20 10 10 10 15 10',
      'ARTWORK artwork2 BOTTOM', 'LINE 30 30 40 30',
      'CUTOUT c1', 'LINE 60 20 70 20',
    ], 1);
    expect(polys).toEqual([
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      [{ x: 100, y: 0 }, { x: 100, y: 50 }],
      [{ x: 60, y: 20 }, { x: 70, y: 20 }],
    ]);
  });
});
