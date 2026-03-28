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
      `(ver=${FmtVer[this.header.fmtVer] ?? this.header.fmtVer}, ` +
      `objects=${this.header.objectCount}, strings=${this.header.stringsCount})`
    );

    // Phase 2: String table
    this.strings = this.parseStringTable(stream);
    dbg.log(`String table: ${this.strings.size} entries`);

    // Phase 3: Blocks
    this.blocks = this.parseBlocks(stream);
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
}
