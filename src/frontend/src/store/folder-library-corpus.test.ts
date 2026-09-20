import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import '../parsers/index';
import { folderLibrary } from './folder-library';

/**
 * The folder scan against the real local corpus (`samples/`, gitignored and
 * proprietary — this whole file skips without it, like every other spec that
 * needs real boards).
 *
 * It asserts rules, not counts: the corpus grows, and a test that has to be
 * edited whenever a board is added stops being run.
 */
const ROOT = path.resolve(__dirname, '../../../../samples');
const HAVE_CORPUS = fs.existsSync(ROOT);

/** A `File` with the four fields the scan reads plus a real `slice` — the
 *  header sniff is the one thing that touches bytes, and faking it away
 *  would skip the behaviour this file exists to check. */
function fileFor(full: string, rel: string): File {
  const st = fs.statSync(full);
  return {
    name: path.basename(full),
    size: st.size,
    lastModified: st.mtimeMs,
    webkitRelativePath: `samples/${rel}`,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => {
        const fd = fs.openSync(full, 'r');
        const len = Math.max(0, Math.min(end, st.size) - start);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        fs.closeSync(fd);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    }),
  } as unknown as File;
}

function collect(dir: string, rel: string, out: File[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) collect(full, r, out);
    else if (e.isFile()) out.push(fileFor(full, r));
  }
}

describe.skipIf(!HAVE_CORPUS)('folder scan over the local corpus', () => {
  it('indexes every board, with unique ids and the right format', async () => {
    const offered: File[] = [];
    collect(ROOT, '', offered);
    expect(offered.length).toBeGreaterThan(50);

    const t0 = performance.now();
    const scan = await folderLibrary.adoptFileList(offered);
    const elapsed = performance.now() - t0;
    expect(scan).not.toBeNull();

    // Nothing in the corpus is anything but a board, so nothing may drop.
    const boardish = offered.filter(f => /\.(brd|pcb|kicad_pcb|bvr|bv|bdv|asc|fz|cae|cad|tvw|pcbdoc)$/i.test(f.name));
    expect(scan!.files.length).toBe(boardish.length);
    expect(new Set(scan!.files.map(f => f.id)).size).toBe(scan!.files.length);

    // `.brd` is claimed by three formats and `detectByExtension` answers with
    // whichever registered first (BDV). Only a header read gets these right.
    const fmtOf = (p: string) => scan!.files.find(f => f.path === p)?.format_id;
    for (const f of scan!.files) {
      if (f.path.startsWith('eagle/')) expect(fmtOf(f.path), f.path).toBe('EAGLE_BRD');
      if (f.path.startsWith('allegroBRD/')) expect(fmtOf(f.path), f.path).toBe('ALLEGRO_BRD');
      if (f.extension === '.pcb') expect(fmtOf(f.path), f.path).toBe('XZZ');
      if (f.extension === '.kicad_pcb') expect(fmtOf(f.path), f.path).toBe('KICAD');
      expect(f.format_id, `${f.path} was not recognised at all`).not.toBe('');
    }

    // Listing a folder must stay a listing — a scan that parsed boards would
    // be minutes here, not milliseconds.
    expect(elapsed).toBeLessThan(5000);
  });
});
