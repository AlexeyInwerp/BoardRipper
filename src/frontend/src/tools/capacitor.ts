import { trimNum } from './format';

export interface CapResult {
  pF: number;
  nF: number;
  uF: number;
  tolerancePct?: number;
  formatted: string;
  error?: string;
}

// EIA capacitor tolerance letters → percent.
const TOL: Record<string, number> = {
  B: 0.1, C: 0.25, D: 0.5, F: 1, G: 2, J: 5, K: 10, M: 20,
};
// p/n/u/µ unit → pF multiplier.
const UNIT_PF: Record<string, number> = { P: 1, N: 1000, U: 1e6 };

function build(pF: number, tolerancePct?: number): CapResult {
  return {
    pF,
    nF: pF / 1e3,
    uF: pF / 1e6,
    tolerancePct,
    formatted: formatCapacitance(pF),
  };
}
function err(message: string): CapResult {
  return { pF: 0, nF: 0, uF: 0, formatted: '', error: message };
}

/** Pick the friendliest unit: ≥1µF → µF, ≥1nF → nF, else pF. */
export function formatCapacitance(pF: number): string {
  if (pF >= 1e6) return `${trimNum(pF / 1e6)} µF`;
  if (pF >= 1e3) return `${trimNum(pF / 1e3)} nF`;
  return `${trimNum(pF)} pF`;
}

/** Decode a capacitor marking into pF plus nF/µF breakdown. Supports
 *  3-digit codes, p/n/u decimal-point notation, and bare pF values, with an
 *  optional trailing tolerance letter. */
export function decodeCapacitor(raw: string): CapResult {
  let code = raw.trim().toUpperCase().replace('µ', 'U');
  if (!code) return err('empty code');

  // Strip a trailing tolerance letter that is NOT a unit letter.
  let tolerancePct: number | undefined;
  const last = code[code.length - 1];
  if (TOL[last] !== undefined && UNIT_PF[last] === undefined) {
    tolerancePct = TOL[last];
    code = code.slice(0, -1);
  }
  if (!code) return err(`no value in: ${raw}`);

  // p/n/u notation: the unit letter marks the decimal point.
  const un = /^(\d*)([PNU])(\d*)$/.exec(code);
  if (un) {
    const whole = un[1] || '0';
    const frac = un[3] || '';
    const value = parseFloat(`${whole}.${frac || '0'}`);
    return build(value * UNIT_PF[un[2]], tolerancePct);
  }

  // 3+ digit code: last digit is the power-of-ten multiplier, value in pF.
  if (/^\d{3,}$/.test(code)) {
    const sig = parseInt(code.slice(0, -1), 10);
    const exp = parseInt(code.slice(-1), 10);
    return build(sig * 10 ** exp, tolerancePct);
  }

  // 1-2 bare digits: literal pF.
  if (/^\d{1,2}$/.test(code)) {
    return build(parseInt(code, 10), tolerancePct);
  }

  return err(`unrecognized code: ${raw}`);
}
