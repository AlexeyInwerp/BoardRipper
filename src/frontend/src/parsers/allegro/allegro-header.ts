/**
 * Allegro BRD header parser.
 *
 * Transliterated from KiCad's HEADER_PARSER::ParseHeader() and FormatFromMagic()
 * (allegro_parser.cpp lines 153–324, GPL-3.0).
 * TypeScript implementation is original code for BoardRipper.
 */

import { AllegroStream } from './allegro-stream';
import type { FileHeader, LinkedList } from './allegro-types';
import { FmtVer, BoardUnits } from './allegro-types';

// ── Version detection ────────────────────────────────────────────────────────

/**
 * Determine the format version from the file magic number.
 * Masks the low byte (0xFFFFFF00) and matches against known version codes.
 * Throws for unrecognized formats; returns V_PRE_V16 for old unsupported formats.
 */
export function formatFromMagic(magic: number): FmtVer {
  const masked = (magic & 0xFFFFFF00) >>> 0;

  switch (masked) {
    case 0x00130000: return FmtVer.V_160;
    case 0x00130400: return FmtVer.V_162;
    case 0x00130C00: return FmtVer.V_164;
    case 0x00131000: return FmtVer.V_165;
    case 0x00131500: return FmtVer.V_166;
    case 0x00140400:
    case 0x00140500:
    case 0x00140600:
    case 0x00140700: return FmtVer.V_172;
    case 0x00140900:
    case 0x00140E00: return FmtVer.V_174;
    case 0x00141500: return FmtVer.V_175;
    case 0x00150000:
    case 0x00150200: return FmtVer.V_180;
    default: break;
  }

  // Pre-V16: different binary format, can't parse but can still read version string
  const majorVer = (magic >>> 16) & 0xFFFF;
  if (majorVer <= 0x0012) {
    return FmtVer.V_PRE_V16;
  }

  throw new Error(
    `Unknown Allegro file version magic 0x${magic.toString(16).padStart(8, '0')} (major 0x${majorVer.toString(16)})`
  );
}

// ── Linked list helper ────────────────────────────────────────────────────────

/**
 * Read a linked list descriptor (2 × u32).
 *
 * Pre-V180: reads [tail, head]  (sentinel pointer first, chain start second)
 * V180+:    reads [head, tail]  (chain start first, sentinel second)
 */
function readLL(stream: AllegroStream, ver: FmtVer): LinkedList {
  const w1 = stream.u32();
  const w2 = stream.u32();

  if (ver >= FmtVer.V_180) {
    // V18 stores head (chain start key) first, tail (sentinel key) second
    return { head: w1, tail: w2 };
  }

  // V16/V17 stores tail (sentinel pointer) first, head (chain start) second
  return { head: w2, tail: w1 };
}

// ── Header parser ─────────────────────────────────────────────────────────────

/**
 * Parse the Allegro BRD file header.
 *
 * Reads all header fields in exact KiCad field order, including version-conditional
 * fields. Position assertions verify alignment at known offsets before the version
 * string (0xF8 for pre-V180, 0x124 for V180).
 */
