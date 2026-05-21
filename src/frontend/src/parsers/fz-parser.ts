/**
 * FZ (ASUS Boardview) Parser
 *
 * The .fz format is an RC6-encrypted, zlib-compressed boardview format used by
 * ASUS motherboards. After decryption and decompression, the content is
 * `!`-delimited text with named blocks (REFDES, NET_NAME, TESTVIA, etc.).
 *
 * Processing pipeline:
 *   raw bytes → RC6 decrypt (if encrypted) → split content/description
 *   → zlib inflate both → parse `!`-delimited text → BoardData
 *
 * The RC6 key (44 × uint32) is NOT bundled with BoardRipper. The caller must
 * supply one. Unencrypted .fz files (raw zlib) can be parsed without a key.
 * If `parseFZ` detects encryption and the key is missing or invalid, it
 * throws `FZKeyError` — the UI layer catches this and prompts the user to
 * fetch or paste a key. See `store/fz-key-store.ts`.
 *
 * Reference: OpenBoardView FZFile.cpp (parsing logic; OBV itself ships no key).
 */

import { inflate, inflateRaw } from 'pako';
import type { BoardData, Part, Pin, Nail, Point } from './types';
import { computeBBox, buildNets, computePartGeometry, generateSyntheticOutline } from './types';

const decoder = new TextDecoder('utf-8');

// ---------------------------------------------------------------------------
// RC6 stream cipher (modified — byte-at-a-time, not standard block mode)
// ---------------------------------------------------------------------------

/** Left-rotate a 32-bit unsigned integer */
function rotl32(val: number, shift: number): number {
  shift &= 31;
  return ((val << shift) | (val >>> (32 - shift))) >>> 0;
}

