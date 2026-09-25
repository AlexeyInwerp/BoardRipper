/**
 * pdf.js ships pre-built and calls ES2024/2025 APIs directly; Vite lowers
 * syntax to the build target but never polyfills an API. Every one of those
 * calls is covered today — by pdf.js's own feature test, by src/polyfills.ts
 * (main thread) or by the worker patch in patches/ (the worker has its own
 * global and cannot see the main-thread shims). A pdfjs-dist bump adds new
 * calls; this test fails then, instead of an iPad on iOS 17 in the field.
 *
 * Floors (MDN BCD, 2026-09): withResolvers / transferToFixedLength 17.4,
 * URL.parse 18, Promise.try / toBase64 / fromBase64 / toHex / Float16Array
 * 18.2, iterator helpers 18.4, getOrInsertComputed / sumPrecise 26.2.
 * The build target is Safari 16.4; anything above it needs a shim or a guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const here = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

const main = read('node_modules/pdfjs-dist/build/pdf.mjs');
const worker = read('node_modules/pdfjs-dist/build/pdf.worker.mjs');
const polyfills = read('src/polyfills.ts');

/** `use`: how a call looks in the built file. `guard`: the substring a
 *  feature test or a shim contains (`typeof <guard> !==` in pdf.js's own
 *  code, in polyfills.ts, or in the patched worker). */
const APIS: { name: string; use: RegExp; guard: string }[] = [
  { name: 'Promise.withResolvers',          use: /\.withResolvers\(/,            guard: 'Promise.withResolvers' },
  { name: 'Promise.try',                    use: /Promise\.try\(/,               guard: 'Promise.try' },
  { name: 'URL.parse',                      use: /URL\.parse\(/,                 guard: 'URL.parse' },
  { name: 'ArrayBuffer.transferToFixedLength', use: /\.transferToFixedLength\(/, guard: 'ArrayBuffer.prototype.transferToFixedLength' },
  { name: 'Uint8Array.prototype.toBase64',  use: /\.toBase64\(/,                 guard: 'Uint8Array.prototype.toBase64' },
  { name: 'Uint8Array.fromBase64',          use: /Uint8Array\.fromBase64\(/,     guard: 'Uint8Array.fromBase64' },
  { name: 'Uint8Array.prototype.toHex',     use: /\.toHex\(/,                    guard: 'Uint8Array.prototype.toHex' },
  { name: 'Uint8Array.fromHex',             use: /Uint8Array\.fromHex\(/,        guard: 'Uint8Array.fromHex' },
  { name: 'Map.prototype.getOrInsertComputed', use: /\.getOrInsertComputed\(/,   guard: 'Map.prototype.getOrInsertComputed' },
  { name: 'Map.prototype.getOrInsert',      use: /\.getOrInsert\(/,              guard: 'Map.prototype.getOrInsert' },
  { name: 'Math.sumPrecise',                use: /Math\.sumPrecise\(/,           guard: 'Math.sumPrecise' },
  { name: 'Float16Array',                   use: /new Float16Array\(/,           guard: 'Float16Array' },
  { name: 'Iterator helpers (take/drop)',   use: /\.(take|drop)\(\d/,            guard: 'Iterator.prototype' },
  { name: 'Iterator.from',                  use: /Iterator\.from\(/,             guard: 'Iterator.from' },
  { name: 'Set.prototype.union',            use: /\.union\(/,                    guard: 'Set.prototype.union' },
  { name: 'Iterator.prototype.join',        use: /\.join\(\)/,                   guard: 'Iterator.prototype.join' },
];

function guarded(file: string, guard: string): boolean {
  // pdf.js style: `typeof Float16Array !== "undefined"`, our style:
  // `typeof (Promise as …).withResolvers !== 'function'` — both contain the
  // bare name after `typeof`, so match loosely on `typeof …<name>`.
  const tail = guard.split('.').pop()!;
  return new RegExp(`typeof [^;\\n]{0,80}${tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b[^;\\n]{0,40}!==`).test(file);
}

describe('pdfjs-dist API floor', () => {
  for (const api of APIS) {
    it(`main thread: ${api.name} is guarded or shimmed`, () => {
      if (!api.use.test(main)) return; // not used — nothing to cover
      if (api.name === 'Iterator.prototype.join') return; // `.join()` is also Array; only meaningful with the guard present
      expect(guarded(main, api.guard) || guarded(polyfills, api.guard),
        `${api.name} is called in pdf.mjs but neither pdf.js nor src/polyfills.ts guards it`).toBe(true);
    });
    it(`worker: ${api.name} is guarded or shimmed inside the worker file`, () => {
      if (!api.use.test(worker)) return;
      if (api.name === 'Iterator.prototype.join') return;
      expect(guarded(worker, api.guard),
        `${api.name} is called in pdf.worker.mjs with no guard in the file — the main-thread shims do not reach a worker; add it to patches/pdfjs-dist+<version>.patch`).toBe(true);
    });
  }

  it('the worker patch is applied (its shims are present)', () => {
    expect(worker).toContain('BoardRipper');
  });
});
