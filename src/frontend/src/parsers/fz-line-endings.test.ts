import { describe, it, expect } from 'vitest';
import { deflate } from 'pako';
import { parseFZ } from './fz-parser';

/**
 * Line-ending tolerance.
 *
 * Canary: "XPS 15 9530 Compal HD055 LA-L663P Rev 1.0" — a GOCCANH "GCVN" export
 * whose content section uses bare CR (classic-Mac) line endings, no LF anywhere.
 * A `\r?\n` splitter sees the whole 745k-char document as a single line, so the
 * block-header/record walk never runs and the file dies on "contains no parts or
 * pins". The three endings must all behave identically.
 */
const CONTENT = [
  'A!UNIT!mils!',
  'A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!SYM_X!SYM_Y!',
  'S!U1!0!U1!YES!0!0!0!',
  'S!R5!0!R5!NO!0!0!0!',
  'A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!PAD_RADIUS!',
  'S!VCC!U1!1!A1!100!200!0!30!',
  'S!GND!U1!2!A2!300!200!0!30!',
  'S!VCC!R5!1!1!500!400!0!30!',
];

/** Build an unencrypted FZ container: [4-byte tag][zlib content][descr]. */
function container(text: string): ArrayBuffer {
  const body = deflate(text);
  const out = new Uint8Array(4 + body.length + 4);
  out.set([0x47, 0x43, 0x56, 0x4e], 0); // "GCVN"
  out.set(body, 4);
  // Trailing uint32 LE = size of the description section, which here is just
  // those same four bytes.
  new DataView(out.buffer).setUint32(out.length - 4, 4, true);
  return out.buffer;
}

describe('parseFZ line-ending tolerance', () => {
  for (const [name, eol] of [['LF', '\n'], ['CRLF', '\r\n'], ['bare CR', '\r']] as const) {
    it(`parses content delimited by ${name}`, async () => {
      const board = await parseFZ(container(CONTENT.join(eol) + eol));
      expect(board.parts.map(p => p.name).sort()).toEqual(['R5', 'U1']);
      const pins = board.parts.flatMap(p => p.pins);
      expect(pins).toHaveLength(3);
      expect(new Set(pins.map(p => p.net))).toEqual(new Set(['VCC', 'GND']));
    });
  }
});
