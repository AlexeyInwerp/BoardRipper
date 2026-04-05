/**
 * AllegroStream — binary reader for Cadence Allegro BRD files.
 *
 * All Allegro data is little-endian unless otherwise noted.
 * Arc center/radius values are stored as big-endian IEEE 754 doubles
 * split across two consecutive 32-bit words — use allegroFloat() for those.
 */
export class AllegroStream {
  private view: DataView;
  private pos: number = 0;
  private readonly tmpView = new DataView(new ArrayBuffer(8));

  constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer);
  }

  /** Ensure at least `n` bytes are available from the current position. */
  ensure(n: number): void {
    if (this.pos + n > this.view.byteLength) {
      throw new Error(
        `Allegro BRD truncated: need ${n} bytes at offset 0x${this.pos.toString(16)}, ` +
        `but file is only ${this.view.byteLength} bytes`
      );
    }
  }

  // ── Position ────────────────────────────────────────────────────────────

  get position(): number {
    return this.pos;
  }

  get size(): number {
    return this.view.byteLength;
  }

  get eof(): boolean {
    return this.pos >= this.view.byteLength;
  }

  seek(offset: number): void {
    this.pos = offset;
  }

  skip(n: number): void {
    this.pos += n;
  }

  // ── Primitive reads ──────────────────────────────────────────────────────

  u8(): number {
    this.ensure(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  peekU8(): number {
    this.ensure(1);
    return this.view.getUint8(this.pos);
  }

  u16(): number {
    this.ensure(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  s16(): number {
    this.ensure(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.ensure(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  s32(): number {
    this.ensure(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /** Read a u32 and discard it (advance position only). */
  skipU32(): void {
    this.ensure(4);
    this.pos += 4;
  }

  // ── Array reads ──────────────────────────────────────────────────────────

  u32Array(count: number): number[] {
    this.ensure(count * 4);
    const arr: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = this.view.getUint32(this.pos, true);
      this.pos += 4;
    }
    return arr;
  }

  s32Array(count: number): number[] {
    this.ensure(count * 4);
    const arr: number[] = new Array(count);
    for (let i = 0; i < count; i++) {
      arr[i] = this.view.getInt32(this.pos, true);
      this.pos += 4;
    }
    return arr;
  }

  // ── Floating-point ───────────────────────────────────────────────────────

  /**
   * Reads arc center/radius: two consecutive u32 words interpreted as a
   * big-endian IEEE 754 double (Allegro stores these in a non-standard layout).
   * Word order: high word first, then low word — big-endian 64-bit float.
   */
  allegroFloat(): number {
    this.ensure(8);
    const hi = this.view.getUint32(this.pos, false);      // big-endian high word
    const lo = this.view.getUint32(this.pos + 4, false);  // big-endian low word
    this.pos += 8;

    // Reassemble as IEEE 754 double via reusable scratch buffer
    this.tmpView.setUint32(0, hi, false);
    this.tmpView.setUint32(4, lo, false);
    return this.tmpView.getFloat64(0, false);
  }

  // ── String reads ─────────────────────────────────────────────────────────

  /**
   * Read a null-terminated C string.
   * If roundToU32 is true, advance position to the next 4-byte boundary
   * after the null terminator (common in Allegro string fields).
   */
  cString(roundToU32 = false): string {
    const start = this.pos;
    while (this.pos < this.view.byteLength && this.view.getUint8(this.pos) !== 0) {
      this.pos++;
    }
    const bytes = new Uint8Array(this.view.buffer, start, this.pos - start);
    this.pos++; // consume null terminator

    if (roundToU32) {
      // Align to next 4-byte boundary from start of string field
      const consumed = this.pos - start;
      const remainder = consumed % 4;
      if (remainder !== 0) {
        this.pos += 4 - remainder;
      }
    }

    return new TextDecoder('latin1').decode(bytes);
  }

  /**
   * Read a fixed-length string field of exactly `len` bytes.
   * If roundToU32 is true, advance to the next 4-byte boundary after `len`.
   * Trims trailing null bytes.
   */
  fixedString(len: number, roundToU32 = false): string {
    const bytes = new Uint8Array(this.view.buffer, this.pos, len);
    this.pos += len;

    if (roundToU32) {
      const remainder = len % 4;
      if (remainder !== 0) {
        this.pos += 4 - remainder;
      }
    }

    // Trim trailing nulls
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder('latin1').decode(bytes.subarray(0, end));
  }

  // ── Raw bytes ────────────────────────────────────────────────────────────

  /** Read n raw bytes and return them as a Uint8Array view (no copy). */
  bytes(n: number): Uint8Array {
    this.ensure(n);
    const slice = new Uint8Array(this.view.buffer, this.pos, n);
    this.pos += n;
    return slice;
  }
}
