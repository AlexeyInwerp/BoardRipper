import { formatOhms } from './format';

export interface SmdResult {
  ohms: number;
  formatted: string;
  error?: string;
}

// EIA-96 three-significant-figure lookup (code 01–96 → value).
const EIA96: number[] = [
  100, 102, 105, 107, 110, 113, 115, 118, 121, 124,
  127, 130, 133, 137, 140, 143, 147, 150, 154, 158,
  162, 165, 169, 174, 178, 182, 187, 191, 196, 200,
  205, 210, 215, 221, 226, 232, 237, 243, 249, 255,
  261, 267, 274, 280, 287, 294, 301, 309, 316, 324,
  332, 340, 348, 357, 365, 374, 383, 392, 402, 412,
  422, 432, 442, 453, 464, 475, 487, 499, 511, 523,
  536, 549, 562, 576, 590, 604, 619, 634, 649, 665,
  681, 698, 715, 732, 750, 768, 787, 806, 825, 845,
  866, 887, 909, 931, 953, 976,
];
// EIA-96 multiplier-letter table.
const EIA96_MULT: Record<string, number> = {
  Z: 0.001, Y: 0.01, R: 0.01, X: 0.1, S: 0.1,
  A: 1, B: 10, H: 10, C: 100, D: 1000, E: 10000, F: 100000,
};

function ok(ohms: number): SmdResult {
  return { ohms, formatted: formatOhms(ohms) };
}
function err(message: string): SmdResult {
  return { ohms: 0, formatted: '', error: message };
}

/** Decode an SMD resistor code: 3-digit, 4-digit, R-notation, or EIA-96. */
export function decodeSmdResistor(raw: string): SmdResult {
  const code = raw.trim().toUpperCase();
  if (!code) return err('empty code');

  // R-notation: R marks the decimal point (4R7 = 4.7, R47 = 0.47).
  if (code.includes('R')) {
    const n = parseFloat(code.replace('R', '.'));
    if (Number.isNaN(n)) return err(`invalid R-notation: ${raw}`);
    return ok(n);
  }

  // EIA-96: two digits + one multiplier letter.
  const eia = /^(\d{2})([A-Z])$/.exec(code);
  if (eia) {
    const idx = parseInt(eia[1], 10) - 1;
    const mult = EIA96_MULT[eia[2]];
    if (idx < 0 || idx >= EIA96.length || mult === undefined) {
      return err(`invalid EIA-96 code: ${raw}`);
    }
    return ok(EIA96[idx] * mult);
  }

  // Pure-digit 3- or 4-digit code: last digit is the power-of-ten multiplier.
  if (/^\d{3,4}$/.test(code)) {
    const sig = parseInt(code.slice(0, -1), 10);
    const exp = parseInt(code.slice(-1), 10);
    return ok(sig * 10 ** exp);
  }

  return err(`unrecognized code: ${raw}`);
}
