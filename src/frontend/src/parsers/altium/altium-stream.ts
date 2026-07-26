/**
 * Altium binary stream cursor.
 *
 * All reads are little-endian. Mirrors the surface of KiCad's
 * ALTIUM_BINARY_PARSER (common/io/altium/altium_binary_parser.h) — minus
 * the unit-conversion helpers, which live in altium-units.ts here.
 */

const TEXT_DECODER = new TextDecoder('utf-8', { fatal: false });

export class AltiumStream {
  pos = 0;
  private readonly buf: Uint8Array;
  private readonly dv: DataView;

  constructor(buf: Uint8Array) {
    this.buf = buf;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  eof(): boolean {
    return this.pos >= this.buf.byteLength;
  }

  remaining(): number {
    return this.buf.byteLength - this.pos;
  }

  skip(n: number): void {
    this.pos += n;
  }

  peekUint8(): number {
    return this.dv.getUint8(this.pos);
  }

  readUint8(): number {
    const v = this.dv.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  readUint16(): number {
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readInt16(): number {
    const v = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  readUint32(): number {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readInt32(): number {
    const v = this.dv.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat32(): number {
    const v = this.dv.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  readFloat64(): number {
    const v = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  readShortPascalString(): string {
    const len = this.readUint8();
    const s = TEXT_DECODER.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  readFullPascalString(): string {
    const len = this.readUint32();
    const s = TEXT_DECODER.decode(this.buf.subarray(this.pos, this.pos + len));
    this.pos += len;
    return s;
  }

  slice(n: number): Uint8Array {
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  readLengthPrefixedBytes(): Uint8Array {
    const len = this.readUint32();
    return this.slice(len);
  }
}
