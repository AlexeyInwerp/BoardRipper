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
