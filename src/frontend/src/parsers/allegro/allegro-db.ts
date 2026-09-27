/**
 * AllegroDb — Object database and string table for Cadence Allegro BRD files.
 *
 * Orchestrates the three-phase parse pipeline:
 *   1. Header (version, linked lists, units)
 *   2. String table (id → name mapping)
 *   3. Block objects (keyed binary records)
 *
 * Derived from KiCad 10's Allegro importer (GPL-3.0).
 * TypeScript implementation is original code for BoardRipper.
 */

import { AllegroStream } from './allegro-stream';
import { parseHeader } from './allegro-header';
import { parseBlock } from './allegro-blocks';
import type { FileHeader, AllegroBlock, LinkedList } from './allegro-types';
import { FmtVer } from './allegro-types';
import { log } from '../../store/log-store';

const dbg = log.parser;

/** String table start offset (fixed across all versions). */
const STRING_TABLE_OFFSET = 0x1200;

/** One pad of a v15 placed instance, as read from its BLK_0xC8 record. */
export interface V15Pin {
  /** BLK_0xC8 key — the pad's identity for net lookups. */
  c8Key: number;
  /** Pin number as printed on the footprint (inline ASCII in the [0x34] record). */
  number: string;
  /** Logical pin name from the component definition ([0x20] → [0x44]), '' when absent. */
  name: string;
  /** Pad bbox in raw file units (board-absolute), from C8 +0x38..+0x44. */
  coords: [number, number, number, number];
  /** Prefix byte 3 of the C8 record: 0x00 SMD; 0x80/0xa0 observed only on through-hole pads. */
  flags: number;
  /** Net name, '' when no route resolved one. */
  net: string;
}

export interface V15Pads {
  /** BLK_0x2D key → pads in ring order. */
  byInstance: Map<number, V15Pin[]>;
  /** How many pads each net route resolved (diagnostics for the Debug panel). */
  routeCounts: { r1: number; r5: number; r8c: number; r08: number };
}

/**
 * v15 record types the pointer index keeps. The heap image holds ~550k
 * `00 xx yy zz | key` candidates on a 26 MB board; indexing only the types
 * the pad walk dereferences keeps the map small, and a per-type test on
 * prefix byte 3 rejects most false headers: a pointer such as `0x09201000`
 * reads as `00 10 20 09` — a "[0x10] record" whose byte 3 is 0x09. The GND
 * NetAssign on Kronos (key 0x93dd58c) had exactly such a twin 2 MB before
 * the real one, and a first-match lookup lost every GND pad to it.
 *
 * Object records carry byte 3 ∈ {0, 1}; BLK_0xC8 uses the top three bits as
 * pad flags (0x00 SMD, 0x20/0x40/0x60 variants, 0x80/0xa0 through-hole).
 * The hop types carry a layer in bytes 2–3 and are not filtered.
 */
const V15_HEADER_OK: ReadonlyMap<number, (b3: number) => boolean> = new Map<number, (b3: number) => boolean>([
  ...[0x34, 0x20, 0x44, 0xb4, 0xac, 0x10, 0x6c, 0x1c, 0x18, 0x8c, 0x48]
    .map((t): [number, (b3: number) => boolean] => [t, (b3) => b3 === 0 || b3 === 1]),
  [0xc8, (b3) => (b3 & 0x1f) === 0],
  ...[0x50, 0x58, 0x54, 0x5c, 0x30, 0xc0, 0xc4]
    .map((t): [number, (b3: number) => boolean] => [t, () => true]),
]);

export class AllegroDb {
  readonly header: FileHeader;
  readonly strings: Map<number, string>;
  readonly blocks: Map<number, AllegroBlock>;

  /**
   * Non-fatal parse warning set when the interleaved (v16+) block walk breaks
   * early on a malformed/unknown block. The stream has no length prefixes, so
   * we can't resync past a bad record — every later object (parts, nets,
   * traces) is silently lost. When that happens and we end up materially short
   * of the header's object count, this holds a human-readable warning that
   * `assembleBoard` surfaces via `board.parserNotes` (a load-time toast), so an
   * incomplete board is flagged instead of returning "successfully". Undefined
   * = clean parse.
   */
  parseWarning?: string;

  /**
   * v15 only: per placed instance (BLK_0x2D key) the pads of its pad ring,
   * with inline pin numbers and resolved nets. Undefined for v16+.
   */
  v15Pads?: V15Pads;

