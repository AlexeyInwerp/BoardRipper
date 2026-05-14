/**
 * CFB (Compound File Binary) wrapper.
 *
 * Altium .PcbDoc is an MS-CFB container. We use SheetJS's `cfb` for the
 * low-level container work — it handles SAT/MiniSAT navigation, DIFAT
 * chains, FAT sector traversal, etc.
 *
 * KiCad's equivalent: ALTIUM_COMPOUND_FILE in common/io/altium/.
 */

import { read as cfbRead, find as cfbFind, type CFB$Container } from 'cfb';

export interface AltiumCfb {
  /** Names of all data streams (excluding directories). */
  listStreams(): string[];
  /** Returns the raw bytes for a stream by name (e.g. 'Components6/Data'), or null. */
  getStream(name: string): Uint8Array | null;
}

export function openAltiumCfb(buffer: ArrayBuffer): AltiumCfb {
  const u8 = new Uint8Array(buffer);
  const container: CFB$Container = cfbRead(u8, { type: 'buffer' });
  return {
    listStreams(): string[] {
      return container.FullPaths
        .filter(p => !p.endsWith('/'))
        .map(p => p.replace(/^Root Entry\//, ''));
    },
    getStream(name: string): Uint8Array | null {
      const entry = cfbFind(container, name);
      if (!entry || !entry.content) return null;
      const c = entry.content;
      if (c instanceof Uint8Array) return c;
      return new Uint8Array(c as ArrayLike<number>);
    },
  };
}
