import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Plain (unencoded) ASC delivery — issue #26.
//
// The Honhan / Tebo-ICT `.bdv` is an obfuscated BUNDLE whose section markers
// are literally file names: `<<format.asc>>`, `<<nails.asc>>`, `<<pins.asc>>`.
// Some vendor tools ship those three as separate plain files instead. There is
// no such sample in the corpus, so the fixtures here are generated from a real
// `.bdv` by de-obfuscating it and splitting on its own markers — which makes
// this an equivalence test: the split-out files must reproduce, exactly, the
// board the bundle produces.
const BDV = path.resolve(__dirname, '../../../samples/BROKEN/fixed/BDV/LA-L031P_r1A_GH53Z.bdv');
const haveBdv = fs.existsSync(BDV);

async function sectionFiles(): Promise<{ dir: string; names: string[] }> {
  const { decodeBDVAsc } = await import('../src/parsers/bdv-asc-decoder');
  const text: string = decodeBDVAsc(new Uint8Array(fs.readFileSync(BDV)));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asc-sections-'));
  const re = /<<([^>]+)>>/g;
  const marks: Array<{ name: string; start: number; body: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) marks.push({ name: m[1], start: m.index, body: m.index + m[0].length });
  const names: string[] = [];
  marks.forEach((mk, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    fs.writeFileSync(path.join(dir, mk.name), text.slice(mk.body, end).replace(/^\r?\n/, ''));
    names.push(mk.name);
  });
  return { dir, names };
}

interface Counts { parts: number; pins: number; nets: number; outline: number; nails: number }

async function countsFor(page: import('@playwright/test').Page, files: string[]): Promise<Counts> {
  await page.goto('/');
  await page.getByTestId('file-input').setInputFiles(files);
  await expect(page.getByTestId('statusbar')).toContainText('Components:', { timeout: 60000 });
  return page.evaluate(() => {
    const b = (window as unknown as { __boardStore?: { activeTab?: { board?: {
      parts: { pins: unknown[] }[]; nets: Map<string, unknown>; outline: unknown[]; nails: unknown[];
    } } } }).__boardStore?.activeTab?.board;
    return {
      parts: b?.parts.length ?? 0,
      pins: b?.parts.reduce((n, p) => n + p.pins.length, 0) ?? 0,
      nets: b?.nets.size ?? 0,
      outline: b?.outline.length ?? 0,
      nails: b?.nails.length ?? 0,
    };
  });
}

test.describe('plain ASC sections', () => {
  test('three plain section files load as ONE board identical to the .bdv bundle', async ({ page }) => {
    test.skip(!haveBdv, 'samples/BROKEN/fixed/BDV/LA-L031P not present (proprietary fixture)');
    test.setTimeout(120000);
    const { dir, names } = await sectionFiles();
    expect(names.sort()).toEqual(['format.asc', 'nails.asc', 'pins.asc']);

    const bundle = await countsFor(page, [BDV]);
    const split = await countsFor(page, names.map(n => path.join(dir, n)));

    expect(split).toEqual(bundle);
    expect(bundle.parts).toBeGreaterThan(0);
    expect(bundle.nails).toBeGreaterThan(0);
    expect(bundle.outline).toBeGreaterThan(0);
  });

  test('one tab, not three — the merge happens before a tab is opened', async ({ page }) => {
    test.skip(!haveBdv, 'samples/BROKEN/fixed/BDV/LA-L031P not present (proprietary fixture)');
    test.setTimeout(120000);
    const { dir, names } = await sectionFiles();
    await countsFor(page, names.map(n => path.join(dir, n)));
    const tabs = await page.evaluate(() =>
      (window as unknown as { __boardStore?: { tabs: { fileName: string }[] } }).__boardStore?.tabs.map(t => t.fileName) ?? []);
    expect(tabs).toHaveLength(1);
    // Named after the board (the files' common stem), not after one section.
    expect(tabs[0]).not.toBe('pins.asc');
  });

  test('a lone pins.asc still opens — parts and nets, no outline', async ({ page }) => {
    test.skip(!haveBdv, 'samples/BROKEN/fixed/BDV/LA-L031P not present (proprietary fixture)');
    test.setTimeout(120000);
    const { dir } = await sectionFiles();
    const solo = await countsFor(page, [path.join(dir, 'pins.asc')]);
    expect(solo.parts).toBeGreaterThan(0);
    expect(solo.nets).toBeGreaterThan(0);
    expect(solo.outline).toBe(0);
    expect(solo.nails).toBe(0);
  });
});