  constructor(buffer: ArrayBuffer) {
    const stream = new AllegroStream(buffer);

    // Phase 1: Header
    this.header = parseHeader(stream);
    dbg.log(
      `Allegro ${this.header.allegroVersion.trim()} ` +
      `(ver=${Object.entries(FmtVer).find(([, v]) => v === this.header.fmtVer)?.[0] ?? this.header.fmtVer}, ` +
      `objects=${this.header.objectCount}, strings=${this.header.stringsCount})`
    );

    // Phase 2: String table
    this.strings = this.parseStringTable(stream);
    dbg.log(`String table: ${this.strings.size} entries`);

    // Phase 3: Blocks. v15 uses a per-type-contiguous layout with no inline
    // type tags; v16+ uses an interleaved single stream tagged by 1-byte block
    // type. The two require different walkers.
    this.blocks = this.header.fmtVer === FmtVer.V_15X
      ? this.parseBlocksV15(stream)
      : this.parseBlocks(stream);
    dbg.log(`Blocks: ${this.blocks.size} objects parsed`);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Look up a string by its id key. Returns '' for unknown/zero keys. */
  getString(key: number): string {
    if (key === 0) return '';
    return this.strings.get(key) ?? '';
  }

  /** Look up a block by its key. */
  getBlock(key: number): AllegroBlock | undefined {
    return this.blocks.get(key);
  }

  /** Look up a block by key, with a type-narrowing assertion. */
  getBlockAs<T extends AllegroBlock>(key: number, expectedType: number): T | undefined {
    const blk = this.blocks.get(key);
    if (!blk) return undefined;
    if (blk.blockType !== expectedType) return undefined;
    return blk as T;
  }

  /**
   * Walk a linked list starting at ll.head, following getNext() on each block.
   * Stops at ll.tail, key 0, or after 1M iterations (safety valve).
   */
  walkLinkedList(ll: LinkedList, getNext: (block: AllegroBlock) => number): AllegroBlock[] {
    const result: AllegroBlock[] = [];
    let key = ll.head;
    const MAX_ITER = 1_000_000;

    for (let i = 0; i < MAX_ITER; i++) {
      if (key === 0 || key === ll.tail) break;
      const blk = this.blocks.get(key);
      if (!blk) break;
      result.push(blk);
      key = getNext(blk);
    }

    return result;
  }

  // ── Private parsing ─────────────────────────────────────────────────────────

  /**
   * Parse the string table at offset 0x1200.
   * Each entry: [u32 id][null-terminated string][word-aligned padding].
   */
  private parseStringTable(stream: AllegroStream): Map<number, string> {
    const map = new Map<number, string>();
    stream.seek(STRING_TABLE_OFFSET);

    for (let i = 0; i < this.header.stringsCount; i++) {
      if (stream.eof) break;

      const id = stream.u32();
      const str = stream.cString(true); // word-aligned after null terminator
      map.set(id, str);
    }

    return map;
  }

  /**
   * Parse all blocks sequentially from the current stream position.
   *
   * V180: zero-padded gaps between block groups. When we encounter a run of
   * zero bytes, skip them and realign to a 4-byte boundary before checking
   * for the next valid block type byte.
   */
  private parseBlocks(stream: AllegroStream): Map<number, AllegroBlock> {
    const map = new Map<number, AllegroBlock>();
    const ver = this.header.fmtVer;
    const x27End = this.header.x27End;
    const isV180 = ver >= FmtVer.V_180;
    // Set when a bad block aborts the walk — used below to surface truncation.
    let abortedAt: string | null = null;

    while (!stream.eof) {
      // V180: skip zero-padded gaps
      if (isV180) {
        let skipped = false;
        while (!stream.eof && stream.peekU8() === 0x00) {
          stream.skip(1);
          skipped = true;
        }
        // Realign to 4-byte boundary after skipping zeros
        if (skipped) {
          const remainder = stream.position % 4;
          if (remainder !== 0) {
            stream.skip(4 - remainder);
          }
        }
      }

      if (stream.eof) break;

      // Peek at the next byte — if it's 0x00, we're at an end marker
      if (stream.peekU8() === 0x00) break;

      // Check for valid block type range (0x01–0x3C)
      const peekType = stream.peekU8();
      if (peekType > 0x3C) {
        // Not a valid block type — for V180, skip and try again
        if (isV180) {
          stream.skip(1);
          continue;
        }
        break;
      }

      try {
        const block = parseBlock(stream, ver, x27End);
        if (block === null) break; // end marker (0x00 type)
        map.set(block.key, block);
      } catch (e) {
        // Log and stop — don't crash the whole parse on a single bad block.
        // The stream has no length prefixes, so we can't resync past the bad
        // record; every later object is lost. Recorded here and reconciled
        // against the header's object count after the loop.
        abortedAt = `0x${stream.position.toString(16)}: ${e instanceof Error ? e.message : e}`;
        break;
      }
    }

    // Surface truncation: an aborted walk drops every subsequent object. If we
    // broke on a bad block AND ended up short of the header's object count,
    // flag a degraded parse (visible warning + parseWarning for the assembler)
    // rather than silently returning an incomplete board.
    if (abortedAt !== null && map.size < this.header.objectCount) {
      dbg.warn(
        `Block stream aborted at ${abortedAt} — parsed ${map.size} of ` +
        `${this.header.objectCount} objects; remaining objects were dropped.`,
      );
      this.parseWarning =
        `Incomplete parse: only ${map.size} of ${this.header.objectCount} board objects were ` +
        `read before a malformed block stopped the walk. Some parts, nets, or traces may be missing.`;
    }

    return map;
  }

  /**
   * v15 block walker. v15 lays out blocks per-type contiguously with no inline
   * type tag — each LL group sits at a single contiguous file region. Records
   * within a group share a 4-byte prefix `00 18 0X 00` (where 0X is a per-record
   * sub-type byte) followed by 8 × u32 of payload.
   *
   * Key↔offset relation: `m_Key = file_offset + globalAddend`, with
   * `globalAddend = LL_0x06.head - string_table_end_offset` (constant per file).
   * Verified on COMPAL LA-7321P (addend 0x07a82140) and v13tl-0629 (0x081e174c).
   *
   * This first cut walks LL_0x06 (component definitions) only. Other LLs
   * (LL_0x2B, LL_0x07, LL_0x2D, LL_0x32, LL_0x1C…) are deferred to follow-up
   * commits — assembleBoard will produce an empty parts list until those land.
   */
  private parseBlocksV15(stream: AllegroStream): Map<number, AllegroBlock> {
    const map = new Map<number, AllegroBlock>();
    const stringTableEndOffset = stream.position;
    const ll0x06 = this.header.LL_0x06;
    if (!ll0x06 || ll0x06.head === 0) {
      dbg.warn('v15: LL_0x06 head is null — no components to walk');
      return map;
    }

    // Compute the file-wide key→offset addend from the known head record's position.
    const globalAddend = ll0x06.head - stringTableEndOffset;
    dbg.log(`v15: key addend = 0x${globalAddend.toString(16)} (LL_0x06.head 0x${ll0x06.head.toString(16)} - strEnd 0x${stringTableEndOffset.toString(16)})`);

    // LL_0x06 (Components) — 36-byte records.
    //   prefix(4) m_Key(4) m_Next(4) m_CompDeviceType(4) m_SymbolName(4)
    //   m_FirstInstPtr(4) m_PtrFunctionSlot(4) m_PtrPinNumber(4) m_Fields(4)
    const nComponents = this.walkV15LL(stream, ll0x06, globalAddend, map, (s, offset, mKey, _prefix) => {
      const next = s.u32();
      const compDeviceType = s.u32();
      const symbolName = s.u32();
      const firstInstPtr = s.u32();
      const ptrFunctionSlot = s.u32();
      const ptrPinNumber = s.u32();
      const fields = s.u32();
      return {
        block: {
          blockType: 0x06,
          offset,
          key: mKey,
          next,
          compDeviceType,
          symbolName,
          firstInstPtr,
          ptrFunctionSlot,
          ptrPinNumber,
          fields,
          unknown1: undefined,
        } as AllegroBlock,
        next,
      };
    });
    dbg.log(`v15: walked LL_0x06 → ${nComponents} components`);

    // LL_0x2B (Footprint definitions) — 68-byte records, same global addend as
    // LL_0x06 (verified on COMPAL LA-7321P: head 0x07b1cd58 → file offset
    // 0x44C18, key − offset = 0x07AD8140). KiCad's BLK_0x2B_FOOTPRINT_DEF
    // pre-V164 layout: m_Key m_FpStrRef m_Unknown1 m_Coords[4] m_Next
    // m_FirstInstPtr 7×ptr — m_Next at field index 6 (offset +0x20 from record
    // start), not index 2 like BLK_0x06.
    const ll0x2B = this.header.LL_0x2B;
    if (ll0x2B && ll0x2B.head !== 0) {
      const nFootprints = this.walkV15LL(stream, ll0x2B, globalAddend, map, (s, offset, mKey, _prefix) => {
        const fpStrRef = s.u32();
        const unknown1 = s.u32();
        const coords: [number, number, number, number] = [
          s.u32() | 0, s.u32() | 0, s.u32() | 0, s.u32() | 0,
        ];
        const next = s.u32();
        const firstInstPtr = s.u32();
        const unknownPtr3 = s.u32();
        const unknownPtr4 = s.u32();
        const unknownPtr5 = s.u32();
        const symLibPathPtr = s.u32();
        const unknownPtr6 = s.u32();
        const unknownPtr7 = s.u32();
        const unknownPtr8 = s.u32();
        return {
          block: {
            blockType: 0x2B,
            offset,
            key: mKey,
            next,
            fpStrRef,
            unknown1,
            coords,
            firstInstPtr,
            unknownPtr3,
            unknownPtr4,
            unknownPtr5,
            symLibPathPtr,
            unknownPtr6,
            unknownPtr7,
            unknownPtr8,
            unknown2: undefined,
          } as unknown as AllegroBlock,
          next,
        };
      });
      dbg.log(`v15: walked LL_0x2B → ${nFootprints} footprints`);
    }

    // LL_0x1B_Nets (Net definitions) — 52-byte records, prefix `00 6c 00 00`,
    // pool-1 addend. m_Next at +0x08, net name string-key at +0x0C.
    const ll0x1B = this.header.LL_0x1B_Nets;
    if (ll0x1B && ll0x1B.head !== 0) {
      const nNets = this.walkV15LL(stream, ll0x1B, globalAddend, map, (s, offset, mKey, _prefix) => {
        const next = s.u32();
        const netName = s.u32();
        // Skip remaining 9 u32s (stride 52 = 4 prefix + 13 u32 = 4 + 52)
        // Actually: 4 prefix + m_Key(4) + next(4) + name(4) + 9*4 = 4+4+4+4+36 = 52 ✓
        const flags = s.u32();
        for (let i = 0; i < 8; i++) s.u32();
        return {
          block: {
            blockType: 0x1B,
            offset,
            key: mKey,
            next,
            netName,
            flags,
          } as unknown as AllegroBlock,
          next,
        };
      });
      dbg.log(`v15: walked LL_0x1B_Nets → ${nNets} nets`);
    }

    // BLK_0x07 (Component instances) — sequential 64-byte records, prefix
    // `00 1c 00 00`. Refdes is stored INLINE as a fixed 32-byte string field
    // at +0x08 (NUL-padded), not via a string-table pointer like v16+. Verified
    // against the .cad oracle: first 5 records resolve to L124, CLRP1, PQ306,
    // U11, U32 — exact match with .cad's first 5 part refdes.
    //
    // BLK_0x07 records are addressable via the same pool-1 global addend as
    // LL_0x06/0x2B/0x2D. Each BLK_0x06 component definition has a m_FirstInstPtr
    // pointing to its first BLK_0x07; we walk sequentially from there.
    //
    // v15 BLK_0x07 64-byte layout:
    //   +0x00  prefix `00 1c 00 00`
    //   +0x04  m_Key
    //   +0x08  m_RefDes (32-byte inline string, NUL-padded)
    //   +0x28  back-pointer to BLK_0x06 (component def)
    //   +0x2C..0x3C  4 more pointers (unknown role)
    let firstInst07 = Infinity;
    for (const blk of map.values()) {
      if (blk.blockType !== 0x06) continue;
      const c = blk as { firstInstPtr: number };
      if (c.firstInstPtr > 0 && c.firstInstPtr < firstInst07) {
        firstInst07 = c.firstInstPtr;
      }
    }
    if (firstInst07 !== Infinity) {
      const start07 = firstInst07 - globalAddend;
      let scan07 = start07;
      let n07 = 0;
      while (scan07 + 64 <= stream.size) {
        stream.seek(scan07);
        const p0 = stream.u8();
        const p1 = stream.u8();
        stream.skip(1);
        const p3 = stream.u8();
        if (p0 !== 0x00 || p1 !== 0x1c || p3 !== 0x00) break;
        const mKey = stream.u32();
        // Refdes inline at +0x08, max 32 bytes, NUL-terminated
        stream.seek(scan07 + 8);
        const refdesBytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) refdesBytes[i] = stream.u8();
        let endIdx = 0;
        while (endIdx < 32 && refdesBytes[endIdx] !== 0) endIdx++;
        const refdes = new TextDecoder('utf-8', { fatal: false }).decode(refdesBytes.subarray(0, endIdx));
        // Pointers
        stream.seek(scan07 + 0x28);
        const compDefBack = stream.u32();
        map.set(mKey, {
          blockType: 0x07,
          offset: scan07,
          key: mKey,
          next: 0, // v15 doesn't chain instances by m_Next
          unknownPtr1: 0,
          instRef16x: 0, // v15-specific: not used (we use the inline refdes directly)
          functionInst: 0,
          firstPadPtr: 0,
          unknown3: 0,
          layer: 0,
          refDesStrPtr: 0, // v15 inlines refdes — no string-table key. v15Refdes below carries the resolved value.
          v15Refdes: refdes,         // non-standard field consumed by extractComponentsV15
          v15CompDefBack: compDefBack,
        } as unknown as AllegroBlock);
        n07++;
        scan07 += 64;
      }
      dbg.log(`v15: scanned BLK_0x07 → ${n07} component instances at 0x${start07.toString(16)}..0x${scan07.toString(16)}`);
    }

    // BLK_0x2D (Footprint instances / placed parts) — sequential 60-byte
    // records, no LL in the header. Walker scans starting at
    // min(BLK_0x2B.firstInstPtr) − addend and stops when the prefix byte 1 is
    // no longer 0xB4.
    //
    // v15 BLK_0x2D 60-byte layout (LA-7321P; +0x18/+0x24 corrected on
    // Jasper_Kronos 2026-09-27 against its v17 re-save):
    //   +0x00  prefix `00 b4 0X 00`  (0X = layer: 0x00 top, 0x01 bottom)
    //   +0x04  m_Key
    //   +0x08  flags
    //   +0x0C  rotation in millidegrees (0x2BF20 = 180000 = 180°)
    //   +0x10  i32 m_CoordX (signed mils*divisor)
    //   +0x14  i32 m_CoordY
    //   +0x18  m_Next — the NEXT BLK_0x2D of the same footprint; the last one
    //          points at the BLK_0x2B footprint definition, whose +0x24 is the
    //          chain head. Earlier sessions read this as "m_FpDefRef", which is
    //          only true for the last instance of each footprint — every other
    //          part came out with an empty package name.
    //   +0x1C  m_InstRef → BLK_0x07 (refdes). Zero on the 141 Kronos records
    //          that are drawing symbols (FAB_NUMBER, dimensions, logos, UNK…):
    //          those have no component instance and are not parts.
    //   +0x20  → [0x50]
    //   +0x24  m_FirstPadPtr → BLK_0xC8 head of this instance's pad ring
    //          (C8.+0x10 = next pad, ring closes on this record's key)
    //   +0x28  → [0xc0]   +0x30 → [0xa0]   (graphics, unread)
    let firstInst2D = Infinity;
    for (const blk of map.values()) {
      if (blk.blockType !== 0x2B) continue;
      const fp = blk as { firstInstPtr: number };
      if (fp.firstInstPtr > 0 && fp.firstInstPtr < firstInst2D) {
        firstInst2D = fp.firstInstPtr;
      }
    }
    if (firstInst2D !== Infinity) {
      const start = firstInst2D - globalAddend;
      let scanPos = start;
      let n2D = 0;
      while (scanPos + 60 <= stream.size) {
        stream.seek(scanPos);
        const p0 = stream.u8();
        const p1 = stream.u8();
        const layerByte = stream.u8();
        const p3 = stream.u8();
        if (p0 !== 0x00 || p1 !== 0xb4 || p3 !== 0x00) break;
        const mKey = stream.u32();
        stream.skip(4); // +0x08 flags
        const rotationMillideg = stream.u32();
        const coordX = stream.s32();
        const coordY = stream.s32();
        const next18 = stream.u32();
        const compDefRef = stream.u32();
        stream.skip(4); // +0x20
        const firstPad24 = stream.u32();

        // Build a Blk0x2DFootprintInst-shaped record. v15 doesn't expose all
        // the v16+ fields; we leave those zero/empty so the assembler chain
        // walk doesn't trip on them. `next` and `unknownPtr1` (the footprint
        // definition) are resolved below once every instance is known.
        map.set(mKey, {
          blockType: 0x2D,
          offset: scanPos,
          key: mKey,
          next: next18,
          unknownByte1: 0,
          layer: layerByte, // 0=top, 1=bottom (v15 prefix byte 2)
          unknownByte2: 0,
          unknown1: undefined,
          instRef16x: compDefRef,
          unknown2: 0,
          unknown3: 0,
          unknown4: undefined,
          flags: 0,
          rotation: rotationMillideg,
          coordX,
          coordY,
          instRef: undefined,
          graphicPtr: 0,
          firstPadPtr: firstPad24,
          textPtr: 0,
          assemblyPtr: 0,
          areasPtr: 0,
          unknownPtr1: 0,
          unknownPtr2: compDefRef,
        } as AllegroBlock);
        n2D++;
        scanPos += 60;
      }
      dbg.log(`v15: scanned BLK_0x2D → ${n2D} placed instances at 0x${start.toString(16)}..0x${scanPos.toString(16)}`);

      // Resolve each instance's footprint definition by following the +0x18
      // chain to the BLK_0x2B that terminates it. The chain is what
      // `extractComponents`'s generic walk expects (fpDef.firstInstPtr →
      // inst.next → … → 0), so cut the ring at the definition: an instance
      // whose next is the 0x2B gets next = 0.
      let resolvedFp = 0;
      for (const blk of map.values()) {
        if (blk.blockType !== 0x2D) continue;
        const inst = blk as unknown as { key: number; next: number; unknownPtr1: number };
        let k = inst.next;
        const seen = new Set<number>([inst.key]);
        for (let hop = 0; hop < 100_000 && k !== 0 && !seen.has(k); hop++) {
          seen.add(k);
          const t = map.get(k);
          if (!t) break;
          if (t.blockType === 0x2B) { inst.unknownPtr1 = k; resolvedFp++; break; }
          if (t.blockType !== 0x2D) break;
          k = (t as unknown as { next: number }).next;
        }
        if (map.get(inst.next)?.blockType === 0x2B) inst.next = 0;
      }
      dbg.log(`v15: resolved footprint definition for ${resolvedFp} of ${n2D} instances via the +0x18 chain`);
    }

    // Pads, pin numbers and nets — see indexV15Pads.
    this.v15Pads = this.indexV15Pads(stream, map, globalAddend);

    return map;
  }

