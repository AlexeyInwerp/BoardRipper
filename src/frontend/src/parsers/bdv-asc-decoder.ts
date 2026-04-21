/**
 * Honhan / Tebo-ICT "BDV ASC" line-key decoder.
 *
 * Ported from OpenBoardView's `decode_bdv` in BDVFile.cpp:
 *
 *   int count = 0xa0;
 *   for each byte:
 *     if b == '\r' && next == '\n': count++;
 *     if b not in (CR, LF, NUL): b = count - b;
 *     if count > 285: count = 159;
 *
 * The obfuscated signature `dd:1.3?,r?-=bb` at offset 0 decodes to
 * `<<format.asc>>` under the initial count = 0xA0.
 */
export function decodeBDVAsc(bytes: Uint8Array): string {
  const out = new Uint8Array(bytes.length);
  let count = 0xa0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0x0d && bytes[i + 1] === 0x0a) count++;
    const b = bytes[i];
    if (b === 0x0d || b === 0x0a || b === 0) {
      out[i] = b;
    } else {
      out[i] = (count - b) & 0xff;
    }
    if (count > 285) count = 159;
  }
  return new TextDecoder('ascii').decode(out);
}