/** Convert 4 bytes (little-endian) from a Uint8Array to a uint32 */
function readU32LE(buf: Uint8Array, off: number): number {
  return ((buf[off]) | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/** Parity check bits for FZ keys (one per key word) */
const FZ_PARITY = [
  0, 1, 1, 0,  1, 0, 1, 0,  0, 0, 1, 0,  0, 1, 1, 0,
  1, 1, 0, 1,  0, 0, 0, 1,  1, 1, 0, 0,  0, 1, 0, 0,
  0, 1, 0, 0,  0, 1, 0, 0,  1, 1, 0, 1,
];

const RC6_ROUNDS = 20;

/**
 * Thrown when the parser cannot decrypt an encrypted FZ file — either because
 * no key is configured (`reason: 'missing'`) or the configured key produced
 * non-zlib output (`reason: 'invalid'`). Caught at the UI boundary
 * (board-store) which opens the FZ-key dialog so the user can fetch/paste.
 */
export class FZKeyError extends Error {
  reason: 'missing' | 'invalid';
  constructor(reason: 'missing' | 'invalid') {
    super(reason === 'missing'
      ? 'FZ file is encrypted and no decryption key is configured.'
      : 'FZ decryption failed — the configured key does not decode this file.');
    this.name = 'FZKeyError';
    this.reason = reason;
  }
}

/** Compute single-bit parity of a 32-bit value (1 if odd number of bits set) */
function parity32(v: number): number {
  v = (v ^ (v >>> 16)) >>> 0;
  v = (v ^ (v >>> 8)) & 0xFF;
  v = (v ^ (v >>> 4)) & 0xF;
  return (0x6996 >>> v) & 1;
}

/** Validate an FZ key against the hardcoded parity bits. */
export function validateFZKey(key: Uint32Array): boolean {
  if (key.length !== 44) return false;
  for (let i = 0; i < 44; i++) {
    // OBV inverts the parity bit: expected = ~parity(word) & 1
    const expected = parity32(key[i]) ^ 1;
    if (expected !== FZ_PARITY[i]) return false;
  }
  return true;
}

/**
 * RC6 stream decryption (modified — operates byte-at-a-time).
 * Decrypts the buffer in-place.
 */
function rc6Decrypt(data: Uint8Array, key: Uint32Array): void {
  const r = RC6_ROUNDS;
  const ibuf = new Uint8Array(16); // 4 × uint32 feedback register
  let A = 0, B = 0, C = 0, D = 0;

  for (let pos = 0; pos < data.length; pos++) {
    // Step 1: mix in first two key words
    B = (B + key[0]) >>> 0;
    D = (D + key[1]) >>> 0;

    // Step 2: r rounds
    for (let i = 1; i <= r; i++) {
      const t = rotl32(Math.imul(B, (2 * B + 1) >>> 0) >>> 0, 5);
      const u = rotl32(Math.imul(D, (2 * D + 1) >>> 0) >>> 0, 5);
      A = (rotl32(A ^ t, u) + key[2 * i]) >>> 0;
      C = (rotl32(C ^ u, t) + key[2 * i + 1]) >>> 0;
      // Rotate registers: (A,B,C,D) = (B,C,D,A)
      const tmpA = A;
      A = B; B = C; C = D; D = tmpA;
    }

    // Step 3: final key addition
    A = (A + key[2 * r + 2]) >>> 0;
    C = (C + key[2 * r + 3]) >>> 0;

    // Step 4: XOR decrypt one byte
    const encrypted = data[pos];
    data[pos] = (encrypted ^ (A & 0xFF)) & 0xFF;

    // Step 5: shift feedback buffer, push original encrypted byte
    for (let j = 0; j < 15; j++) ibuf[j] = ibuf[j + 1];
    ibuf[15] = encrypted;

    // Step 6: reconstruct A,B,C,D from feedback buffer
    A = readU32LE(ibuf, 0);
    B = readU32LE(ibuf, 4);
    C = readU32LE(ibuf, 8);
    D = readU32LE(ibuf, 12);
  }
}

// ---------------------------------------------------------------------------
// Content parsing (! delimited text)
// ---------------------------------------------------------------------------

/** FZ coordinate unit multiplier (default: mils — 1.0, millimeters: 25.4) */
function parseUnitMultiplier(content: string): number {
  const match = content.match(/UNIT:(\S+)/i);
  if (match && match[1].toLowerCase() === 'millimeters') return 25.4;
  return 1.0;
}

interface FZPin {
  net: string;
  refdes: string;
  pinNumber: string;
  pinName: string;
  x: number;
  y: number;
  testPoint: number;
  radius: number;
}

interface FZNail {
  net: string;
  x: number;
  y: number;
  side: 'top' | 'bottom';
}

interface FZPart {
  name: string;
  side: 'top' | 'bottom';
}

/**
 * Parse the `!`-delimited content text into parts, pins, and nails.
 *
 * Block structure:
 *   Lines starting with A define block headers.
 *   Lines starting with S contain data records.
 */
function parseContent(text: string, unitMul: number): { parts: FZPart[]; pins: FZPin[]; nails: FZNail[] } {
  // Replace comma decimal separators with dots (some regional variants)
  text = text.replace(/,/g, '.');

  const parts: FZPart[] = [];
  const pins: FZPin[] = [];
  const nails: FZNail[] = [];

  type Block = 'REFDES' | 'NET_NAME' | 'TESTVIA' | 'OTHER';
  let currentBlock: Block = 'OTHER';

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    const fields = line.split('!');
    if (fields.length < 2) continue;

    const tag = fields[0];

    if (tag === 'A') {
      // Block header — identify by first field name
      const blockName = fields[1] ?? '';
      if (blockName === 'REFDES') currentBlock = 'REFDES';
      else if (blockName === 'NET_NAME') currentBlock = 'NET_NAME';
      else if (blockName === 'TESTVIA') currentBlock = 'TESTVIA';
      else currentBlock = 'OTHER';
      continue;
    }

    if (tag !== 'S') continue;

    // Data record
    if (currentBlock === 'REFDES') {
      // S!<name>!<cic>!<sname>!<mirror>!<rotate>!
      const name   = fields[1] ?? '';
      const mirror = fields[4] ?? '';
      if (name) {
        parts.push({
          name,
          side: mirror.toUpperCase() === 'YES' ? 'top' : 'bottom',
        });
      }
    } else if (currentBlock === 'NET_NAME') {
      // S!<net>!<refdes>!<pin_number>!<pin_name>!<x>!<y>!<test_point>!<radius>!
      const net        = fields[1] ?? '';
      const refdes     = fields[2] ?? '';
      const pinNumber  = fields[3] ?? '';
      const pinName    = fields[4] ?? '';
      const x          = parseFloat(fields[5] ?? '') * unitMul;
      const y          = parseFloat(fields[6] ?? '') * unitMul;
      const testPoint  = parseInt(fields[7] ?? '0', 10) || 0;
      let radius       = parseFloat(fields[8] ?? '0');

      // OBV: radius /= 100, min 0.5, then * unitMul
      radius = radius / 100;
      if (radius < 0.5) radius = 0.5;
      radius *= unitMul;

      if (!isNaN(x) && !isNaN(y)) {
        pins.push({ net, refdes, pinNumber, pinName, x, y, testPoint, radius });
      }
    } else if (currentBlock === 'TESTVIA') {
      // S!Y!<net>!<refdes>!<pin_number>!<pin_name>!<x>!<y>!<location>!<radius>!
      // Note: extra "Y" field after S
      if (fields[1] !== 'Y') continue;
      const net      = fields[2] ?? '';
      const x        = parseFloat(fields[6] ?? '') * unitMul;
      const y        = parseFloat(fields[7] ?? '') * unitMul;
      const location = fields[8] ?? '';

      if (!isNaN(x) && !isNaN(y)) {
        nails.push({ net, x, y, side: location.toUpperCase() === 'T' ? 'top' : 'bottom' });
      }
    }
  }

  return { parts, pins, nails };
}

// ---------------------------------------------------------------------------
// Assembly: FZ parsed data → BoardData
// ---------------------------------------------------------------------------

function assembleBoardData(
  fzParts: FZPart[],
  fzPins: FZPin[],
  fzNails: FZNail[],
): BoardData {
  // Build a part name → index lookup
  const partIndexByName = new Map<string, number>();
  for (let i = 0; i < fzParts.length; i++) {
    partIndexByName.set(fzParts[i].name, i);
  }

  // Group pins by their parent part refdes
  const pinsByPart = new Map<number, FZPin[]>();
  for (const pin of fzPins) {
    const idx = partIndexByName.get(pin.refdes);
    if (idx === undefined) continue;
    let list = pinsByPart.get(idx);
    if (!list) { list = []; pinsByPart.set(idx, list); }
    list.push(pin);
  }

  // Build Part[]
  const parts: Part[] = [];
  for (let i = 0; i < fzParts.length; i++) {
    const fzPart = fzParts[i];
    const fzPartPins = pinsByPart.get(i) ?? [];

    const pins: Pin[] = fzPartPins.map((fp, j) => {
      // Use pin_number if not "0", otherwise fall back to pin_name
      const displayName = (fp.pinNumber && fp.pinNumber !== '0') ? fp.pinNumber : fp.pinName;
      return {
        name:     displayName || String(j + 1),
        number:   fp.pinNumber || String(j + 1),
        position: { x: fp.x, y: fp.y },
        radius:   fp.radius,
        side:     fzPart.side,
        net:      fp.net,
      };
    });

    const { origin, bounds } = computePartGeometry(pins);

    parts.push({
      name:   fzPart.name,
      side:   fzPart.side,
      type:   'smd',
      origin,
      pins,
      bounds,
    });
  }

  // Build Nail[]
  const nails: Nail[] = fzNails.map(n => ({
    position: { x: n.x, y: n.y },
    side: n.side,
    net: n.net,
  }));

  // Generate rectangular outline from pin bounds (FZ has no explicit outline)
  const allPoints: Point[] = parts.flatMap(p => p.pins.map(pin => pin.position));
  const outline = generateSyntheticOutline(allPoints);

  const bounds = computeBBox([...outline, ...allPoints]);
  const nets = buildNets(parts);

  return { format: 'FZ', outline, parts, nails, nets, bounds };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Check if bytes 4-5 look like a zlib header (unencrypted FZ) */
function isZlibAt(data: Uint8Array, offset: number): boolean {
  if (data.length <= offset + 1) return false;
  return data[offset] === 0x78 && (data[offset + 1] === 0x9C || data[offset + 1] === 0xDA || data[offset + 1] === 0x01);
}

/**
 * Parse an .fz boardview file.
 *
 * @param buffer  Raw file bytes
 * @param key     RC6 key (44 × uint32). Required for encrypted files. If the
 *                file is encrypted and no key is supplied, throws
 *                `FZKeyError` — the UI catches this to prompt the user.
 */
export async function parseFZ(buffer: ArrayBuffer, key?: Uint32Array): Promise<BoardData> {
  const data = new Uint8Array(buffer.slice(0)); // working copy

  // Determine if encrypted: check bytes 4-5 for zlib signature
  const needsDecrypt = !isZlibAt(data, 4);

  if (needsDecrypt) {
    if (!key) {
      throw new FZKeyError('missing');
    }
    if (key.length !== 44) {
      throw new Error('FZ key must be exactly 44 uint32 values.');
    }
    rc6Decrypt(data, key);

    // Verify decryption produced valid zlib at offset 4
    if (!isZlibAt(data, 4)) {
      throw new FZKeyError('invalid');
    }
  }

  // Split content and description sections.
  // Last 4 bytes = little-endian uint32 = description section size.
  if (data.length < 8) throw new Error('FZ file too small');

  const descrSize = readU32LE(data, data.length - 4);
  const contentStart = 4; // skip 4-byte header
  let contentEnd = data.length - descrSize;

  if (contentEnd <= contentStart || contentEnd > data.length) {
    throw new Error('FZ file structure invalid: description size points outside file bounds');
  }

  // Older ASUS/MSI/ASRock FZ files (the dominant variant in real-world samples)
  // embed an undocumented 4-byte uint32 LE forward-pointer to the description
  // section start, sitting between the deflate end-of-stream marker and
  // contentEnd. If those four bytes spell out contentEnd itself, trim them off
  // so strict zlib decoders don't reject the slice as having "junk after end of
  // compressed data". OBV's reference C++ inflate is lenient enough to ignore
  // them, but pako (and DecompressionStream) are not.
  if (contentEnd - 4 > contentStart && readU32LE(data, contentEnd - 4) === contentEnd) {
    contentEnd -= 4;
  }

  // Decompress content section. Several converter quirks need fallbacks; each
  // candidate is accepted only if it yields non-empty text, so a method that
  // silently inflates to nothing (rather than throwing) still falls through.
  const decode = (bytes: Uint8Array): string | null => {
    try { const t = decoder.decode(bytes); return t.length > 0 ? t : null; } catch { return null; }
  };
  const tryZlib = (start: number, end: number): string | null => {
    try { return decode(inflate(data.subarray(start, end))); } catch { return null; }
  };

  let contentText: string | null = tryZlib(contentStart, contentEnd);

  // Variant 1 — GOCCANH-XJ writes `descrSize` 4 bytes long, chopping the deflate
  // tail ("unexpected end of file"). Retry with contentEnd + 4 (symmetrical to
  // the forward-pointer trim above).
  if (contentText === null && contentEnd + 4 <= data.length - 4) {
    const t = tryZlib(contentStart, contentEnd + 4);
    if (t !== null) { contentText = t; contentEnd += 4; }
  }

  // Variant 2 — GOCCANH "GCVN" magic exports prefix a 0x78 0x9c zlib header but
  // store a body that zlib-mode inflate rejects ("invalid distance too far
  // back"); the raw DEFLATE stream after the 2-byte header decodes cleanly and
  // self-terminates at its final block. Canary: ASUS G513R 6050A3348801.
  if (contentText === null && data[contentStart] === 0x78) {
    try {
      const t = decode(inflateRaw(data.subarray(contentStart + 2)));
      if (t !== null) contentText = t;
    } catch { /* fall through to error below */ }
  }

  if (contentText === null) {
    throw new Error('FZ content decompression failed: no decoder produced board content');
  }

  // Parse unit multiplier
  const unitMul = parseUnitMultiplier(contentText);

  // Parse content
  const { parts: fzParts, pins: fzPins, nails: fzNails } = parseContent(contentText, unitMul);

  if (fzParts.length === 0 && fzPins.length === 0) {
    throw new Error('FZ file parsed but contains no parts or pins — file may be corrupted or empty');
  }

  // DESCR section ignored — BoardData does not support description yet

  return assembleBoardData(fzParts, fzPins, fzNails);
}