  /**
   * v15 pads, pin numbers and nets.
   *
   * ## Why pointers need an index, not a subtraction
   *
   * A v15 file is a heap image: `m_Key` is the record's memory address, and
   * `key − fileOffset` is only constant inside one contiguous pool. Between
   * pools the addend drifts (Kronos: 0x83557f4 for the LL pools up to
   * ~0x8396000 for shapes — some 260 KB of memory that was never written).
   * So a pointer cannot be resolved by one addend. Instead every 4-aligned
   * position that reads `00 b1 b2 b3 | key` with `key − off` inside a window
   * around the primary addend is a *candidate* record start, indexed by key.
   * ~10% of keys have several candidates (a zero-terminated field followed by
   * a pointer looks like a header), so every lookup names the type byte it
   * expects. Measured on Kronos: with a type-blind first-wins index 2377 of
   * 5277 pads lost their pin number and 150 rings ended on junk; with the
   * type-aware lookup every ring closes on its owning BLK_0x2D.
   *
   * ## The pad ring (replaces the byte1=0x40 → BLK_0x48 chain)
   *
   *   BLK_0x2D.+0x24 → BLK_0xC8 (first pad)
   *   BLK_0xC8.+0x10 → next BLK_0xC8; the last one points back at the 2D
   *   BLK_0xC8.+0x14 → owning BLK_0x2D (checked)
   *   BLK_0xC8.+0x1C → [0x34] pin-number record, inline ASCII at +0x08
   *   BLK_0xC8.+0x28 → [0x20] component-pin record (inline pin number at
   *                    +0x08, +0x2C → [0x44] with the inline pin *name*)
   *   BLK_0xC8.+0x38..+0x44 pad bbox, board-absolute
   *
   * The old BLK_0x48 chain visited pads in an order unrelated to the pin
   * numbers and the walker invented sequential numbers: on Kronos that
   * swapped pins 1↔3 of every SOT-23 and 1↔2 of every diode (435 "wrong"
   * nets against the v17 oracle that were all correct by position), and it
   * lost 3095 of 7982 pins because BGA rings pass through records the
   * prefix scan mis-keyed.
   *
   * ## Net routes, in priority order — each measured at 0 false positives on
   * the 7715 Kronos pins whose v17 re-save names a net
   *
   *   R1  [0x10] NetAssign: +0x10 → C8, +0x0C → [0x6c] net      (forward)
   *   R5  C8.+0x0C → [0x10] → +0x0C → [0x6c]                    (back-link;
   *       ALL prefix byte-3 variants — the shipped loop accepted only
   *       `00 c8 ?? 00` and so skipped every through-hole pad, which is
   *       where 450 of the 495 remaining misses were)
   *   R8c [0x8c] member record: +0x10 / +0x18 → C8; its +0x08 chain
   *       (through 0x8c/0x48/0x50/0x58/… records) ends at the [0x6c] net
   *   R08 C8.+0x08 → next member C8 → … → [0x10] NetAssign
   */
  private indexV15Pads(
    stream: AllegroStream,
    map: Map<number, AllegroBlock>,
    globalAddend: number,
  ): V15Pads {
    const bytes = new Uint8Array((stream as unknown as { view: DataView }).view.buffer);
    const u32 = (off: number) =>
      ((bytes[off]) | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
    const i32 = (off: number) => (u32(off) | 0);

    // ── candidate index ──
    const WINDOW_BELOW = 0x100000;  // 1 MB
    const WINDOW_ABOVE = 0x800000;  // 8 MB
    const index = new Map<number, number | number[]>();
    let candidates = 0;
    const ofType = new Map<number, number[]>(); // type byte → record offsets (accepted headers)
    for (let off = 0; off + 8 <= bytes.length; off += 4) {
      if (bytes[off] !== 0) continue;
      const b1 = bytes[off + 1];
      const ok = V15_HEADER_OK.get(b1);
      if (!ok || !ok(bytes[off + 3])) continue;
      const key = u32(off + 4);
      const add = key - off;
      if (add < globalAddend - WINDOW_BELOW || add > globalAddend + WINDOW_ABOVE) continue;
      candidates++;
      const cur = index.get(key);
      if (cur === undefined) index.set(key, off);
      else if (typeof cur === 'number') index.set(key, [cur, off]);
      else cur.push(off);
      let arr = ofType.get(b1);
      if (!arr) { arr = []; ofType.set(b1, arr); }
      arr.push(off);
    }
    /** File offset of the record with this key and type byte, or -1. */
    const rec = (key: number, b1: number): number => {
      if (key === 0) return -1;
      const cur = index.get(key);
      if (cur === undefined) return -1;
      if (typeof cur === 'number') return bytes[cur + 1] === b1 ? cur : -1;
      for (const o of cur) if (bytes[o + 1] === b1) return o;
      return -1;
    };
    /** Offset of a candidate at this key whose type byte is in the set, or -1. */
    const recAny = (key: number, types: Set<number>): number => {
      if (key === 0) return -1;
      const cur = index.get(key);
      if (cur === undefined) return -1;
      if (typeof cur === 'number') return types.has(bytes[cur + 1]) ? cur : -1;
      for (const o of cur) if (types.has(bytes[o + 1])) return o;
      return -1;
    };
    const inlineAscii = (off: number, max: number): string => {
      let s = '';
      for (let i = 0; i < max; i++) {
        const c = bytes[off + i];
        if (c === 0) break;
        if (c < 0x20 || c > 0x7e) return '';
        s += String.fromCharCode(c);
      }
      return s;
    };
    dbg.log(`v15: pointer index — ${candidates} candidates, ${index.size} keys`);

    // ── net names: [0x6c] key → name ──
    const netNameOf = (k6c: number): string => {
      const o = rec(k6c, 0x6c);
      if (o < 0) return '';
      const raw = this.strings.get(u32(o + 0x0c)) ?? '';
      // Strip the Cadence hierarchical-sheet prefix `/` (v13tl-0629 prefixes
      // every net with the root sheet path; flat designs don't).
      return raw.startsWith('/') ? raw.slice(1) : raw;
    };
    const netOf10 = (k10: number): string => {
      const o = rec(k10, 0x10);
      if (o < 0) return '';
      return netNameOf(u32(o + 0x0c)) || netNameOf(u32(o + 0x08));
    };

    // ── walk every instance's pad ring ──
    const byInstance = new Map<number, V15Pin[]>();
    const allPads: Array<{ pin: V15Pin; off: number }> = [];
    let rings = 0, closed = 0, noNumber = 0, ownerMismatch = 0;
    for (const blk of map.values()) {
      if (blk.blockType !== 0x2D) continue;
      const inst = blk as unknown as { key: number; firstPadPtr: number };
      const pins: V15Pin[] = [];
      byInstance.set(inst.key, pins);
      let k = inst.firstPadPtr;
      if (k === 0) continue;
      rings++;
      const seen = new Set<number>();
      while (k !== 0 && !seen.has(k) && pins.length < 10_000) {
        seen.add(k);
        if (k === inst.key) { closed++; break; }
        const o = rec(k, 0xc8);
        if (o < 0) break;
        if (u32(o + 0x14) !== inst.key) { ownerMismatch++; break; }
        const o34 = rec(u32(o + 0x1c), 0x34);
        const o20 = rec(u32(o + 0x28), 0x20);
        let number = o34 >= 0 ? inlineAscii(o34 + 8, 32) : '';
        if (!number && o20 >= 0) number = inlineAscii(o20 + 8, 32);
        if (!number) noNumber++;
        const o44 = o20 >= 0 ? rec(u32(o20 + 0x2c), 0x44) : -1;
        const name = o44 >= 0 ? inlineAscii(o44 + 8, 32) : '';
        const pin: V15Pin = {
          c8Key: k,
          number,
          name,
          coords: [i32(o + 0x38), i32(o + 0x3c), i32(o + 0x40), i32(o + 0x44)],
          flags: bytes[o + 3],
          net: '',
        };
        pins.push(pin);
        allPads.push({ pin, off: o });
        k = u32(o + 0x10);
      }
    }
    dbg.log(`v15: pad rings — ${rings} walked, ${closed} closed on their instance, ${allPads.length} pads, ${noNumber} without pin number, ${ownerMismatch} owner mismatches`);

    // ── nets ──
    const netByC8 = new Map<number, string>();
    const counts = { r1: 0, r5: 0, r8c: 0, r08: 0 };

    // R1: forward NetAssign links.
    for (const off of ofType.get(0x10) ?? []) {
      const c8 = u32(off + 0x10);
      if (rec(c8, 0xc8) < 0 || netByC8.has(c8)) continue;
      const n = netNameOf(u32(off + 0x0c));
      if (n) { netByC8.set(c8, n); counts.r1++; }
    }
    // R5: back-link from every pad of every ring, all byte-3 variants.
    for (const { pin, off } of allPads) {
      if (netByC8.has(pin.c8Key)) continue;
      const n = netOf10(u32(off + 0x0c));
      if (n) { netByC8.set(pin.c8Key, n); counts.r5++; }
    }
    // R8c: [0x8c] member records → chase +0x08 to the [0x6c] net.
    const CHASE_HOPS = new Set<number>([0x48, 0x50, 0x8c, 0x58, 0x54, 0x5c, 0x30, 0xc0, 0xc4]);
    const chaseToNet = (startOff: number): string => {
      let k = u32(startOff + 8);
      const seen = new Set<number>();
      for (let i = 0; i < 200 && k !== 0 && !seen.has(k); i++) {
        seen.add(k);
        if (rec(k, 0x6c) >= 0) return netNameOf(k);
        const o = recAny(k, CHASE_HOPS);
        if (o < 0) return '';
        k = u32(o + 8);
      }
      return '';
    };
    for (const off of ofType.get(0x8c) ?? []) {
      for (const fo of [0x10, 0x18]) {
        const c8 = u32(off + fo);
        if (rec(c8, 0xc8) < 0 || netByC8.has(c8)) continue;
        const n = chaseToNet(off);
        if (n) { netByC8.set(c8, n); counts.r8c++; }
      }
    }
    // R08: member chain of C8s terminating at a [0x10].
    for (const { pin, off } of allPads) {
      if (netByC8.has(pin.c8Key)) continue;
      let k = u32(off + 8);
      const seen = new Set<number>([pin.c8Key]);
      let n = '';
      for (let i = 0; i < 5000 && k !== 0 && !seen.has(k); i++) {
        seen.add(k);
        const oc = rec(k, 0xc8);
        if (oc >= 0) { k = u32(oc + 8); continue; }
        n = netOf10(k);
        break;
      }
      if (n) { netByC8.set(pin.c8Key, n); counts.r08++; }
    }
    let netted = 0;
    for (const { pin } of allPads) {
      pin.net = netByC8.get(pin.c8Key) ?? '';
      if (pin.net) netted++;
    }
    dbg.log(`v15: nets — R1 ${counts.r1}, R5 ${counts.r5}, R8c ${counts.r8c}, R08 ${counts.r08}; ${netted} of ${allPads.length} pads named`);
    return { byInstance, routeCounts: counts };
  }

  /** Walk a v15 linked list. The per-block parser owns reading m_Next from
   *  whatever field position is correct for that block type; it returns the
   *  parsed block plus the next-key the walker should follow. The walker only
   *  reads the 4-byte prefix and m_Key (which are at constant offsets 0 and 4
   *  in every observed v15 block) and dispatches the rest. */
  private walkV15LL(
    stream: AllegroStream,
    ll: LinkedList,
    globalAddend: number,
    map: Map<number, AllegroBlock>,
    parseRecord: (s: AllegroStream, offset: number, mKey: number, prefix: number) => { block: AllegroBlock; next: number },
  ): number {
    let n = 0;
    let key = ll.head;
    const visited = new Set<number>();
    const MAX_ITER = 1_000_000;
    for (let i = 0; i < MAX_ITER && key !== 0 && key !== ll.tail; i++) {
      if (visited.has(key)) {
        dbg.warn(`v15: cycle detected at key 0x${key.toString(16)}, stopping`);
        break;
      }
      visited.add(key);
      const offset = key - globalAddend;
      if (offset < 0 || offset + 8 > stream.size) {
        dbg.warn(`v15: record at key 0x${key.toString(16)} → offset 0x${offset.toString(16)} out of bounds`);
        break;
      }
      stream.seek(offset);
      const prefix = stream.u32();
      const mKey = stream.u32();
      if (mKey !== key) {
        dbg.warn(`v15: record at offset 0x${offset.toString(16)} has m_Key 0x${mKey.toString(16)} != expected 0x${key.toString(16)}`);
        break;
      }
      const { block, next } = parseRecord(stream, offset, mKey, prefix);
      map.set(block.key, block);
      n++;
      key = next;
    }
    return n;
  }
}
