# Allegro v15.x BRD Parser Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Also REQUIRED:** Use `superpowers:binary-format-reverse-engineering` for Phase 0–3 (the format is undocumented; KiCad does not currently parse v15).

**Goal:** Parse Cadence Allegro BRD files in the v15.x family (magic family `0x0012`) into the existing `BoardData` shape so they render side-by-side with v16/v17/v18 boards. Concrete success criterion: `samples/BROKEN/brd new set/COMPAL LA-7321P.brd` (Allegro 15.5.7) renders with a part count, net count, and outline that match the sibling `COMPAL LA-7321P.cad` (GenCAD 1.4 export from the same source).

**Architecture:** v15 is a separate binary format from v16+ — different header layout, different block-table shape, possibly different linked-list ordering. The plan keeps the existing v16+ parser untouched and adds a parallel v15 path that produces the same intermediate `AllegroDb` shape, so the existing `assembleBoard()` (in `allegro-assembler.ts`) can consume it unchanged. Decision point: if v15's data model is too divergent, fork the assembler too — defer that call until Phase 3.

**Tech Stack:** TypeScript (strict), Node `tsx` for parser dev-loop, existing `AllegroStream` binary reader, sibling `.cad` parser as ground-truth oracle for validation, KiCad's `allegro_parser.cpp` git history as reference (read-only — do not assume v15 paths exist there).

**Critical context:** As of 2026-05-02 the v15 corpus is one file: `samples/BROKEN/brd new set/COMPAL LA-7321P.brd`. Before Phase 1 starts, the corpus must grow to ≥3 files spanning ≥2 minor versions, otherwise overfitting is guaranteed. Phase 0 enforces this.

**Out of scope:** v14.x and earlier (different again — explicitly defer). Allegro 16.x SOIC subtype quirks (handled by existing parser). Re-saving via Cadence Allegro to v16+ remains the documented workaround until this plan completes.

---

## File Structure

**New files:**
- `src/frontend/src/parsers/allegro/allegro-v15-header.ts` — v15-specific header parser (≤350 LoC, mirrors `allegro-header.ts` shape)
- `src/frontend/src/parsers/allegro/allegro-v15-blocks.ts` — v15-specific block parser (≤1500 LoC; mirror `allegro-blocks.ts` shape, but with v15 type codes and field layouts)
- `docs/formats/ALLEGRO_V15_FORMAT.md` — RE notes + spec, similar shape to existing format docs
- `scripts/allegro-dump.mjs` — read-only structure dumper for one BRD file (offsets, magic, candidate string table boundaries, block-table head/tail). Used in Phase 0 to drive RE.
- `src/frontend/tests/parsers/allegro-v15.spec.ts` — Playwright spec covering the canary file + 2 corpus expansion files

**Modified files:**
- `src/frontend/src/parsers/allegro/allegro-types.ts` — add `V_152, V_155, V_157` (or whichever minors land in corpus) to `FmtVer`
- `src/frontend/src/parsers/allegro/allegro-header.ts` — `formatFromMagic` switch gains v15 cases; the `V_PRE_V16` friendly-error throw is removed once v15 is genuinely supported (Phase 4)
- `src/frontend/src/parsers/allegro/allegro-db.ts` — `AllegroDb` constructor branches on family: v15 → `parseV15Header`/`parseV15Blocks`, else existing path
- `src/frontend/src/parsers/allegro/allegro-assembler.ts` — only if Phase 3 finds v15-specific assembly is needed; otherwise unchanged
- `docs/formats/ALLEGRO_BRD_FORMAT.md` — note v15 family, link to `ALLEGRO_V15_FORMAT.md`
- `CLAUDE.md` — declare v15.x support in the supported-formats block
- `docs/agents/format-maint/MEMORY.md` — update consistency matrix
- `src/frontend/src/store/board-cache.ts` — bump `PARSER_VERSION`

---

## Phase 0: Research & Sample Acquisition

**Phase goal:** Produce a `docs/formats/ALLEGRO_V15_FORMAT.md` draft detailed enough that Phase 1 implementation tasks can be made concrete. Without this, later phases are guessing. **No production code in this phase.**

