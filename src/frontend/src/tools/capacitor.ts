/**
 * Capacitor unit conversion — a pico/nano/micro cheatsheet.
 *
 * SMD capacitors are unmarked (no printed code like SMD resistors have), so a
 * code decoder is the wrong model for bench work. What a tech actually needs is
 * to convert a value freely between picofarads, nanofarads and microfarads.
 */

/** The three capacitance units a bench tech converts between. */
export type CapUnit = 'pF' | 'nF' | 'µF';

export const CAP_UNITS: CapUnit[] = ['pF', 'nF', 'µF'];

/** Multiplier that converts a value in the given unit into picofarads. */
export const CAP_UNIT_TO_PF: Record<CapUnit, number> = {
  pF: 1,
  nF: 1_000,
  'µF': 1_000_000,
};

/** Convert a capacitance value between pico/nano/microfarads. */
export function convertCapacitance(value: number, from: CapUnit, to: CapUnit): number {
  return (value * CAP_UNIT_TO_PF[from]) / CAP_UNIT_TO_PF[to];
}

/**
 * Format a converted value for display: up to 6 significant figures, with
 * floating-point noise and trailing zeros stripped (so 4.7 nF → µF reads
 * "0.0047", not "0.00470000000001" and not a rounded "0.005"). Empty string for
 * a non-finite input (e.g. a half-typed field).
 */
export function formatCapValue(v: number): string {
  if (!Number.isFinite(v)) return '';
  if (v === 0) return '0';
  return Number(v.toPrecision(6)).toString();
}
