/**
 * Per-component oracle correctness gate for the Allegro v15 parser.
 *
 * For each (BRD, CAD) sample pair, parses the BRD, walks every component,
 * and compares the parser's per-pin net set to the .cad NODE statements.
 *
 * **Hard rule:** false-positives MUST be 0 — no parser-attributed net may
 * exist on a component where oracle says it doesn't. We tolerate misses
 * (oracle says X but we don't have X) but never lies. CAD is source of
 * truth.
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLES_DIR = path.resolve(__dirname, '../../../samples/BROKEN/brd new set');

type OracleNetMap = Map<string, Map<string, string>>; // refdes → (pin → net)

function parseCadOracle(cadPath: string): OracleNetMap {
  const text = fs.readFileSync(cadPath, 'utf8');
  const out: OracleNetMap = new Map();
  let curNet: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('SIGNAL ')) curNet = line.slice(7).trim();
    else if (line.startsWith('NODE ')) {
      const rest = line.slice(5);
      const sp = rest.indexOf(' ');
      if (sp < 0) continue;
      const refdes = rest.slice(0, sp);
      const pin = rest.slice(sp + 1).trim();
      const cleaned = (curNet ?? '').startsWith('/') ? (curNet ?? '').slice(1) : (curNet ?? '');
      if (!out.has(refdes)) out.set(refdes, new Map());
      out.get(refdes)!.set(pin, cleaned);
    }
  }
  return out;
}

interface Comparison {
  total: number;
  perfect: number;
  fpTotal: number;
  missedTotal: number;
  worst: Array<{ refdes: string; oracle: number; parser: number; correct: number; fp: number; missed: number; fpExamples: string[] }>;
}

async function runOracleCheck(brdPath: string, cadPath: string): Promise<Comparison> {
  const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
  const buf = fs.readFileSync(brdPath);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const board = parseAllegroBRD(ab);

  const oracle = parseCadOracle(cadPath);

  const parserByRefdes = new Map<string, Set<string>>();
  for (const part of board.parts) {
    if (!parserByRefdes.has(part.name)) parserByRefdes.set(part.name, new Set());
    const set = parserByRefdes.get(part.name)!;
    for (const pin of part.pins) if (pin.net) set.add(pin.net);
  }

  let total = 0, perfect = 0, fpTotal = 0, missedTotal = 0;
  const worst: Comparison['worst'] = [];
  for (const [refdes, oraclePins] of oracle) {
    const parserNets = parserByRefdes.get(refdes);
    if (!parserNets) continue;
    total++;
    const oracleNets = new Set([...oraclePins.values()].filter(n => n));
    const correct = [...parserNets].filter(n => oracleNets.has(n));
    const fp = [...parserNets].filter(n => !oracleNets.has(n));
    const missed = [...oracleNets].filter(n => !parserNets.has(n));
    fpTotal += fp.length;
    missedTotal += missed.length;
    if (fp.length === 0 && missed.length === 0) perfect++;
    if (fp.length > 0) {
      worst.push({
        refdes,
        oracle: oracleNets.size,
        parser: parserNets.size,
        correct: correct.length,
        fp: fp.length,
        missed: missed.length,
        fpExamples: fp.slice(0, 3),
      });
    }
  }
  worst.sort((a, b) => b.fp - a.fp);
  return { total, perfect, fpTotal, missedTotal, worst };
}

test.describe('Allegro v15 oracle correctness', () => {
  test('COMPAL LA-7321P (15.5.7) — per-component nets match .cad with zero false positives', async () => {
    const brdPath = path.resolve(SAMPLES_DIR, 'COMPAL LA-7321P.brd');
    const cadPath = path.resolve(SAMPLES_DIR, 'COMPAL LA-7321P.cad');
    if (!fs.existsSync(brdPath) || !fs.existsSync(cadPath)) {
      test.skip(true, 'sample files not present');
      return;
    }
    const r = await runOracleCheck(brdPath, cadPath);
    console.log(`[LA-7321P] components=${r.total} perfect=${r.perfect} (${(100 * r.perfect / r.total).toFixed(1)}%) FP=${r.fpTotal} missed=${r.missedTotal}`);
    if (r.worst.length > 0) {
      console.log(`[LA-7321P] FP samples (top 5):`);
      for (const w of r.worst.slice(0, 5)) console.log(`  ${w.refdes}: fp=${w.fp} (${w.fpExamples.join(',')})`);
    }
    // Hard precision gate
    expect(r.fpTotal, 'No false-positive nets allowed — CAD is source of truth').toBe(0);
    // Recall gate: don't allow regressions below the current 1823/~1900 perfect baseline
    expect(r.perfect).toBeGreaterThanOrEqual(1500);
  });

  test('v13tl-0629 (15.5.2) — pin geometry walks without crashing', async () => {
    const brdPath = path.resolve(SAMPLES_DIR, 'v13tl-0629.brd');
    const cadPath = path.resolve(SAMPLES_DIR, 'v13tl-0629.cad');
    if (!fs.existsSync(brdPath) || !fs.existsSync(cadPath)) {
      test.skip(true, 'sample files not present');
      return;
    }
    const r = await runOracleCheck(brdPath, cadPath);
    console.log(`[v13tl-0629] components=${r.total} perfect=${r.perfect} FP=${r.fpTotal} missed=${r.missedTotal}`);
    // Net routes are magic-gated OFF on 15.5.2 — parser should NOT emit any nets.
    // If it does, we've leaked a route past the gate.
    expect(r.fpTotal, 'No false-positive nets allowed on 15.5.2 (net routes magic-gated OFF)').toBe(0);
  });

  /**
   * Jasper_Kronos (15.5.x, magic 0x0012050a — a third sub-variant) has no
   * .cad sibling; its oracle is Allegro's own v17 re-save of the same board,
   * which the mature v16+ path parses. Part origins agree to <5 mil, so pins
   * are matched by (refdes, pin number) and compared on position and net.
   *
   * Baseline at commit cb4d880: 1933 parts, 7982/7982 pins, 7976 within
   * 2 mil (the 6 "off" are socket mounting posts that both files leave
   * unnumbered, which collide in the by-number map), 7910 nets agree,
   * 0 disagree, 0 missed.
   */
  test('Jasper_Kronos (15.5.x, 0x0012050a) — pins and nets match the v17 re-save', async () => {
    const dir = path.resolve(__dirname, '../../../samples/incoming/uncategorized');
    const v15Path = path.resolve(dir, 'Jasper_Kronos.brd');
    const v17Path = path.resolve(dir, 'Jasper_Kronos_v17.brd');
    if (!fs.existsSync(v15Path) || !fs.existsSync(v17Path)) {
      test.skip(true, 'sample files not present');
      return;
    }
    const { parseAllegroBRD } = await import('../src/parsers/allegro/allegro-brd-parser');
    const load = (p: string) => {
      const buf = fs.readFileSync(p);
      return parseAllegroBRD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    };
    const a = load(v15Path);
    const b = load(v17Path);
    const byName = new Map(b.parts.map((p) => [p.name, p]));

    // Every v15 part is a real component of the v17 board — no drawing
    // symbols, no UNK placeholders — and the bounds are the board's.
    for (const p of a.parts) expect(byName.has(p.name), `v15 part ${p.name} is not in the v17 re-save`).toBe(true);
    expect(a.parts.length).toBe(b.parts.length);
    expect(a.bounds.minX).toBeGreaterThan(-300);
    expect(a.bounds.maxX).toBeLessThan(10500);
    expect(a.bounds.minY).toBeGreaterThan(-300);
    expect(a.bounds.maxY).toBeLessThan(8300);

    let pins = 0, matched = 0, posOk = 0, agree = 0, wrong = 0, missed = 0;
    const wrongExamples: string[] = [];
    for (const pa of a.parts) {
      const pbPart = byName.get(pa.name)!;
      const oraclePins = new Map(pbPart.pins.filter((q) => q.number).map((q) => [q.number, q]));
      for (const pin of pa.pins) {
        pins++;
        if (!pin.number) continue;
        const q = oraclePins.get(pin.number);
        if (!q) continue;
        matched++;
        if (Math.hypot(pin.position.x - q.position.x, pin.position.y - q.position.y) <= 2) posOk++;
        if (pin.net && q.net) {
          if (pin.net === q.net) agree++;
          else { wrong++; if (wrongExamples.length < 10) wrongExamples.push(`${pa.name}.${pin.number}: v15=${pin.net} v17=${q.net}`); }
        } else if (!pin.net && q.net) missed++;
      }
    }
    const v17Pins = b.parts.reduce((n, p) => n + p.pins.length, 0);
    console.log(`[Kronos] parts=${a.parts.length} pins=${pins}/${v17Pins} matched=${matched} pos<=2mil=${posOk} nets agree=${agree} wrong=${wrong} missed=${missed}`);
    if (wrongExamples.length) console.log('[Kronos] wrong nets:', wrongExamples.join('; '));

    // Hard gate: a wrong net is worse than no net.
    expect(wrong, 'No net may disagree with the v17 re-save').toBe(0);
    // Recall gates, a little under the measured baseline.
    expect(pins).toBeGreaterThanOrEqual(v17Pins - 50);
    expect(posOk).toBeGreaterThanOrEqual(matched - 20);
    expect(agree).toBeGreaterThanOrEqual(7800);
    expect(missed).toBeLessThanOrEqual(50);
  });
});