### Task 0.1: Build a v15 structure dumper

**Files:**
- Create: `scripts/allegro-dump.mjs`

- [ ] **Step 1: Sketch the dumper interface**

```js
// node scripts/allegro-dump.mjs <file.brd> [--max-strings 100]
// Prints: magic (hex), family code, version string at 0xF8,
//   bytes [8..11] check, object/string counts at known offsets,
//   first N candidate strings with their byte offsets,
//   linked list pairs at expected offsets,
//   raw u32 dump from 0x00 to 0x100 with annotations
```

- [ ] **Step 2: Implement against a known-good v16 file first**

```js
import { readFileSync } from 'node:fs';

const path = process.argv[2];
const buf = readFileSync(path);
const u32 = (off) => buf.readUInt32LE(off) >>> 0;

const magic = u32(0);
const family = (magic >>> 16) & 0xFFFF;
console.log(`magic           = 0x${magic.toString(16).padStart(8, '0')}`);
console.log(`family          = 0x${family.toString(16).padStart(4, '0')} (${familyName(family)})`);
console.log(`bytes[8..11]    = 0x${u32(8).toString(16).padStart(8, '0')} (Allegro discriminator: must be 1)`);
console.log(`version string  = "${buf.subarray(0xF8, 0xF8 + 60).toString('utf8').replace(/\0+$/, '').replace(/[^\x20-\x7e]/g, '·')}"`);
// ... annotated u32 dump, candidate string scanner, etc.

function familyName(f) {
  return { 0x0012: 'v15.x', 0x0013: 'v16.x', 0x0014: 'v17.x', 0x0015: 'v18.x' }[f] ?? '?';
}
```

- [ ] **Step 3: Run against samples/allegroBRD/Quanta Z8I DA0Z8IMBAC0 Rev C (BDV) (.BRD).brd (known-good v16/v17)**

Run: `node scripts/allegro-dump.mjs "samples/allegroBRD/Quanta Z8I DA0Z8IMBAC0 Rev C (BDV) (.BRD).brd"`
Expected: clean output, version string contains "allv16" or "allv17", object count > 1000, linked-list pairs look sane.

- [ ] **Step 4: Run against the v15 canary**

Run: `node scripts/allegro-dump.mjs "samples/BROKEN/brd new set/COMPAL LA-7321P.brd"`
Expected: family `0x0012`, version string `allv15-...`, bytes[8..11]==1, object/string counts will likely be **at different offsets** than v16 — note all discrepancies in the output.

- [ ] **Step 5: Commit the dumper**

```bash
git add scripts/allegro-dump.mjs
git commit -m "tools(allegro): add structure dumper for RE work on v15"
```

### Task 0.2: Audit KiCad and OBV for v15 references

**Files:** None modified. Output is notes pasted into a draft of `docs/formats/ALLEGRO_V15_FORMAT.md`.

- [ ] **Step 1: Clone KiCad source mirror to /tmp**

```bash
git clone --depth 200 https://gitlab.com/kicad/code/kicad.git /tmp/kicad-re 2>/dev/null || true
cd /tmp/kicad-re/pcbnew/pcb_io/allegro/convert/ 2>/dev/null && ls
```

Expected: `allegro_parser.cpp`, `allegro_pcb_structs.h`, `format_from_magic.cpp` or similar.

- [ ] **Step 2: Search KiCad for v15 / 0x0012 / pre-V16 mentions**

```bash
cd /tmp/kicad-re && git grep -i 'v15\|0x0012\|pre.v16\|PRE_V16\|allv15' -- pcbnew/pcb_io/allegro/
```

Expected: zero or near-zero matches if KiCad never supported v15. Document the result either way.

- [ ] **Step 3: Search KiCad git log for any v15 attempts**

```bash
cd /tmp/kicad-re && git log --all --oneline --grep='v15\|allegro 15' -- pcbnew/pcb_io/allegro/
```

- [ ] **Step 4: Audit OpenBoardView's allegro reader**