export function parseHeader(stream: AllegroStream): FileHeader {
  const headerStartPos = stream.position;

  // Magic + version detection
  const magic = stream.u32();
  const ver = formatFromMagic(magic);

  // V_PRE_V16 (Allegro v15.x — family 0x0012) shares the outer magic shape
  // (bytes [8..11] == 1) so it routes here, but the binary layout below differs
  // and would parse to garbage. Surface a clear, actionable error instead of
  // letting the caller see a misleading "BDV corrupt" downstream.
  if (ver === FmtVer.V_PRE_V16) {
    throw new Error(
      `Allegro v15.x BRD files are not yet supported (magic 0x${magic.toString(16).padStart(8, '0')}). ` +
      `The current parser supports Allegro v16.0–v18.0. ` +
      `Workaround: re-save the board from Cadence Allegro as v16+ and reopen.`
    );
  }

  // Fixed initial fields
  stream.u32(); // m_Unknown1a
  stream.u32(); // m_FileRole
  stream.u32(); // m_Unknown1b
  stream.u32(); // m_WriterProgram

  const objectCount = stream.u32();

  stream.u32(); // m_UnknownMagic
  stream.u32(); // m_UnknownFlags

  // Version-split block of 7 u32 fields
  // Pre-V180: 7 unknown u32s
  // V180: 7 individually named u32s
  let x27End_V18: number | undefined;
  let stringsCount_V18: number | undefined;

  if (ver >= FmtVer.V_180) {
    stream.u32(); // m_Unknown2a_V18
    stream.u32(); // m_Unknown2b_V18
    x27End_V18 = stream.u32(); // m_0x27_End_V18
    stream.u32(); // m_Unknown2d_V18
    stream.u32(); // m_Unknown2e_V18
    stringsCount_V18 = stream.u32(); // m_StringCount_V18
    stream.u32(); // m_Unknown2g_V18
  } else {
    // 7 unknown u32s
    for (let i = 0; i < 7; i++) stream.u32();
  }

  // V180: 5 additional linked lists at the start of the LL section
  let LL_V18_1: LinkedList | undefined;
  let LL_V18_2: LinkedList | undefined;
  let LL_V18_3: LinkedList | undefined;
  let LL_V18_4: LinkedList | undefined;
  let LL_V18_5: LinkedList | undefined;

  if (ver >= FmtVer.V_180) {
    LL_V18_1 = readLL(stream, ver);
    LL_V18_2 = readLL(stream, ver);
    LL_V18_3 = readLL(stream, ver);
    LL_V18_4 = readLL(stream, ver);
    LL_V18_5 = readLL(stream, ver);
  }

  // Standard linked lists (V18 positions 5–22 match V16 positions 0–17)
  const LL_0x04           = readLL(stream, ver);
  const LL_0x06           = readLL(stream, ver);
  const LL_0x0C           = readLL(stream, ver);
  const LL_Shapes         = readLL(stream, ver);
  const LL_0x14           = readLL(stream, ver);
  const LL_0x1B_Nets      = readLL(stream, ver);
  const LL_0x1C           = readLL(stream, ver);
  const LL_0x24_0x28      = readLL(stream, ver);
  const LL_Unknown1       = readLL(stream, ver);
  const LL_0x2B           = readLL(stream, ver);
  const LL_0x03_0x30      = readLL(stream, ver);
  const LL_0x0A           = readLL(stream, ver);
  const LL_0x1D_0x1E_0x1F = readLL(stream, ver);
  const LL_Unknown2       = readLL(stream, ver);
  const LL_0x38           = readLL(stream, ver);
  const LL_0x2C           = readLL(stream, ver);
  const LL_0x0C_2         = readLL(stream, ver);
  const LL_Unknown3       = readLL(stream, ver);

  // x35 extents — pre-V180 only (V180 moved these to a later position)
  let x35Start_preV18: number | undefined;
  let x35End_preV18: number | undefined;
  if (ver < FmtVer.V_180) {
    x35Start_preV18 = stream.u32();
    x35End_preV18   = stream.u32();
  }

  // LL_Unknown5: V180 uses first slot, pre-V180 uses second (read to maintain alignment)
  if (ver >= FmtVer.V_180) { readLL(stream, ver); }

  const LL_0x36    = readLL(stream, ver);

  if (ver < FmtVer.V_180) { readLL(stream, ver); }

  const LL_Unknown6 = readLL(stream, ver);
  const LL_0x0A_2   = readLL(stream, ver);

  // m_Unknown3: pre-V180 only (1 u32)
  if (ver < FmtVer.V_180) {
    stream.u32();
  }

  // V180: sixth extra linked list + x35 extents in their V18 positions
  let LL_V18_6: LinkedList | undefined;
  let x35Start_V18: number | undefined;
  let x35End_V18: number | undefined;

  if (ver >= FmtVer.V_180) {
    LL_V18_6      = readLL(stream, ver);
    x35Start_V18  = stream.u32();
    x35End_V18    = stream.u32();
  }

  // v18.0.2 tail: 4 extra LL pairs between x35End and the version string.
  // Discovered on Dell XPS LA-E331P (magic 0x00150200): the version string
  // sits at file offset 0x144 instead of 0x124. Each pair carries an
  // increasing head value (e.g. 0x7d..0x80) with tail = 0; treated as
  // opaque alignment-only data for now.
  let LL_V18_7:  LinkedList | undefined;
  let LL_V18_8:  LinkedList | undefined;
  let LL_V18_9:  LinkedList | undefined;
  let LL_V18_10: LinkedList | undefined;

  if (ver >= FmtVer.V_180) {
    LL_V18_7  = readLL(stream, ver);
    LL_V18_8  = readLL(stream, ver);
    LL_V18_9  = readLL(stream, ver);
    LL_V18_10 = readLL(stream, ver);
  }

  // Position assertion (matches KiCad's wxASSERT)
  const expectedOffset = ver < FmtVer.V_180 ? 0xF8 : 0x144;
  const actualOffset   = stream.position - headerStartPos;
  if (actualOffset !== expectedOffset) {
    throw new Error(
      `Allegro header position mismatch at Allegro version string: ` +
      `expected offset 0x${expectedOffset.toString(16)}, ` +
      `got 0x${actualOffset.toString(16)}`
    );
  }

  // Allegro version string: 60 bytes fixed
  const allegroVersion = stream.fixedString(60);

  // m_Unknown4, m_MaxKey
  stream.u32(); // unknown4
  const maxKey = stream.u32();

  // m_Unknown5: pre-V180: 17 u32s; V180: 9 u32s
  if (ver < FmtVer.V_180) {
    for (let i = 0; i < 17; i++) stream.u32();
  } else {
    for (let i = 0; i < 9; i++) stream.u32();
  }

  // Board units: 1 byte + 3 padding bytes
  const unitsByte = stream.u8();
  stream.skip(3); // padding

  let boardUnits: BoardUnits;
  switch (unitsByte) {
    case BoardUnits.MILS:         boardUnits = BoardUnits.MILS;         break;
    case BoardUnits.INCHES:       boardUnits = BoardUnits.INCHES;       break;
    case BoardUnits.MILLIMETERS:  boardUnits = BoardUnits.MILLIMETERS;  break;
    case BoardUnits.CENTIMETERS:  boardUnits = BoardUnits.CENTIMETERS;  break;
    case BoardUnits.MICROMETERS:  boardUnits = BoardUnits.MICROMETERS;  break;
    default:
      throw new Error(`Unknown Allegro board units byte: 0x${unitsByte.toString(16)}`);
  }

  stream.u32(); // m_Unknown6

  // Pre-V180: m_Unknown7 and m_0x27_End_preV18
  let x27End_preV18: number | undefined;
  if (ver < FmtVer.V_180) {
    stream.u32(); // m_Unknown7
    x27End_preV18 = stream.u32(); // m_0x27_End_preV18
  }

  stream.u32(); // m_Unknown8

  // m_StringCount: pre-V180 only (V180 was already read earlier)
  let stringsCount_preV18: number | undefined;
  if (ver < FmtVer.V_180) {
    stringsCount_preV18 = stream.u32();
  }

  // m_Unknown9: 50 u32s (fixed across all versions)
  for (let i = 0; i < 50; i++) stream.u32();

  // m_Unknown10a/b/c: 3 u32s
  stream.u32();
  stream.u32();
  stream.u32();

  // m_UnitsDivisor
  const unitsDivisor = stream.u32();

  // Skip 110 u32s of unknown data
  stream.skip(110 * 4);

  // Layer map: 25 entries of (a, layerList0x2A) u32 pairs
  const layerMap: Array<{ a: number; layerList0x2A: number }> = [];
  for (let i = 0; i < 25; i++) {
    const a            = stream.u32();
    const layerList0x2A = stream.u32();
    layerMap.push({ a, layerList0x2A });
  }

  // Resolve version-split fields
  const x27End      = (ver >= FmtVer.V_180 ? x27End_V18 : x27End_preV18) ?? 0;
  const stringsCount = (ver >= FmtVer.V_180 ? stringsCount_V18 : stringsCount_preV18) ?? 0;
  const x35Start    = (ver >= FmtVer.V_180 ? x35Start_V18 : x35Start_preV18) ?? 0;
  const x35End      = (ver >= FmtVer.V_180 ? x35End_V18 : x35End_preV18) ?? 0;

  return {
    magic,
    fmtVer: ver,
    objectCount,
    allegroVersion,
    boardUnits,
    unitsDivisor,
    maxKey,
    stringsCount,
    x27End,

    LL_0x04,
    LL_0x06,
    LL_0x0C,
    LL_Shapes,
    LL_0x14,
    LL_0x1B_Nets,
    LL_0x1C,
    LL_0x24_0x28,
    LL_Unknown1,
    LL_0x2B,
    LL_0x03_0x30,
    LL_0x0A,
    LL_0x1D_0x1E_0x1F,
    LL_Unknown2,
    LL_0x38,
    LL_0x2C,
    LL_0x0C_2,
    LL_Unknown3,
    LL_0x36,
    LL_Unknown6: LL_Unknown6,
    LL_0x0A_2,

    LL_V18_1,
    LL_V18_2,
    LL_V18_3,
    LL_V18_4,
    LL_V18_5,
    LL_V18_6,
    LL_V18_7,
    LL_V18_8,
    LL_V18_9,
    LL_V18_10,

    x35Start,
    x35End,

    layerMap,
  };
}
