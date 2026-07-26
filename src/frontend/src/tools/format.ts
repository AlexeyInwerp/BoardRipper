/** Format a resistance in ohms with an engineering suffix (Ω/kΩ/MΩ/GΩ).
 *  Trailing zeros in the mantissa are trimmed: 1000 → "1 kΩ", 4700 → "4.7 kΩ". */
export function formatOhms(ohms: number): string {
  const units: [number, string][] = [
    [1e9, 'GΩ'],
    [1e6, 'MΩ'],
    [1e3, 'kΩ'],
    [1, 'Ω'],
  ];
  for (const [scale, suffix] of units) {
    if (ohms >= scale) {
      const v = ohms / scale;
      return `${trimNum(v)} ${suffix}`;
    }
  }
  return `${trimNum(ohms)} Ω`;
}

/** Round to 3 significant decimals and drop trailing zeros. */
export function trimNum(v: number): string {
  const s = v.toFixed(3);
  return s.replace(/\.?0+$/, '');
}
