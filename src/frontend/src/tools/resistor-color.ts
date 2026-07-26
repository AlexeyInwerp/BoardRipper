import { formatOhms } from './format';

export type BandColor =
  | 'black' | 'brown' | 'red' | 'orange' | 'yellow'
  | 'green' | 'blue' | 'violet' | 'grey' | 'white'
  | 'gold' | 'silver' | 'none';

export interface ResistorColorResult {
  ohms: number;
  tolerancePct: number;
  min: number;
  max: number;
  tempCoPpm?: number;
  formatted: string;
  error?: string;
}

const DIGIT: Partial<Record<BandColor, number>> = {
  black: 0, brown: 1, red: 2, orange: 3, yellow: 4,
  green: 5, blue: 6, violet: 7, grey: 8, white: 9,
};
const MULTIPLIER: Partial<Record<BandColor, number>> = {
  black: 1, brown: 10, red: 100, orange: 1e3, yellow: 1e4,
  green: 1e5, blue: 1e6, violet: 1e7, grey: 1e8, white: 1e9,
  gold: 0.1, silver: 0.01,
};
const TOLERANCE: Partial<Record<BandColor, number>> = {
  brown: 1, red: 2, green: 0.5, blue: 0.25, violet: 0.1,
  grey: 0.05, gold: 5, silver: 10, none: 20,
};
const TEMPCO: Partial<Record<BandColor, number>> = {
  brown: 100, red: 50, orange: 15, yellow: 25, blue: 10, violet: 5,
};

function err(message: string): ResistorColorResult {
  return { ohms: 0, tolerancePct: 0, min: 0, max: 0, formatted: '', error: message };
}

/** Decode a 4-, 5-, or 6-band resistor. Band order is
 *  [digits…, multiplier, tolerance, (temp-co)]. Digit count is 2 for a
 *  4-band part, 3 for 5/6-band. */
export function decodeResistorColor(bands: BandColor[]): ResistorColorResult {
  const n = bands.length;
  if (n !== 4 && n !== 5 && n !== 6) return err(`unsupported band count: ${n}`);
  const digitCount = n === 4 ? 2 : 3;

  let digits = 0;
  for (let i = 0; i < digitCount; i++) {
    const d = DIGIT[bands[i]];
    if (d === undefined) return err(`band ${i + 1} is not a digit color`);
    digits = digits * 10 + d;
  }
  const mult = MULTIPLIER[bands[digitCount]];
  if (mult === undefined) return err('multiplier band is invalid');
  const tol = TOLERANCE[bands[digitCount + 1]];
  if (tol === undefined) return err('tolerance band is invalid');

  const ohms = digits * mult;
  const spread = ohms * (tol / 100);
  const result: ResistorColorResult = {
    ohms,
    tolerancePct: tol,
    min: ohms - spread,
    max: ohms + spread,
    formatted: formatOhms(ohms),
  };
  if (n === 6) {
    const tc = TEMPCO[bands[5]];
    if (tc === undefined) return err('temp-co band is invalid');
    result.tempCoPpm = tc;
  }
  return result;
}
