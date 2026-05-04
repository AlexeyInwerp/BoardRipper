import { test, expect } from '@playwright/test';

test.describe('net classification predicates', () => {
  test('isGroundRail matches GND family only', async () => {
    const { isGroundRail } = await import('../src/parsers/types');
    expect(isGroundRail('GND')).toBe(true);
    expect(isGroundRail('AGND')).toBe(true);
    expect(isGroundRail('DGND')).toBe(true);
    expect(isGroundRail('PGND')).toBe(true);
    expect(isGroundRail('EARTH')).toBe(true);
    expect(isGroundRail('CHASSIS')).toBe(true);
    expect(isGroundRail('GND_DIG')).toBe(true);
    expect(isGroundRail('gnd')).toBe(true);

    expect(isGroundRail('VCC')).toBe(false);
    expect(isGroundRail('VDD')).toBe(false);
    expect(isGroundRail('VSS')).toBe(false);
    expect(isGroundRail('+3V3')).toBe(false);
    expect(isGroundRail('VSENSE')).toBe(false);
    expect(isGroundRail('')).toBe(false);
  });

  test('isPowerRail still matches power + ground (existing behaviour)', async () => {
    const { isPowerRail } = await import('../src/parsers/types');
    expect(isPowerRail('GND')).toBe(true);
    expect(isPowerRail('VCC')).toBe(true);
    expect(isPowerRail('+3V3')).toBe(true);
    expect(isPowerRail('-5V')).toBe(true);
    expect(isPowerRail('VSENSE')).toBe(false);
  });
});
