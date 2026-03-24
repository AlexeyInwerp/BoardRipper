# Allegro BRD Full Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract pins, nets, component sides, and traces from Allegro BRD files so boards render with full detail.

**Architecture:** The C++ reference parser (brd_parser) uses pointer-based linked-list traversal from header fields — NOT sequential scanning. During the sequential scan, ALL records get stored in a key→data map. After scanning, the renderer follows pointer chains: header→x2B→x2D→x32 for components/pins, header→x1B→x04→shapes for nets. Our TS parser already scans records but stops at ~4% of the file due to variable-size record errors. Fix: complete the scan, then switch to pointer-based data extraction.

**Tech Stack:** TypeScript, Playwright tests

---

### Task 1: Complete Sequential Scan — Cover Full File

The scan currently stops at ~4% due to variable-size record handling errors. The Python parse_final.py achieved 100% coverage. Port its exact logic.

**Files:**
- Modify: `src/frontend/src/parsers/allegro-brd-parser.ts` (scanRecords function)

**Key fixes needed:**
1. x03 subtype offset for v17: subtype at offset 16 (not 12), size at offset 18 (not 14)
2. x1C for v17: layerCount at offset 44, t13 size=36, numT13=21+lc*4, then +4, then n*280+4
3. x1D for v17: add trailing +4
4. x1E for v17: add trailing +4
5. x1F for v17: use fSize*280+8 (not +4)
6. x36 for v17: header=32 (not 28), sub-sizes differ (c=2→76, c=3→64, c=6→8, c=8→52)
7. x3B for v17: fixed=180 (not 176)
8. Null gap handling: skip blocks of zeros and resume if next byte is valid type
9. Post-x27 records: after jumping, continue scanning until 0x00 or EOF

**Validation:** Count extracted records — should get 400K+ for v16.5 and 10K+ for v17.2.

### Task 2: Parse Header Linked List Pointers

Extract the 25 linked list head/tail pairs from the header. These are the entry points for pointer-based traversal.

**Files:**
- Modify: `src/frontend/src/parsers/allegro-brd-parser.ts` (parseHeader, AllegroHeader interface)

**Key fields needed:**
- `ll_x2B` (head/tail) — footprint placement list (main component iteration entry)
- `ll_x1B` (head/tail) — net list
- `ll_x04` (head/tail) — net/shape pair list

### Task 3: Pointer-Based Component/Pin Extraction

Replace current data extraction with pointer-chain traversal matching the C++ approach:
- Walk x2B linked list from header → for each x2B, follow ptr2 → x2D
- For each x2D: follow first_pad_ptr → x32 chain (via next pointer)
- Resolve: x07→refdes, x0D→pin name, x04→x1B→net name

**Files:**
- Modify: `src/frontend/src/parsers/allegro-brd-parser.ts` (assembleBoard function)

**Side detection (from C++ code):**
- `x2D.layer == 0` → top
- `x2D.layer != 0` → bottom

### Task 4: Trace Extraction

Walk net shapes from x1B → x04 → x05 line containers → x01/x15/x16/x17 line segments.

**Files:**
- Modify: `src/frontend/src/parsers/allegro-brd-parser.ts`
- Modify: `src/frontend/src/parsers/allegro-brd-format.ts` (re-enable hasTraces)

### Task 5: Tests and Validation

Update Playwright tests to verify:
- Pin counts > 0 for all three sample files
- Net counts > 0
- Both top and bottom side components exist
- Component names are valid refdes
- Pin positions are within board bounds

**Files:**
- Modify: `src/frontend/tests/allegro-brd-parser.spec.ts`
- Modify: `src/frontend/tests/allegro-render-visual.spec.ts`