```bash
gh repo clone OpenBoardView/OpenBoardView /tmp/obv 2>/dev/null
grep -ri 'v15\|allv15\|0x0012\|0x00120' /tmp/obv/src/Boards/ | head -30
```

- [ ] **Step 5: Write findings into a scratch note**

Create `docs/formats/ALLEGRO_V15_FORMAT.md` with sections:
- "Reference parsers consulted" (list each, with verdict: supports / does not support)
- "Magic numbers observed" (currently just `0x00120A06`)
- "Open questions" (header layout, block table, string table, linked-list ordering)

No commit yet — this doc keeps growing through Phase 0.

### Task 0.3: Expand the v15 sample corpus

**Files:** `samples/allegro-v15/` (new directory; do not commit binaries — add a README listing files and their provenance).

- [ ] **Step 1: Search the user's existing samples for any other v15 magic**

```bash
for f in $(find samples/ -iname '*.brd' -type f); do
  magic=$(xxd -l 4 -p "$f" 2>/dev/null)
  if [[ "$magic" =~ ^......12 ]]; then
    echo "v15 candidate: $f (magic: $magic)"
  fi
done
```

- [ ] **Step 2: If <3 v15 files found, escalate to user**

This is the gate: corpus must reach ≥3 files spanning ≥2 minor versions before Phase 1 proceeds. Document the count and minor versions found in `ALLEGRO_V15_FORMAT.md`. If the user can't supply more samples, **stop and reassess scope** — single-file RE will produce a parser that overfits.

- [ ] **Step 3: For each found file, run the dumper and save output alongside**

```bash
mkdir -p docs/superpowers/specs/allegro-v15-dumps/
for f in <list>; do
  node scripts/allegro-dump.mjs "$f" > "docs/superpowers/specs/allegro-v15-dumps/$(basename "$f").txt"
done
git add docs/superpowers/specs/allegro-v15-dumps/
git commit -m "docs(allegro-v15): capture structure dumps for RE corpus"
```

### Task 0.4: Validate the .cad sibling as ground-truth oracle

**Files:** None modified.

- [ ] **Step 1: Parse the .cad sibling via existing CAD parser**

```bash
cat > /tmp/cad-oracle.mjs <<'EOF'
import { parseCAD } from '/Users/besitzer/Desktop/Boardviewer/src/frontend/src/parsers/cad-parser.ts';
import { readFileSync } from 'node:fs';
const buf = readFileSync('/Users/besitzer/Desktop/Boardviewer/samples/BROKEN/brd new set/COMPAL LA-7321P.cad');
const board = parseCAD(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
console.log(`parts=${board.parts.length}, nets=${board.nets.length}, outline=${board.outline.length}`);
console.log('first 5 parts:', board.parts.slice(0, 5).map(p => p.name));
EOF
npx tsx /tmp/cad-oracle.mjs
```

Expected: meaningful counts (parts > 100, nets > 100). If parsing fails, the .cad sibling can't be used as oracle — fall back to user-supplied screenshots / Cadence Allegro export numbers.

- [ ] **Step 2: Record the oracle baseline**

Append to `ALLEGRO_V15_FORMAT.md`:
```
## Ground-truth oracle (LA-7321P)
- Parts (from .cad): <N>
- Nets (from .cad): <M>
- Outline vertices: <K>
- First 10 part refdes: …
- First 10 net names: …
```

- [ ] **Step 3: Commit**

```bash
git add docs/formats/ALLEGRO_V15_FORMAT.md
git commit -m "docs(allegro-v15): document RE corpus and ground-truth oracle"
```

### Task 0.5: Decompose the binary

**Files:** Update `docs/formats/ALLEGRO_V15_FORMAT.md` only.

This is the open-ended RE work. Use `superpowers:binary-format-reverse-engineering`. Goals:

