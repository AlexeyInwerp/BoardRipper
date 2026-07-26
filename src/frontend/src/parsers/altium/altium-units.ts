/**
 * Altium PCB coordinate unit conversion.
 *
 * Altium stores positions as int32 in 1/10000 mil. Y axis is up (origin
 * bottom-left). BoardRipper uses plain mils with Y down (origin top-left).
 *
 * This module is the ONLY place coordinate flipping or unit scaling
 * happens — every other module in parsers/altium/ should consume mils.
 */

export const ALTIUM_UNITS_PER_MIL = 10_000;

export function altiumToMils(value: number): number {
  return value / ALTIUM_UNITS_PER_MIL;
}

export function altiumYToMils(value: number): number {
  // Trailing `|| 0` collapses -0 → 0 so downstream Object.is equality checks behave.
  return (-value / ALTIUM_UNITS_PER_MIL) || 0;
}

export function altiumAngleToDegrees(deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  return a;
}
