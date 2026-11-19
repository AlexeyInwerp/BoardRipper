import { describe, it, expect } from 'vitest';
import { deflate } from 'pako';
import { parseFZ, parseDescription } from './fz-parser';

/**
 * The description section is a BOM; its DESCRIPTION column is what
 * OpenBoardView shows as a part's "MFG code". Canary: "XPS 15 9530 Compal
 * HD055 LA-L663P Rev 1.0" (GOCCANH export, 4,069 rows, one per refdes).
 */
const CONTENT = [
  'A!UNIT!mils!',
  'A!REFDES!COMP_INSERTION_CODE!SYM_NAME!SYM_MIRROR!SYM_ROTATE!SYM_X!SYM_Y!',
  'S!PQ1900!0!PQ1900!YES!90!0!0!',
  'S!C1!0!C1!NO!0!0!0!',
  'S!C2!0!C2!NO!0!0!0!',
  'S!SW_BOT!0!SW_BOT!NO!0!0!0!',
  'S!R9!0!R9!NO!0!0!0!',
  'A!NET_NAME!REFDES!PIN_NUMBER!PIN_NAME!PIN_X!PIN_Y!TEST_POINT!RADIUS!',
  'S!VCC!PQ1900!1!1!100!200!0!30!',
  'S!VCC!C1!1!1!300!200!0!30!',
  'S!VCC!C2!1!1!500!200!0!30!',
  'S!GND!SW_BOT!1!1!700!200!0!30!',
  'S!GND!R9!1!1!900!200!0!30!',
].join('\r');

const DESCR = [
  '<GOCCANH-XJ>Convert Boardview/Schematic|ALL||LA-L663P R10|VIETNAM',
  'PARTNUMBER\tDESCRIPTION\tQTY\tLOCATION\tPARTNUMBER2',
  'PQ1900\t//AON6314 N DFN56-8-5\t1\tPQ1900\t',
  '11G233510411\tCAP 0.1UF 16V X7R 0201\t2\tC1,C2\t',
  'SW BOT\t//T4BJB26BQR 4P\t1\tSW BOT\t',
  'skip\tunused row\t1\tR9\t',
].join('\r\n');

/** [tag][zlib content][4-byte prefix][zlib descr][u32 descr size]. */
function container(content: string, descr: string): ArrayBuffer {
  const c = deflate(content);
  const d = deflate(descr);
  const descrSize = 4 + d.length + 4;
  const out = new Uint8Array(4 + c.length + descrSize);
  out.set([0x47, 0x43, 0x56, 0x4e], 0);
  out.set(c, 4);
  out.set(d, 4 + c.length + 4);
  new DataView(out.buffer).setUint32(out.length - 4, descrSize, true);
  return out.buffer;
}

describe('FZ description section', () => {
  it('puts the description on every listed part', async () => {
    const board = await parseFZ(container(CONTENT, DESCR));
    const meta = (n: string) => board.parts.find(p => p.name === n)?.meta;
    expect(meta('PQ1900')).toEqual({ angleDeg: 90, value: 'AON6314 N DFN56-8-5' });
    expect(meta('C1')).toEqual({ value: 'CAP 0.1UF 16V X7R 0201', serial: '11G233510411' });
    expect(meta('C2')).toEqual({ value: 'CAP 0.1UF 16V X7R 0201', serial: '11G233510411' });
    expect(meta('SW_BOT')?.value).toBe('T4BJB26BQR 4P');
    expect(meta('R9')).toBeUndefined();
  });

  it('opens a file without a description section', async () => {
    const c = deflate(CONTENT);
    const out = new Uint8Array(4 + c.length + 4);
    out.set([0x47, 0x43, 0x56, 0x4e], 0);
    out.set(c, 4);
    new DataView(out.buffer).setUint32(out.length - 4, 4, true);
    const board = await parseFZ(out.buffer);
    expect(board.parts.find(p => p.name === 'C1')?.meta).toBeUndefined();
  });

  it('does not take a refdes for a part number', () => {
    expect(parseDescription(DESCR).get('PQ1900')).toEqual({ description: 'AON6314 N DFN56-8-5' });
  });
});
