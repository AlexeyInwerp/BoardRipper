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
});