- [ ] Identify the v15 header layout: where is the version string? Where is `objectCount`, `stringsCount`? How many u32 fields between magic and version string? (For v16+ the version string is at 0xF8; for v15 we observed the string `allv15-` starts around 0xF8 but trails into binary — confirm or correct.)
- [ ] Identify the v15 string-table format: count prefix? padding? encoding? terminator?
- [ ] Identify the v15 block-table format: same `(typeCode, key, payloadSize)` triple as v16, or different?
- [ ] Build a comparison table: v16 field layout vs v15 field layout for the first 50 fields after magic.
- [ ] If KiCad ever shipped v15 patches in any branch/fork (Step 0.2), import them as a starting point.

**Deliverable:** `ALLEGRO_V15_FORMAT.md` complete enough that a developer can write Phase 1 tasks against it without re-doing the RE.

- [ ] Commit the spec.

```bash
git add docs/formats/ALLEGRO_V15_FORMAT.md
git commit -m "docs(allegro-v15): RE-derived binary format specification"
```

---

## Phase 1: Magic & Header

### Task 1.1: Wire v15 magic codes into FmtVer

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-types.ts:14-26`

- [ ] **Step 1: Replace the V_PRE_V16 sentinel with concrete v15 enum values**

For each minor version found in the corpus, add:
```ts
export const FmtVer = {
  V_UNKNOWN: 0,
  V_152: 1,  // 0x00120200 — placeholder, replace with actual minor codes from corpus
  V_155: 2,
  V_157: 3,  // canary file is 0x00120A06 — likely V_157 family
  V_160: 4,
  V_162: 5,
  // ... existing codes shift indices accordingly
} as const;
```
**The exact mapping is dictated by Phase 0 corpus findings, not by guessing.**

- [ ] **Step 2: Update every callsite that compares against `V_PRE_V16`**

```bash
cd src/frontend && grep -rn 'V_PRE_V16' src/parsers/allegro/
```
Each match must be replaced with the correct v15-aware comparison or deleted.

- [ ] **Step 3: Typecheck**

Run: `cd src/frontend && npx tsc --noEmit -p .`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-types.ts
git commit -m "feat(allegro): add v15.x format version codes to FmtVer"
```

### Task 1.2: Add v15 cases to formatFromMagic

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-header.ts:20-50`

- [ ] **Step 1: Write a failing test**

Create `src/frontend/tests/parsers/allegro-v15-magic.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { formatFromMagic } from '../../src/parsers/allegro/allegro-header';
import { FmtVer } from '../../src/parsers/allegro/allegro-types';

test('formatFromMagic returns V_157 for 0x00120A06', () => {
  expect(formatFromMagic(0x00120A06)).toBe(FmtVer.V_157);
});
```

- [ ] **Step 2: Run test, verify FAIL**

Run: `cd src/frontend && npx playwright test allegro-v15-magic --reporter=line`
Expected: FAIL — current code throws "Unknown Allegro file version".

- [ ] **Step 3: Add v15 cases to the switch in formatFromMagic**

```ts
case 0x00120200: return FmtVer.V_152;
case 0x00120A00: return FmtVer.V_157;
// add additional minors as Phase 0 corpus reveals them
```
Remove the `if (majorVer <= 0x0012) return FmtVer.V_PRE_V16` block — v15 is now a first-class case.

- [ ] **Step 4: Run test, verify PASS**

Run: `cd src/frontend && npx playwright test allegro-v15-magic --reporter=line`
Expected: PASS.

- [ ] **Step 5: Remove the friendly error throw**

Delete the `if (ver === FmtVer.V_PRE_V16) throw …` block in `parseHeader()` ([allegro-header.ts:89-99](src/frontend/src/parsers/allegro/allegro-header.ts#L89-L99) at time of writing). Once v15 has a real path, the friendly error becomes wrong.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-header.ts src/frontend/tests/parsers/allegro-v15-magic.spec.ts
git commit -m "feat(allegro): map v15.x magic codes to FmtVer values"
```

### Task 1.3: Implement parseV15Header

**Files:**
- Create: `src/frontend/src/parsers/allegro/allegro-v15-header.ts`
- Modify: `src/frontend/src/parsers/allegro/allegro-db.ts:34` (branch on family)

