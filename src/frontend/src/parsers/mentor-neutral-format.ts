import type { FormatDescriptor } from './registry';
import { parseMentorNeutral } from './mentor-neutral-parser';

const decoder = new TextDecoder('utf-8');

/**
 * Mentor Boardstation Neutral File — plain-text PCB neutral export shipped
 * by some Quanta / Compal / Samsung laptop board packages. Distinct from
 * GenCAD (also `.cad`); content sniff routes correctly.
 *
 * Detection: first 512 bytes contain a `BOARD ... OFFSET x:` header AND a
 * `B_UNITS` declaration. GenCAD has neither, so the two formats can't both
 * match the same file.
 */
export const MentorNeutralFormat: FormatDescriptor = {
  id: 'MENTOR',
  name: 'Mentor Boardstation Neutral',
  extensions: ['.cad'],
  description: 'Mentor Graphics Boardstation neutral file (BOARD/COMP/NET/GEOM sections).',
  docUrl: 'docs/formats/MENTOR_NEUTRAL_FORMAT.md',
  flipY: true,

  detect(header: Uint8Array): boolean {
    const text = decoder.decode(header);
    return /(^|\n)BOARD\s+\S+\s+OFFSET\s+x:/.test(text)
        && /(^|\n)B_UNITS\s+/.test(text);
  },

  parse(buffer: ArrayBuffer) {
    return parseMentorNeutral(buffer);
  },
};
