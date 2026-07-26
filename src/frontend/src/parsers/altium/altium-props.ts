/**
 * Altium property-bag text decoder.
 *
 * Records in text-format streams (Board6, Components6, Nets6, Polygons6,
 * Rules6, Classes6) are stored as ASCII pipe-separated KEY=VALUE pairs,
 * each record prefixed by a uint32 little-endian byte count.
 *
 * Example: |RECORD=Component|NAME=R1|LAYER=TOP|
 *
 * KiCad reference: ALTIUM_BINARY_PARSER::ReadProperties() and the
 * per-record Parse*6Data methods in altium_parser_pcb.cpp.
 */

export function parsePropBagText(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const trimmed = text.replace(/^\|+/, '').replace(/\|+$/, '');
  if (trimmed.length === 0) return result;
  for (const pair of trimmed.split('|')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    result.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return result;
}

export function readPropBool(m: Map<string, string>, key: string, fallback: boolean): boolean {
  const v = m.get(key);
  if (v === undefined) return fallback;
  return v.toUpperCase() === 'TRUE';
}

export function readPropInt(m: Map<string, string>, key: string, fallback: number): number {
  const v = m.get(key);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function readPropFloat(m: Map<string, string>, key: string, fallback: number): number {
  const v = m.get(key);
  if (v === undefined) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

export function readPropString(m: Map<string, string>, key: string, fallback = ''): string {
  return m.get(key) ?? fallback;
}

export function* iterateRecords(buf: Uint8Array): Generator<Map<string, string>> {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const decoder = new TextDecoder('utf-8');
  let p = 0;
  while (p + 4 <= buf.length) {
    const len = dv.getUint32(p, true);
    p += 4;
    if (len === 0 || p + len > buf.length) break;
    const text = decoder.decode(buf.subarray(p, p + len));
    yield parsePropBagText(text);
    p += len;
  }
}