- [ ] **Step 1: Write failing test for header parsing**

Create `src/frontend/tests/parsers/allegro-v15-header.spec.ts`:
```ts
import { test, expect } from '@playwright/test';
import { parseV15Header } from '../../src/parsers/allegro/allegro-v15-header';
import { AllegroStream } from '../../src/parsers/allegro/allegro-stream';
import { readFileSync } from 'node:fs';

test('parses LA-7321P header', () => {
  const buf = readFileSync('samples/BROKEN/brd new set/COMPAL LA-7321P.brd');
  const stream = new AllegroStream(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const h = parseV15Header(stream);
  expect(h.allegroVersion.startsWith('allv15')).toBe(true);
  expect(h.objectCount).toBeGreaterThan(0);
  expect(h.stringsCount).toBeGreaterThan(0);
  // exact numbers come from Phase 0 oracle
  expect(h.objectCount).toBe(<from oracle>);
  expect(h.stringsCount).toBe(<from oracle>);
});
```
**The exact numbers are filled in from Phase 0's `ALLEGRO_V15_FORMAT.md` oracle section. Do not invent them.**

- [ ] **Step 2: Run test, verify FAIL** (parseV15Header doesn't exist)

Run: `cd src/frontend && npx playwright test allegro-v15-header --reporter=line`

- [ ] **Step 3: Implement parseV15Header**

```ts
// src/frontend/src/parsers/allegro/allegro-v15-header.ts
import { AllegroStream } from './allegro-stream';
import type { FileHeader } from './allegro-types';
import { FmtVer } from './allegro-types';
import { formatFromMagic } from './allegro-header';

export function parseV15Header(stream: AllegroStream): FileHeader {
  // Layout per docs/formats/ALLEGRO_V15_FORMAT.md §"Header Layout"
  const magic = stream.u32();
  const ver = formatFromMagic(magic);
  if (ver !== FmtVer.V_152 && ver !== FmtVer.V_155 && ver !== FmtVer.V_157) {
    throw new Error(`parseV15Header called with non-v15 magic 0x${magic.toString(16)}`);
  }

  // ... fields per RE-derived spec ...
  // (concrete field-by-field from Phase 0 doc)

  return { /* FileHeader shape */ };
}
```
The exact field reads come from Phase 0's spec section; this task just transcribes them.

- [ ] **Step 4: Branch in AllegroDb constructor**

In `allegro-db.ts:30-48`:
```ts
constructor(buffer: ArrayBuffer) {
  const stream = new AllegroStream(buffer);
  const peekMagic = new DataView(buffer).getUint32(0, true);
  const family = (peekMagic >>> 16) & 0xFFFF;
  this.header = family === 0x0012
    ? parseV15Header(stream)
    : parseHeader(stream);
  // ...
}
```

- [ ] **Step 5: Run test, verify PASS**

Run: `cd src/frontend && npx playwright test allegro-v15-header --reporter=line`
Expected: PASS — counts match oracle.

- [ ] **Step 6: Commit**

```bash
git add src/frontend/src/parsers/allegro/allegro-v15-header.ts src/frontend/src/parsers/allegro/allegro-db.ts src/frontend/tests/parsers/allegro-v15-header.spec.ts
git commit -m "feat(allegro): v15 header parser"
```

---

## Phase 2: String Table

### Task 2.1: Implement v15 string-table parsing

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-db.ts` (add `parseV15StringTable` method or inline branch)
- Test: `src/frontend/tests/parsers/allegro-v15-strings.spec.ts`

- [ ] **Step 1: Write failing test**

Test asserts that the string table contains specific known strings from the .cad oracle, e.g. `expect(strings.values()).toContain('CN1001')`.

- [ ] **Step 2: Run test, verify FAIL.**

- [ ] **Step 3: Implement.** Field-by-field from Phase 0 spec.

- [ ] **Step 4: Run test, verify PASS — every refdes from oracle's first 10 parts found in the table.**

- [ ] **Step 5: Commit.**

```bash
git commit -m "feat(allegro): v15 string-table parser"
```

---

## Phase 3: Block Layer

### Task 3.1: Catalogue v15 block types

**Files:**
- Update: `docs/formats/ALLEGRO_V15_FORMAT.md` (add type-code table)

- [ ] **Step 1: Run the dumper with `--blocks` flag (extend the dumper to walk the block table)**
- [ ] **Step 2: Cross-reference each v15 type code against the v16 type code in `allegro-blocks.ts:line` constants — many are likely identical, some shifted.**
- [ ] **Step 3: Document in the spec.** Commit.

### Task 3.2: Implement v15 block parsers

**Files:**
- Create: `src/frontend/src/parsers/allegro/allegro-v15-blocks.ts`
- Test: `src/frontend/tests/parsers/allegro-v15-blocks.spec.ts`

- [ ] **Step 1: Implement parts/components blocks first** (these give immediate visual value).
- [ ] **Step 2: Test:** `expect(parts.length).toBe(oracleParts)`. Run, fix until PASS.
- [ ] **Step 3: Pins blocks. Same pattern.**
- [ ] **Step 4: Nets blocks. Same pattern.**
- [ ] **Step 5: Traces, vias, silkscreen, outline. Each its own subtask, each its own test, each its own commit.**

Granularity: one block-type-family per commit. If a block type's payload is identical to v16, delegate to the v16 parser inline rather than copy-paste.

---

## Phase 4: Assembler & Wiring

### Task 4.1: Run the existing assembler against v15 AllegroDb

**Files:**
- Modify: `src/frontend/src/parsers/allegro/allegro-assembler.ts` (only if v15 needs version-conditional assembly logic)

- [ ] **Step 1: End-to-end smoke test**

```ts
// allegro-v15-e2e.spec.ts
test('LA-7321P parses end-to-end and matches .cad oracle', () => {
  const board = parseAllegroBRD(readFileSync(canaryPath).buffer);
  expect(board.parts.length).toBe(oracleParts);
  expect(board.nets.length).toBe(oracleNets);
  expect(board.format).toBe('ALLEGRO_BRD');
});
```

- [ ] **Step 2: Run.** If the assembler chokes on v15 shapes, add version-conditional branches in `assembleBoard()`. Otherwise nothing to change here.

- [ ] **Step 3: Commit.**

### Task 4.2: Smoke-test 2+ corpus files

- [ ] **Step 1: Parametrize the e2e spec over the corpus**

```ts
for (const sample of v15Corpus) {
  test(`${sample.file} parses without throwing`, () => {
    const board = parseAllegroBRD(readFileSync(sample.path).buffer);
    expect(board.parts.length).toBeGreaterThan(0);
  });
}
```

- [ ] **Step 2: Run, fix any divergences across minor versions.** Most likely a few field-offset deltas between V_152 / V_155 / V_157.

- [ ] **Step 3: Commit.**

---

## Phase 5: Render Validation

### Task 5.1: Visual canary

**Files:** None modified (manual verification step).

- [ ] **Step 1: Start the dev server: `cd src/frontend && npm run dev`**
- [ ] **Step 2: Drag the canary file (`COMPAL LA-7321P.brd`) into the running app.**
- [ ] **Step 3: Compare the rendered board against:**
  - The .cad sibling rendered side-by-side (open both as tabs).
  - A user-supplied screenshot of the actual board (request from user before this step).

- [ ] **Step 4: If geometry is wrong, return to Phase 0 / 3 — do not patch the renderer.** Geometry bugs at this stage point at parser-output errors, not renderer issues.

- [ ] **Step 5: Use `superpowers:systematic-debugging` for any divergence.** Render PNGs of suspect parts via the format-maint debug workflow.

### Task 5.2: PARSER_VERSION bump and cache invalidation

**Files:**
- Modify: `src/frontend/src/store/board-cache.ts` (`PARSER_VERSION`)

- [ ] **Step 1: Bump.** `PARSER_VERSION = 38` (or higher if other parser-output changes have landed).

- [ ] **Step 2: Commit.**

```bash
git commit -m "feat(allegro): bump PARSER_VERSION for v15 support"
```

---

## Phase 6: Documentation & Release Prep

### Task 6.1: Update format spec docs

**Files:**
- Modify: `docs/formats/ALLEGRO_BRD_FORMAT.md` (link to V15 doc, expand version-support section)
- Modify: `CLAUDE.md` (supported-formats list: explicitly mention v15.x in the Allegro line)
- Modify: `README.md` if it lists supported versions

- [ ] One commit.

### Task 6.2: Update format-maint MEMORY.md

**Files:**
- Modify: `docs/agents/format-maint/MEMORY.md` (consistency matrix, known-issues list)

- [ ] Add v15-specific quirks (the divergences between V_152 / V_155 / V_157 noted during Phase 4, and any field-offset surprises).

### Task 6.3: Add a regression note to project memory

**Files:**
- Create: `~/.claude/projects/-Users-besitzer-Desktop-Boardviewer/memory/technical_allegro_v15.md`
- Modify: `MEMORY.md` (add pointer)

- [ ] Document: v15 is now supported; canary file is `samples/BROKEN/brd new set/COMPAL LA-7321P.brd`; the sibling `.cad` is the ground-truth oracle; if a future refactor of the v15 path ships, re-run the e2e spec across the full v15 corpus before merging.

### Task 6.4: Move the canary out of the BROKEN folder

**Files:**
- Move: `samples/BROKEN/brd new set/COMPAL LA-7321P.brd` → `samples/sorted/Apple/<…>/COMPAL_LA-7321P.brd` (or wherever it belongs by ODM pattern)

- [ ] One commit. The "BROKEN" folder name was a status not a category — once v15 parses, the file isn't broken anymore.

---

## Self-Review Checklist (run before declaring the plan complete)

- [ ] Every task names exact files (paths verified to exist or marked Create).
- [ ] Every code step shows complete code, not placeholder (acceptable exception: Phase 0 RE deliverables, where the *deliverable* is the spec doc and the spec doc dictates Phase 1 code).
- [ ] No "implement appropriate error handling" / "handle edge cases" lines.
- [ ] Type names and method signatures used in late tasks match the ones defined in early tasks.
- [ ] Phase ordering is gated: Phase 1 cannot start without Phase 0 spec doc; Phase 4 cannot start without Phases 1–3 e2e green.
- [ ] PARSER_VERSION bump appears (Task 5.2).
- [ ] Friendly-error throw added in commit `0f431ad` is removed (Task 1.2 Step 5).
- [ ] CLAUDE.md and format docs updated (Phase 6).

## Risks & Stop Conditions

- **Single-sample corpus:** if Phase 0 ends with <3 v15 files, stop and reassess. A single-file parser is overfitting and will break on the second real-world file.
- **KiCad / OBV give nothing:** likely. Plan assumes a from-scratch RE pass. If RE in Phase 0 stalls past ~2 weeks, escalate scope: either invest in more RE time or pivot to "convert via Cadence Allegro" as the documented permanent answer (option 2 from the original investigation).
- **Format too divergent:** if Phase 3 reveals v15's data model can't share the existing assembler, fork the assembler too (allegro-v15-assembler.ts). This roughly doubles Phase 4 effort — track and decide explicitly.
- **License:** the existing parser cites KiCad GPL-3.0 as source. v15 RE is independent work but should still be marked GPL-3.0-compatible (which AGPL-3.0 already is). Confirm license header on every new file matches existing Allegro files.

## Estimated Effort

- **Phase 0:** 3–8 days (research, sample acquisition, RE)
- **Phase 1:** 1–2 days
- **Phase 2:** 1 day
- **Phase 3:** 4–10 days (the bulk of the work)
- **Phase 4:** 1–2 days
- **Phase 5:** 0.5–2 days (depends on visual fidelity needed)
- **Phase 6:** 0.5 day

**Total realistic range:** 11–25 working days, *contingent on Phase 0 finding a workable layout*. If RE stalls, the project converts to "permanently document the workaround" within ~3 days of trying.
