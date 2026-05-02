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

    let nComponents = 0;
    let key = ll0x06.head;
    const visited = new Set<number>();
    const MAX_ITER = 1_000_000;
    for (let i = 0; i < MAX_ITER && key !== 0 && key !== ll0x06.tail; i++) {
      if (visited.has(key)) {
        dbg.warn(`v15: LL_0x06 cycle detected at key 0x${key.toString(16)}, stopping`);
        break;
      }
      visited.add(key);

      const offset = key - globalAddend;
      if (offset < 0 || offset + 36 > stream.size) {
        dbg.warn(`v15: LL_0x06 record at key 0x${key.toString(16)} → offset 0x${offset.toString(16)} out of bounds`);
        break;
      }
      stream.seek(offset);
      const prefix = stream.u32(); // [00 18 0X 00] — sub-type byte at position 2
      void prefix;
      const mKey = stream.u32();
      const mNext = stream.u32();
      const compDeviceType = stream.u32();
      const symbolName = stream.u32();
      const firstInstPtr = stream.u32();
      const ptrFunctionSlot = stream.u32();
      const ptrPinNumber = stream.u32();
      const fields = stream.u32();

      if (mKey !== key) {
        dbg.warn(`v15: LL_0x06 record at offset 0x${offset.toString(16)} has m_Key 0x${mKey.toString(16)} != expected 0x${key.toString(16)}`);
        break;
      }

      map.set(mKey, {
        blockType: 0x06,
        offset,
        key: mKey,
        next: mNext,
        compDeviceType,
        symbolName,
        firstInstPtr,
        ptrFunctionSlot,
        ptrPinNumber,
        fields,
        unknown1: undefined, // V_172+ field — n/a for v15
      });
      nComponents++;
      key = mNext;
    }
    dbg.log(`v15: walked LL_0x06 → ${nComponents} components`);
    return map;
  }
}
