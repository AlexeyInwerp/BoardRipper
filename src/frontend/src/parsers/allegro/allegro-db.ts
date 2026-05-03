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

export class AllegroDb {
  readonly header: FileHeader;
  readonly strings: Map<number, string>;
  readonly blocks: Map<number, AllegroBlock>;

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
        // Log and stop — don't crash the whole parse on a single bad block
        dbg.warn(
          `Block parse error at offset 0x${stream.position.toString(16)}: ${e instanceof Error ? e.message : e}`
        );
        break;
      }
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

    // ── PAD CHAIN (v15-specific) ──────────────────────────────────────────
    // BLK_0x07 ←[+0x28]─ byte1=0x40 ─[+0x2C]→ BLK_0x48 first pad
    //   BLK_0x48 ─[+0x08]→ BLK_0x48 m_Next
    //   BLK_0x48 ─[+0x10]→ BLK_0xC8 (pad geometry, coords at +0x34..+0x40)
    //
    // Whole-file scans for the three signatures. Records are stored as
    // generic blocks in db.blocks so the v15 assembler can traverse them.
    const fileBytes = new Uint8Array((stream as unknown as { view: DataView }).view.buffer);
    const peekByte = (off: number) => fileBytes[off];
    const peekU32 = (off: number) =>
      ((fileBytes[off]) | (fileBytes[off+1] << 8) | (fileBytes[off+2] << 16) | (fileBytes[off+3] << 24)) >>> 0;
    const peekI32 = (off: number) => (peekU32(off) | 0);

    // Walk byte1=0x40 records (per-placement device records) — 56-byte stride
    // assumption when contiguous; we just scan whole file for the prefix and
    // store each record. Build a Map<blk07Key, firstPadKey> for fast lookup.
    const blk07ToFirstPad = new Map<number, number>();
    let n40 = 0;
    for (let off = 0; off + 56 <= fileBytes.length; off += 4) {
      if (peekByte(off) !== 0x00 || peekByte(off+1) !== 0x40 || peekByte(off+3) !== 0x00) continue;
      const blk07Ref = peekU32(off + 0x28);
      const firstPad = peekU32(off + 0x2C);
      if (blk07Ref !== 0 && firstPad !== 0) {
        blk07ToFirstPad.set(blk07Ref, firstPad);
      }
      n40++;
    }
    dbg.log(`v15: scanned byte1=0x40 → ${n40} per-placement records, ${blk07ToFirstPad.size} BLK_0x07→firstPad links`);

    // Walk BLK_0x48 records (pad headers) — 24-byte logical size. Store as
    // {next, detailKey} per m_Key.
    const blk48Records = new Map<number, { next: number; detailKey: number }>();
    for (let off = 0; off + 24 <= fileBytes.length; off += 4) {
      if (peekByte(off) !== 0x00 || peekByte(off+1) !== 0x48 || peekByte(off+3) !== 0x00) continue;
      const mKey = peekU32(off + 0x04);
      const next = peekU32(off + 0x08);
      const detail = peekU32(off + 0x10);
      if (mKey !== 0) blk48Records.set(mKey, { next, detailKey: detail });
    }
    dbg.log(`v15: scanned BLK_0x48 → ${blk48Records.size} pad header records`);

    // Walk BLK_0xC8 records (pad geometry) — coords at +0x38..+0x44
    // (verified board-absolute via .cad oracle: PQ306/L124/U41 pin 1
    // positions decode EXACTLY to oracle values).
    const blkC8Records = new Map<number, { coords: [number, number, number, number] }>();
    for (let off = 0; off + 0x48 <= fileBytes.length; off += 4) {
      if (peekByte(off) !== 0x00 || peekByte(off+1) !== 0xC8 || peekByte(off+3) !== 0x00) continue;
      const mKey = peekU32(off + 0x04);
      const x1 = peekI32(off + 0x38);
      const y1 = peekI32(off + 0x3C);
      const x2 = peekI32(off + 0x40);
      const y2 = peekI32(off + 0x44);
      if (mKey !== 0) blkC8Records.set(mKey, { coords: [x1, y1, x2, y2] });
    }
    dbg.log(`v15: scanned BLK_0xC8 → ${blkC8Records.size} pad geometry records`);

    // Stash the pad chain on the AllegroDb instance so the v15 assembler can
    // resolve pads per BLK_0x2D placement.
    (this as unknown as Record<string, unknown>).v15PadChain = {
      blk07ToFirstPad, blk48Records, blkC8Records,
    };

    // BLK_0x2D (Footprint instances / placed parts) — sequential 60-byte
    // records, no LL in the header. The records are NOT grouped per footprint
    // — each record's m_FpDefRef (at +0x18) points to whichever BLK_0x2B is
    // its parent. Walker scans starting at min(BLK_0x2B.firstInstPtr) − addend
    // and stops when the prefix byte 1 is no longer 0xB4.
    //
    // v15 BLK_0x2D 60-byte layout (validated on COMPAL LA-7321P):
    //   +0x00  prefix `00 b4 0X 00`  (0X is per-instance sub-type / counter)
    //   +0x04  m_Key
    //   +0x08  unknown
    //   +0x0C  unknown
    //   +0x10  i32 m_CoordX (signed mils*divisor)
    //   +0x14  i32 m_CoordY
    //   +0x18  m_FpDefRef → BLK_0x2B
    //   +0x1C  m_InstRef → BLK_0x07 (verified — resolves to refdes match in .cad oracle)
    //   +0x20..0x38  cross-pool pointers (BLK_0x32, BLK_0x14, etc — pending)
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
        // Validate prefix shape `00 b4 layerByte 00` — prefix byte 2 encodes
        // layer: 0x00 = top, 0x01 = bottom (verified via 1178/731 split on
        // LA-7321P, matches typical motherboard top/bottom ratio).
        stream.seek(scanPos);
        const p0 = stream.u8();
        const p1 = stream.u8();
        const layerByte = stream.u8();
        const p3 = stream.u8();
        if (p0 !== 0x00 || p1 !== 0xb4 || p3 !== 0x00) break;
        // m_Key at +0x04
        const mKey = stream.u32();
        // +0x08 looks like flags (0x00000000 ~ 0x01cb_xxxx); skip for now
        stream.skip(4);
        // +0x0C = rotation in millidegrees (verified: 0x2BF20 = 180000 = 180°)
        const rotationMillideg = stream.u32();
        // +0x10/+0x14 = signed coords
        const coordX = stream.s32();
        const coordY = stream.s32();
        // +0x18 = m_FpDefRef → BLK_0x2B
        const fpDefRef = stream.u32();
        // +0x1C = m_InstRef → BLK_0x07 (refdes lookup)
        const compDefRef = stream.u32();
        const ptr20 = stream.u32();
        const ptr24 = stream.u32();
        const ptr28 = stream.u32();
        const ptr2c = stream.u32();
        const ptr30 = stream.u32();
        void ptr20; void ptr24; void ptr28; void ptr30;

        // Build a Blk0x2DFootprintInst-shaped record. v15 doesn't expose all
        // the v16+ fields; we leave those zero/empty so the assembler chain
        // walk doesn't trip on them. The synthesized `next` is wired below.
        map.set(mKey, {
          blockType: 0x2D,
          offset: scanPos,
          key: mKey,
          next: 0,
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
          firstPadPtr: 0,
          textPtr: 0,
          assemblyPtr: 0,
          areasPtr: 0,
          unknownPtr1: fpDefRef,
          unknownPtr2: compDefRef,
        } as AllegroBlock);
        n2D++;
        scanPos += 60;
      }
      dbg.log(`v15: scanned BLK_0x2D → ${n2D} placed instances at 0x${start.toString(16)}..0x${scanPos.toString(16)}`);

      // Group BLK_0x2D records by their fpDefRef (stashed in unknownPtr1) and
      // synthesize per-footprint next chains so the existing assembler can
      // walk fpDef.firstInstPtr → inst.next → ... unchanged.
      const groups = new Map<number, AllegroBlock[]>();
      for (const blk of map.values()) {
        if (blk.blockType !== 0x2D) continue;
        const inst = blk as unknown as { unknownPtr1: number };
        const arr = groups.get(inst.unknownPtr1) ?? [];
        arr.push(blk);
        groups.set(inst.unknownPtr1, arr);
      }
      for (const arr of groups.values()) {
        for (let i = 0; i < arr.length - 1; i++) {
          (arr[i] as unknown as { next: number }).next = arr[i + 1].key;
        }
        // Last record's next stays 0 (terminator) so the assembler walk ends.
      }
      dbg.log(`v15: synthesized ${groups.size} BLK_0x2D chains`);
    }

    return map;
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
